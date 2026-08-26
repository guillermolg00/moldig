/* oxlint-disable no-await-in-loop -- sequential on purpose: the per-Project `order` numbers depend on it */
/**
 * Gemini's memory unit (ticket 08 §2, spec §5): `~/.gemini/tmp/<slug>/memory/`. Every regular
 * file below it is one `memory-file`; `MEMORY.md` is the index — D119: there is **no**
 * `memory/GEMINI.md` fallback — and every other `*.md` directly in `memory/` is a fact.
 * `memory/skills/**` is harness-written draft material and is never a Skill (fixture edge 6).
 *
 * Chats are never analysed (research 06 rule 5), so the read signal stays `none` for this
 * harness: `reads`, `writes` and `neverRead` are all `null`.
 */
import { basename, join, relative } from "node:path";
import type { ListsEdge, MemoryFile } from "../../index/types.js";
import { isRecord, listDir, readText } from "../../scan/fs.js";
import { findIndexLinks, parseFrontmatter } from "../../scan/markdown.js";
import { edgeId, isUnder } from "../../scan/paths.js";
import { addEdge, addEntity, baseEntity, evidence, loadedBy, type GeminiScan } from "./model.js";

const MAX_DEPTH = 8;

/** Every regular file below `dir`, breadth-first by name so the emitted order is stable. */
async function filesUnder(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  const entries = (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name));
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile()) out.push(path);
    else if (entry.isDirectory()) out.push(...(await filesUnder(path, depth + 1)));
  }
  return out;
}

/** Fact frontmatter in both shapes, no key required (ticket 08 §2 point 7). */
function factFrontmatter(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  const metadata = data["metadata"];
  if (isRecord(metadata)) {
    for (const [key, value] of Object.entries(metadata))
      if (out[key] === undefined) out[key] = value;
  }
  return out;
}

interface Unit {
  dir: string;
  project: string | null;
  owner: MemoryFile["owner"];
  index: { mode: "full" | "never"; reason: string; counts: boolean };
}

export async function collectMemory(scan: GeminiScan): Promise<void> {
  for (const slug of scan.slugs) {
    if (slug.store !== "tmp") continue;
    const dir = join(slug.dir, "memory");
    const files = await filesUnder(dir);
    if (files.length === 0) continue;
    const project = slug.located?.project ?? null;
    const stray = slug.located !== null && slug.located.strayReason !== null;
    await collectUnit(scan, {
      dir,
      project: project?.id ?? null,
      owner: stray && slug.located?.strayReason === "bare-directory" ? "global" : "project",
      index:
        project !== null && project.reachability !== "present"
          ? // D6: a unit behind a gone Project can never be loaded — no session starts there.
            { mode: "never", reason: "directory gone: no session can start there", counts: false }
          : project !== null
            ? {
                mode: "full",
                reason: "project memory index: loaded with the hierarchical memory",
                counts: true,
              }
            : {
                mode: "full",
                reason: `loaded only by sessions started in ${slug.located?.path ?? slug.dir}, which is not a Project`,
                counts: false,
              },
    });
  }
}

async function collectUnit(scan: GeminiScan, unit: Unit): Promise<void> {
  const fold = scan.ctx.identity.fold;
  const project =
    unit.project === null
      ? null
      : (scan.ctx.discovery.projects().find((item) => item.id === unit.project) ?? null);
  const files: MemoryFile[] = [];
  for (const path of await filesUnder(unit.dir)) {
    const text = await readText(path);
    if (text === null) continue;
    const name = basename(path);
    const direct = relative(unit.dir, path).split(/[/\\]/).length === 1;
    // D119: `MEMORY.md` is the only index name; a legacy `memory/GEMINI.md` is a fact like any other.
    const role: MemoryFile["role"] =
      direct && name === "MEMORY.md" ? "index" : direct && name.endsWith(".md") ? "fact" : "other";
    const frontmatter = parseFrontmatter(text);
    const base = baseEntity(scan, {
      kind: "memory-file",
      path,
      scope: "user",
      project,
      ownership: "harness",
      locator: { type: "file", path },
      format: name.endsWith(".md") ? "md" : "other",
      label: relative(unit.dir, path).split(/[/\\]/).join("/"),
      sensitive: false,
      protection: "none",
      removal: { method: "trash" },
      metrics: await scan.ctx.fileMetrics(path, text),
    });
    const count = scan.ctx.tokenizer.count(text);
    const entity: MemoryFile = {
      ...base,
      kind: "memory-file",
      role,
      unit: unit.dir,
      owner: unit.owner,
      frontmatter: role === "fact" ? factFrontmatter(frontmatter.data) : frontmatter.data,
      loadedPortion:
        role === "index"
          ? {
              lines: base.metrics.lines ?? 0,
              bytes: base.metrics.bytes,
              tokens: count.o200k,
              confidence: "certain",
            }
          : null,
      reads: null,
      writes: null,
      neverRead: null,
      // research 06 rule 5: Gemini chats are never analysed, so there is no signal to compute.
      readSignal: { source: "none", exact: false, bashParsed: false },
    };
    const added = addEntity(scan, entity);
    files.push(added);
    if (role === "index") {
      const sends = unit.index.mode === "full";
      loadedBy(scan, {
        from: added.id,
        project: unit.project,
        mode: unit.index.mode,
        reason: unit.index.reason,
        placement: null,
        effectiveName: null,
        ordered: unit.index.counts,
        charsLoaded: sends ? text.length : 0,
        importsResolved: null,
        tokensLoaded: sends ? count.o200k : 0,
        disableModelInvocation: null,
        countsTowardHeadline: unit.index.counts,
        evidence: [
          evidence("loading-rule", "the memory index is loaded with the hierarchical memory"),
        ],
      });
      continue;
    }
    loadedBy(scan, {
      from: added.id,
      project: unit.project,
      mode: "on-demand",
      reason:
        role === "fact"
          ? "memory fact: read on demand, never at session start"
          : "harness-written memory material: read on demand, never at session start",
      placement: null,
      effectiveName: null,
      ordered: false,
      charsLoaded: text.length,
      importsResolved: null,
      tokensLoaded: count.o200k,
      disableModelInvocation: null,
      countsTowardHeadline: false,
      evidence: [evidence("loading-rule", "only the index is loaded at session start")],
    });
  }
  const index = files.find((file) => file.role === "index");
  if (index === undefined) return;
  const text = await readText(index.path);
  if (text === null) return;
  for (const link of findIndexLinks(text)) {
    const target = files.find(
      (file) => file.role !== "index" && basename(file.path) === basename(link.target),
    );
    if (target === undefined || !isUnder(fold(target.path), fold(unit.dir))) continue;
    const edge: ListsEdge = {
      id: edgeId("lists", index.id, target.id),
      kind: "lists",
      from: index.id,
      to: target.id,
      confidence: "certain",
      evidence: [evidence("index-line", `line ${link.line}: ${link.target}`)],
    };
    addEdge(scan, edge);
  }
}
