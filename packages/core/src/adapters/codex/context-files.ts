/* oxlint-disable no-await-in-loop -- sequential on purpose: the chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * Codex's instruction chain (research 02 §Instructions, research 05 §Codex): at user scope the
 * first non-empty of `$CODEX_HOME/AGENTS.override.md` and `AGENTS.md`; per Project, one file per
 * directory from the project root down to the session directory, `AGENTS.override.md` before
 * `AGENTS.md` before each `project_doc_fallback_filenames` entry, concatenated root-first.
 *
 * D58 settles the two edges the docs leave open: the user file **counts** against
 * `project_doc_max_bytes`, and the file that would cross the cap is excluded whole rather than
 * loaded whole. Trust gates the `.codex/` layers only — an untrusted Project still reads its
 * `AGENTS.md`, so the cap of an untrusted Project comes from the user configuration.
 */
import { basename, dirname, join } from "node:path";
import type { ContextFile, ShadowsEdge } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { byteLength, listDir, readText, sha256 } from "../../scan/fs.js";
import { parseFrontmatter } from "../../scan/markdown.js";
import { ancestors, edgeId, isUnder, relativeUnder } from "../../scan/paths.js";
import {
  addEdge,
  addEntity,
  baseEntity,
  evidence,
  loadedBy,
  sessionDirOf,
  trustOf,
  type CodexScan,
} from "./model.js";
import { DEFAULT_DOC_MAX_BYTES, docMaxBytes, fallbackDocNames, rootMarkers } from "./state.js";

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

const OVERRIDE = "AGENTS.override.md";
const PRIMARY = "AGENTS.md";
const PRECEDENCE = `${OVERRIDE} > ${PRIMARY} > project_doc_fallback_filenames`;

/** Content hashes of every context file, for the `duplicates` edges of `collect`. */
export const contentHashes: WeakMap<ContextFile, string> = new WeakMap();

interface Candidate {
  path: string;
  fileName: string;
  entity: ContextFile;
  text: string;
  bytes: number;
}

/**
 * D58's cap arithmetic, on its own so it is testable without a tree: the running total starts at
 * the bytes the user instruction file already spends, and the first file that would cross the cap
 * — and every file after it — is excluded whole.
 */
export function applyChainCap(sizes: readonly number[], userBytes: number, cap: number): boolean[] {
  const out: boolean[] = [];
  let running = userBytes;
  let stopped = false;
  for (const size of sizes) {
    if (stopped || running + size > cap) {
      stopped = true;
      out.push(false);
      continue;
    }
    running += size;
    out.push(true);
  }
  return out;
}

function formOf(fileName: string): ContextFile["form"] {
  return fileName === OVERRIDE ? "local" : "context";
}

function scopeOf(fileName: string, userScope: boolean): ContextFile["scope"] {
  if (userScope) return "user";
  return fileName === OVERRIDE ? "local" : "project";
}

