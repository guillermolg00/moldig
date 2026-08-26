/* oxlint-disable no-await-in-loop -- sequential on purpose: one member, one directory at a time keeps disk IO bounded and the emission order stable */
/**
 * `AGENTS.md`: one file, N readers (ticket 06 §14; research 02 [113]). The shared adapter owns the
 * entity — the file belongs to no harness — and every harness adapter contributes its own
 * `loaded-by` edge, because only it knows its reading rule. The entity id is deterministic
 * (`context-file:<folded path>`), which is what lets an adapter emit an edge into a file it does
 * not own and lets `scan`'s merge fold both views into one row (D38).
 *
 * One entity per `AGENTS.md` at the root of a present member of a present Project and in its
 * subdirectories (depth ≤ 6, pruned like the marker walk, never inside a directory that holds a
 * `SKILL.md` — `<store>/<skill>/AGENTS.md` is skill payload, not context). User-level variants are
 * harness-specific paths (`~/.codex/AGENTS.md`, `~/.config/opencode/AGENTS.md`) and stay with
 * their adapters; `~/.agents/AGENTS.md` (Cline) is outside v1.
 */
import { join } from "node:path";
import type { ContextFile } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { nestedProjectDirs } from "../../scan/descend.js";
import { isFile, mapConcurrent, readText, sha256 } from "../../scan/fs.js";
import { findImports, parseFrontmatter, stripBlockComments } from "../../scan/markdown.js";
import { addEntity, baseEntity, type SharedScan } from "./model.js";

export const AGENTS_FILE = "AGENTS.md";

/** Content hashes of every `AGENTS.md`, so a later pass can pair identical files. */
export const agentsMdHashes: WeakMap<ContextFile, string> = new WeakMap();

async function agentsFileEntity(
  scan: SharedScan,
  path: string,
  project: DiscoveredProject,
): Promise<void> {
  const text = await readText(path);
  if (text === null) return;
  const frontmatter = parseFrontmatter(text);
  const body = stripBlockComments(frontmatter.body);
  const base = baseEntity(scan, {
    kind: "context-file",
    path,
    scope: "project",
    project,
    ownership: "human",
    locator: { type: "file", path },
    format: "md",
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: await scan.ctx.fileMetrics(path, text),
  });
  const entity: ContextFile = {
    ...base,
    kind: "context-file",
    form: "context",
    fileName: AGENTS_FILE,
    frontmatter: frontmatter.data,
    importCount: findImports(body).length,
    containsMemorySection: /^## Gemini Added Memories/m.test(text),
  };
  agentsMdHashes.set(addEntity(scan, entity), sha256(text));
}

export async function collectAgentsFiles(scan: SharedScan): Promise<void> {
  const members = scan.ctx.discovery
    .projects()
    .filter((project) => project.reachability === "present")
    .flatMap((project) =>
      project.members
        .filter((member) => member.reachability === "present")
        .map((member) => ({ project, path: member.path })),
    );
  // Walking a member and asking whether a directory holds an `AGENTS.md` are questions for the
  // disk alone, so the members are walked through a bounded pool and every directory found is
  // asked at once. This is the first walk of every Project on the machine — the adapters that
  // follow read it from the scan's memo — and doing it one member at a time was most of what a
  // scan spent waiting (ticket 28). The entities are still emitted one at a time, in walk order.
  const dirs = await mapConcurrent(members, async (member) => [
    member.path,
    ...(await nestedProjectDirs(member.path)),
  ]);
  await mapConcurrent(dirs.flat(), (dir) => isFile(join(dir, AGENTS_FILE)));
  for (const [index, member] of members.entries()) {
    for (const dir of dirs[index] ?? []) {
      const path = join(dir, AGENTS_FILE);
      if (await isFile(path)) await agentsFileEntity(scan, path, member.project);
    }
  }
}
