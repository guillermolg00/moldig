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
import { isFile, listDir, readText, sha256 } from "../../scan/fs.js";
import { findImports, parseFrontmatter, stripBlockComments } from "../../scan/markdown.js";
import { addEntity, baseEntity, type SharedScan } from "./model.js";

export const AGENTS_FILE = "AGENTS.md";

const NESTED_DEPTH = 6;
const PRUNED = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "__pycache__",
  "coverage",
]);

/** Content hashes of every `AGENTS.md`, so a later pass can pair identical files. */
export const agentsMdHashes: WeakMap<ContextFile, string> = new WeakMap();

/** Directories below `dir` (never `dir` itself), bounded, pruned, and never a skill's payload. */
async function nestedDirs(dir: string, depth: number): Promise<string[]> {
  if (depth >= NESTED_DEPTH) return [];
  const entries = await listDir(dir);
  const children = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .filter((entry) => !PRUNED.has(entry.name) && !entry.name.startsWith("."))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const found: string[] = [];
  for (const entry of children) {
    const child = join(dir, entry.name);
    if ((await listDir(child)).some((item) => item.name === "SKILL.md")) continue;
    found.push(child, ...(await nestedDirs(child, depth + 1)));
  }
  return found;
}

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
  for (const project of scan.ctx.discovery.projects()) {
    if (project.reachability !== "present") continue;
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      for (const dir of [member.path, ...(await nestedDirs(member.path, 0))]) {
        const path = join(dir, AGENTS_FILE);
        if (await isFile(path)) await agentsFileEntity(scan, path, project);
      }
    }
  }
}
