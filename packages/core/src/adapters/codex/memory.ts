/* oxlint-disable no-await-in-loop -- sequential on purpose: ordered, bounded disk IO */
/**
 * Codex's memory (ticket 08 §2, research 10 §2.2): **one** global unit, `$CODEX_HOME/memories`,
 * feature-flagged by `[features] memories`. D109 puts `memories_1.sqlite` in that unit too, rather
 * than in the `database` row — the file indexes the markdown beside it. The whole unit is shown
 * and never acted on in v1: it is generated state the docs forbid editing, and the only reset,
 * `codex debug clear-memories`, is undocumented. So `protection: "never"`, `removal: none`.
 *
 * Codex publishes no read signal and no loading rule for these files, so `readSignal.source` is
 * `"none"` (no read column at all) and the verdict is `unknown` unless the flag is explicitly off.
 */
import { basename, join, relative, sep } from "node:path";
import type { ListsEdge, MemoryFile } from "../../index/types.js";
import { listDir, readText } from "../../scan/fs.js";
import { findIndexLinks, parseFrontmatter } from "../../scan/markdown.js";
import { edgeId, isUnder } from "../../scan/paths.js";
import { addEdge, addEntity, baseEntity, evidence, loadedBy, type CodexScan } from "./model.js";
import { featureFlag } from "./state.js";
import { VERSIONED_DB } from "./paths.js";

const MAX_DEPTH = 8;
const INDEX_NAMES = new Set(["MEMORY.md", "memory_summary.md"]);
/** Sub-trees whose markdown is not a fact of the unit (research 10 §2.2). */
const OTHER_DIRS = new Set(["extensions", "skills"]);
const OTHER_FILES = new Set(["phase2_workspace_diff.md"]);

interface Verdict {
  mode: "disabled" | "unknown";
  reason: string;
}

/**
 * research 10 §1.1 and §2.2: the flag decides whether the files are live, and nothing published
 * says how they enter a session. Fail closed — show them, never claim a cost.
 */
function verdictOf(scan: CodexScan): Verdict {
  const flag = featureFlag(scan.raw, "memories");
  if (flag === false) return { mode: "disabled", reason: "features.memories = false" };
  if (flag === true) {
    return {
      mode: "unknown",
      reason: "features.memories = true; Codex documents no loading rule or cap for memory files",
    };
  }
  return {
    mode: "unknown",
    reason:
      "features.memories not set in config.toml; the desktop app may enable memories on its own",
  };
}

function roleOf(unit: string, path: string): MemoryFile["role"] {
  const name = basename(path);
  const relativePath = relative(unit, path).split(sep).join("/");
  const segments = relativePath.split("/");
  const top = segments[0] ?? "";
  if (segments.length > 1 && OTHER_DIRS.has(top)) return "other";
  if (OTHER_FILES.has(name)) return "other";
  if (INDEX_NAMES.has(name)) return "index";
  if (!name.endsWith(".md")) return "other";
  // `raw_memories.md`, `rollout_summaries/*.md` and hand-named files are all facts.
  return "fact";
}

async function filesUnder(dir: string, depth: number): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  const entries = (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name));
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path, depth + 1)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

async function memoryEntity(
  scan: CodexScan,
  path: string,
  unit: string,
  role: MemoryFile["role"],
  verdict: Verdict,
  opened: boolean,
): Promise<MemoryFile | null> {
  const text = opened ? await readText(path) : null;
  if (opened && text === null) return null;
  const frontmatter = parseFrontmatter(text ?? "");
  const markdown = path.endsWith(".md");
  const base = baseEntity(scan, {
    kind: "memory-file",
    path,
    scope: "user",
    project: null,
    ownership: "harness",
    locator: { type: "file", path },
    format: markdown ? "md" : opened ? "other" : "sqlite",
    label: basename(path),
    sensitive: true,
    // Ticket 08 §2: shown, no action in v1.
    protection: "never",
    removal: { method: "none" },
    metrics: await scan.ctx.fileMetrics(path, text),
  });
  const entity: MemoryFile = {
    ...base,
    kind: "memory-file",
    role,
    unit,
    owner: "global",
    frontmatter: frontmatter.data,
    loadedPortion: null,
    reads: null,
    writes: null,
    neverRead: null,
    // No read column for Codex: nothing on disk records a read (ticket 08 §2).
    readSignal: { source: "none", exact: false, bashParsed: false },
  };
  const added = addEntity(scan, entity);
  loadedBy(scan, {
    from: added.id,
    project: null,
    mode: verdict.mode,
    reason: verdict.reason,
    placement: null,
    effectiveName: null,
    ordered: false,
    charsLoaded: null,
    importsResolved: null,
    tokensLoaded: null,
    disableModelInvocation: null,
    countsTowardHeadline: false,
    evidence: [evidence("loading-rule", verdict.reason)],
  });
  return added;
}

/** The one global memory unit: `memories/**` plus the `memories_N.sqlite` index beside it (D109). */
export async function collectMemory(scan: CodexScan): Promise<void> {
  const unit = scan.paths.memories;
  const verdict = verdictOf(scan);
  const files: MemoryFile[] = [];
  for (const path of await filesUnder(unit, 0)) {
    const entity = await memoryEntity(scan, path, unit, roleOf(unit, path), verdict, true);
    if (entity !== null) files.push(entity);
  }
  // The database that indexes them: part of the unit, never opened, never a `database` row (D109).
  for (const entry of (await listDir(scan.paths.sqliteHome)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile() || !VERSIONED_DB.test(entry.name)) continue;
    if (!entry.name.startsWith("memories_")) continue;
    await memoryEntity(
      scan,
      join(scan.paths.sqliteHome, entry.name),
      unit,
      "other",
      verdict,
      false,
    );
  }

  // `lists` edges: an index file's markdown links name the facts it indexes (ticket 07 point 13).
  const fold = scan.ctx.identity.fold;
  for (const index of files.filter((file) => file.role === "index")) {
    const text = await readText(index.path);
    if (text === null) continue;
    for (const link of findIndexLinks(text)) {
      const target = files.find(
        (file) => file.role !== "index" && basename(file.path) === basename(link.target),
      );
      if (target === undefined || !isUnder(fold(target.path), fold(unit))) continue;
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
}