async function candidateOf(
  scan: CodexScan,
  path: string,
  project: DiscoveredProject | null,
): Promise<Candidate | null> {
  const text = await readText(path);
  if (text === null) return null;
  const fileName = basename(path);
  const frontmatter = parseFrontmatter(text);
  const base = baseEntity(scan, {
    kind: "context-file",
    path,
    scope: scopeOf(fileName, project === null),
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
    form: formOf(fileName),
    fileName,
    // Codex ignores frontmatter in an instruction file; it is parsed so consumers can project it.
    frontmatter: frontmatter.data,
    // Codex has no `@import` syntax: the chain is the whole graph (research 02).
    importCount: 0,
    containsMemorySection: false,
  };
  const added = addEntity(scan, entity);
  contentHashes.set(added, sha256(text));
  return { path, fileName, entity: added, text, bytes: byteLength(text) };
}

/** The instruction file names of one directory, in Codex's precedence order. */
function namesFor(scan: CodexScan): string[] {
  return [OVERRIDE, PRIMARY, ...fallbackDocNames(scan.raw)];
}

/**
 * The candidates of one directory. The winner is the first non-empty one; every other candidate
 * that exists is emitted too — a scanner shows what is on disk — and told why it does not load.
 */
async function levelOf(
  scan: CodexScan,
  dir: string,
  project: DiscoveredProject | null,
): Promise<{ winner: Candidate | null; losers: Candidate[] }> {
  const found: Candidate[] = [];
  for (const name of namesFor(scan)) {
    const candidate = await candidateOf(scan, join(dir, name), project);
    if (candidate !== null) found.push(candidate);
  }
  const winner = found.find((candidate) => candidate.bytes > 0) ?? null;
  return { winner, losers: found.filter((candidate) => candidate !== winner) };
}

function emitLoser(scan: CodexScan, loser: Candidate, winner: Candidate | null): void {
  const empty = loser.bytes === 0;
  const reason = empty
    ? "empty file: Codex skips it"
    : `${winner?.fileName ?? OVERRIDE} in the same directory wins`;
  loadedBy(scan, {
    from: loser.entity.id,
    project: loser.entity.project,
    mode: empty ? "never" : "shadowed",
    reason,
    placement: loser.path,
    effectiveName: null,
    ordered: false,
    charsLoaded: 0,
    importsResolved: null,
    tokensLoaded: 0,
    disableModelInvocation: null,
    countsTowardHeadline: false,
    evidence: [evidence(empty ? "loading-rule" : "precedence-rule", reason)],
  });
  if (empty || winner === null) return;
  const edge: ShadowsEdge = {
    id: edgeId("shadows", winner.entity.id, loser.entity.id),
    kind: "shadows",
    from: winner.entity.id,
    to: loser.entity.id,
    confidence: "certain",
    evidence: [evidence("precedence-rule", PRECEDENCE)],
    rule: PRECEDENCE,
  };
  addEdge(scan, edge);
}

function emitLoaded(
  scan: CodexScan,
  candidate: Candidate,
  project: DiscoveredProject | null,
  reason: string,
  options: { ordered: boolean; counts: boolean },
): void {
  loadedBy(scan, {
    from: candidate.entity.id,
    project: project?.id ?? null,
    mode: "full",
    reason,
    placement: candidate.path,
    effectiveName: null,
    ordered: options.ordered,
    // Codex strips nothing: the whole file goes into the prompt (research 05).
    charsLoaded: candidate.text.length,
    importsResolved: null,
    tokensLoaded: scan.ctx.tokenizer.count(candidate.text).o200k,
    disableModelInvocation: null,
    countsTowardHeadline: options.counts,
    evidence: [evidence("loading-rule", reason)],
  });
}

function emitBeyondCap(scan: CodexScan, candidate: Candidate, project: string, cap: number): void {
  const reason =
    cap === DEFAULT_DOC_MAX_BYTES
      ? "beyond 32 KiB chain"
      : `beyond project_doc_max_bytes chain (${cap} bytes)`;
  loadedBy(scan, {
    from: candidate.entity.id,
    project,
    mode: "never",
    reason,
    placement: candidate.path,
    effectiveName: null,
    ordered: false,
    charsLoaded: 0,
    importsResolved: null,
    tokensLoaded: 0,
    disableModelInvocation: null,
    countsTowardHeadline: false,
    evidence: [evidence("loading-rule", reason)],
  });
}

/** User scope: the first non-empty of `AGENTS.override.md` and `AGENTS.md`, read in every session. */
export async function collectUserContextFiles(scan: CodexScan): Promise<void> {
  const { winner, losers } = await levelOf(scan, scan.paths.dir, null);
  if (winner !== null) {
    emitLoaded(scan, winner, null, "user instructions: read in every session", {
      ordered: true,
      counts: true,
    });
    scan.userDocBytes = winner.bytes;
  }
  for (const loser of losers) emitLoser(scan, loser, winner);
}

/** `<name> of the <where>` — the phrasing the Claude slice uses for a chain position. */
function reasonFor(fileName: string, dir: string, sessionDir: string, root: string): string {
  const where =
    dir === root
      ? "the project root"
      : dir === sessionDir
        ? "the session directory"
        : "an ancestor of the session directory";
  return `${fileName} of ${where}`;
}

/**
 * The project root of the chain: the nearest ancestor of the session directory, bounded by the
 * member, holding one of `project_root_markers` — the member directory itself by default.
 */
async function projectRootOf(scan: CodexScan, member: string, sessionDir: string): Promise<string> {
  const fold = scan.ctx.identity.fold;
  const markers = rootMarkers(scan.raw);
  const chain = ancestors(sessionDir).filter((dir) => isUnder(fold(dir), fold(member)));
  for (const dir of chain) {
    const names = new Set((await listDir(dir)).map((entry) => entry.name));
    if (markers.some((marker) => names.has(marker))) return dir;
  }
  return member;
}

/** Directories below `dir` (never `dir` itself), bounded, pruned, never inside a skill directory. */
async function nestedLevels(dir: string, depth: number): Promise<string[]> {
  if (depth >= NESTED_DEPTH) return [];
  const entries = (await listDir(dir))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .filter((entry) => !PRUNED.has(entry.name) && !entry.name.startsWith("."))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const found: string[][] = [];
  for (const entry of entries) {
    const child = join(dir, entry.name);
    // A skill's payload `AGENTS.md` is part of the skill's bytes, never a context file (edge case 9).
    if ((await listDir(child)).some((item) => item.name === "SKILL.md")) continue;
    found.push([child, ...(await nestedLevels(child, depth + 1))]);
  }
  return found.flat();
}

/** Project scope: the chain root→session directory, then the directories below it. */
export async function collectProjectContextFiles(
  scan: CodexScan,
  project: DiscoveredProject,
): Promise<void> {
  if (project.reachability !== "present") return;
  const fold = scan.ctx.identity.fold;
  const session = sessionDirOf(scan, project);
  const root = await projectRootOf(scan, session.member, session.dir);
  const levels = ancestors(session.dir)
    .filter((dir) => isUnder(fold(dir), fold(root)))
    .toReversed();

  // Codex reads its own `.codex/config.toml` only in a trusted Project (research 02), so an
  // untrusted one is capped by the user value, not by the cap its own layer names.
  const facts = scan.projectFacts.get(project.id);
  const trusted = trustOf(scan, project);
  const cap = docMaxBytes(
    trusted === false ? scan.raw : { ...scan.raw, ...facts?.effectiveSettings },
  );

  const chosen: { candidate: Candidate; dir: string }[] = [];
  for (const dir of levels) {
    const { winner, losers } = await levelOf(scan, dir, project);
    if (winner !== null) chosen.push({ candidate: winner, dir });
    for (const loser of losers) emitLoser(scan, loser, winner);
  }
  const loaded = applyChainCap(
    chosen.map((item) => item.candidate.bytes),
    scan.userDocBytes,
    cap,
  );
  chosen.forEach(({ candidate, dir }, index) => {
    if (loaded[index] === true) {
      emitLoaded(scan, candidate, project, reasonFor(candidate.fileName, dir, session.dir, root), {
        ordered: true,
        counts: true,
      });
    } else {
      emitBeyondCap(scan, candidate, project.id, cap);
    }
  });

  // Below the session directory: Codex walks root→cwd once per session, so these files are read
  // only by a session started there — visible, never part of this session's chain.
  for (const dir of await nestedLevels(session.dir, 0)) {
    const { winner, losers } = await levelOf(scan, dir, project);
    for (const loser of losers) emitLoser(scan, loser, winner);
    if (winner === null) continue;
    const relative = relativeUnder(dir, session.dir) ?? dir;
    emitLoaded(
      scan,
      winner,
      project,
      `loaded by sessions started in ${relative} (Codex walks root→cwd once, no lazy loading)`,
      { ordered: false, counts: false },
    );
  }

  // Another present member of the Project is a linked worktree: its own chain, its own sessions.
  for (const member of project.members) {
    if (member.reachability !== "present" || fold(member.path) === fold(session.member)) continue;
    const name = member.name ?? basename(member.path);
    const reason = `in linked worktree ${name}: loaded by sessions started there`;
    for (const dir of [member.path, ...(await nestedLevels(member.path, 0))]) {
      const { winner, losers } = await levelOf(scan, dir, project);
      for (const loser of losers) emitLoser(scan, loser, winner);
      if (winner !== null) {
        emitLoaded(scan, winner, project, reason, { ordered: false, counts: false });
      }
    }
  }
}

/** The member (repository or worktree) a context file sits in, for the duplicates rule. */
export function memberRelativePath(scan: CodexScan, entity: ContextFile): string | null {
  const fold = scan.ctx.identity.fold;
  const project = scan.ctx.discovery.projects().find((item) => item.id === entity.project);
  if (project === undefined) return null;
  const member = project.members.find((item) => isUnder(fold(entity.path), fold(item.path)));
  return member === undefined ? null : relativeUnder(entity.path, member.path);
}

/** The directory holding a chain file, for callers that need it without re-deriving the walk. */
export function directoryOf(entity: ContextFile): string {
  return dirname(entity.path);
}
