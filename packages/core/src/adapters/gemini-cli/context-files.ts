/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order and the per-Project `order` numbers depend on it */
/**
 * Context files Gemini CLI loads (research 02, Gemini context; spec §4): `~/.gemini/<name>` for
 * every name of the effective `context.fileName` in every session, then — for a session started
 * in a Project — every configured name from the nearest `context.memoryBoundaryMarkers` ancestor
 * down to the session directory, with `@` imports expanded up to five hops. Names below the
 * session directory load just in time; `context.includeDirectories[]` loads only when
 * `loadMemoryFromIncludeDirectories` is true; an untrusted folder's verdict is `unknown` (D72).
 *
 * `AGENTS.md` inside a Project is the shared-stores adapter's entity (spec §14): this adapter
 * contributes its Gemini verdict and nothing else. The entity id is deterministic, so the edge
 * finds it whichever adapter emitted the row.
 */
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ContextFile, ImportsEdge } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isFile, listDir, readText, realpathOrSelf } from "../../scan/fs.js";
import { findImports, type ImportStatement } from "../../scan/markdown.js";
import { ancestors, edgeId, isUnder, relativeUnder, tildify } from "../../scan/paths.js";
import {
  addEdge,
  addEntity,
  baseEntity,
  evidence,
  loadedBy,
  sessionDirOf,
  settingsFor,
  trustOf,
  type GeminiScan,
} from "./model.js";
import { boundaryMarkers, contextFileNames, nested, stringList } from "./settings.js";

const IMPORT_DEPTH = 5;
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

const MEMORY_SECTION = /^## Gemini Added Memories/m;

export interface ContextFacts {
  id: string;
  path: string;
  label: string;
  /** The whole file: no stripping and no cap are documented for Gemini (research 05). */
  text: string;
  imports: ImportStatement[];
  /** `null` when the file belongs to another adapter (an `AGENTS.md` inside a Project, §14). */
  entity: ContextFile | null;
}

/** §14: one `AGENTS.md` inside a Project is one entity owned by the shared-stores adapter. */
function ownsFile(path: string, project: DiscoveredProject | null): boolean {
  return !(basename(path) === "AGENTS.md" && project !== null);
}

export async function contextFileFacts(
  scan: GeminiScan,
  path: string,
  project: DiscoveredProject | null,
): Promise<ContextFacts | null> {
  const text = await readText(path);
  if (text === null) return null;
  const id = scan.ctx.id("context-file", path);
  const label = tildify(path, scan.paths.home);
  const imports = findImports(text);
  if (!ownsFile(path, project)) return { id, path, label, text, imports, entity: null };
  const base = baseEntity(scan, {
    kind: "context-file",
    path,
    scope: project === null ? "user" : "project",
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
    fileName: basename(path),
    frontmatter: {},
    importCount: imports.length,
    // D84: the legacy heading stays inside a human-owned context file; the finding points at it.
    containsMemorySection: MEMORY_SECTION.test(text),
  };
  return { id, path, label, text, imports, entity: addEntity(scan, entity) };
}

export interface Verdict {
  project: string | null;
  mode: ContextVerdictMode;
  reason: string;
  countsTowardHeadline: boolean;
  ordered: boolean;
  confidence?: "certain" | "low";
}

type ContextVerdictMode = "full" | "on-demand" | "never" | "unknown";

function resolveImportTarget(fromFile: string, target: string, home: string): string {
  if (target.startsWith("~/") || target === "~") return join(home, target.slice(2));
  if (isAbsolute(target)) return resolve(target);
  return resolve(dirname(fromFile), target);
}

/** Emits the file's verdict and follows its `@` imports (hop ≤ 5). */
export async function emitLoad(
  scan: GeminiScan,
  facts: ContextFacts,
  verdict: Verdict,
  project: DiscoveredProject | null,
  hop: number,
  visited: Set<string>,
): Promise<void> {
  visited.add(facts.id);
  const sends = verdict.mode === "full" || verdict.mode === "on-demand";
  const resolved: { target: string; path: string; line: number }[] = [];
  if (hop < IMPORT_DEPTH) {
    for (const statement of facts.imports) {
      const path = await realpathOrSelf(
        resolveImportTarget(facts.path, statement.target, scan.paths.home),
      );
      if (await isFile(path))
        resolved.push({ target: statement.target, path, line: statement.line });
    }
  }
  const count = scan.ctx.tokenizer.count(facts.text);
  loadedBy(scan, {
    from: facts.id,
    project: verdict.project,
    mode: verdict.mode,
    reason: verdict.reason,
    placement: facts.path,
    effectiveName: null,
    ordered: verdict.ordered,
    charsLoaded: sends ? facts.text.length : 0,
    importsResolved: resolved.length,
    tokensLoaded: sends ? count.o200k : 0,
    disableModelInvocation: null,
    countsTowardHeadline: verdict.countsTowardHeadline,
    ...(verdict.confidence === undefined ? {} : { confidence: verdict.confidence }),
    evidence: [evidence("loading-rule", verdict.reason)],
  });
  const fold = scan.ctx.identity.fold;
  for (const candidate of resolved) {
    const insideProject =
      project !== null &&
      project.members.some((member) => isUnder(fold(candidate.path), fold(member.path)));
    const insideHome = project === null && isUnder(fold(candidate.path), fold(scan.paths.home));
    const owner = project ?? scan.ctx.discovery.projectOf(candidate.path);
    const target = await contextFileFacts(scan, candidate.path, owner);
    if (target === null) continue;
    const edge: ImportsEdge = {
      id: edgeId("imports", facts.id, target.id),
      kind: "imports",
      from: facts.id,
      to: target.id,
      confidence: "certain",
      evidence: [evidence("import-statement", `line ${candidate.line}: @${candidate.target}`)],
      hop: hop + 1,
      external: !(insideProject || insideHome),
      syntax: "at-import",
    };
    addEdge(scan, edge);
    if (visited.has(target.id)) continue;
    await emitLoad(
      scan,
      target,
      { ...verdict, reason: `imported by ${facts.label} (hop ${hop + 1})` },
      project,
      hop + 1,
      visited,
    );
  }
}

/** Every configured name present in `dir`, in the order `context.fileName` lists them. */
async function namesIn(dir: string, names: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const name of names) {
    const path = join(dir, name);
    if (await isFile(path)) out.push(path);
  }
  return out;
}

/**
 * The chain a session started in `sessionDir` loads: upward to the nearest ancestor holding a
 * boundary marker (`.git` by default), collected root → leaf. `~/.gemini` is skipped and the walk
 * is not bounded by `$HOME` (research 02).
 */
async function chainOf(
  scan: GeminiScan,
  sessionDir: string,
  markers: readonly string[],
): Promise<string[]> {
  const fold = scan.ctx.identity.fold;
  const gemini = fold(scan.paths.geminiDir);
  const chain: string[] = [];
  for (const dir of ancestors(sessionDir)) {
    if (fold(dir) === gemini) continue;
    chain.push(dir);
    const entries = new Set((await listDir(dir)).map((entry) => entry.name));
    if (markers.some((marker) => entries.has(marker))) break;
  }
  return chain.toReversed();
}

/** Directories below `dir` (never `dir` itself), bounded, pruned, never inside a skill. */
async function nestedLevels(dir: string, depth: number): Promise<string[]> {
  if (depth >= NESTED_DEPTH) return [];
  const entries = await listDir(dir);
  const children = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .filter((entry) => !PRUNED.has(entry.name) && !entry.name.startsWith("."))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const found: string[][] = [];
  for (const entry of children) {
    const child = join(dir, entry.name);
    if ((await listDir(child)).some((item) => item.name === "SKILL.md")) continue;
    const below = await nestedLevels(child, depth + 1);
    below.unshift(child);
    found.push(below);
  }
  return found.flat();
}

/** User scope: `~/.gemini/<name>` for every configured name — the baseline of every session. */
export async function collectUserContextFiles(scan: GeminiScan): Promise<void> {
  const { names } = contextFileNames(scan.harnessSettings);
  for (const path of await namesIn(scan.paths.geminiDir, names)) {
    const facts = await contextFileFacts(scan, path, null);
    if (facts === null) continue;
    await emitLoad(
      scan,
      facts,
      {
        project: null,
        mode: "full",
        reason: "user scope: read in every session",
        countsTowardHeadline: true,
        ordered: true,
      },
      null,
      0,
      new Set(),
    );
  }
  // `context.includeDirectories[]` names extra workspace directories; without
  // `loadMemoryFromIncludeDirectories` their context files are not read (research 02).
  const includes = stringList(nested(scan.harnessSettings, "context", "includeDirectories"));
  const loads =
    nested(scan.harnessSettings, "context", "loadMemoryFromIncludeDirectories") === true;
  const markers = boundaryMarkers(scan.harnessSettings);
  for (const raw of includes) {
    const dir = resolve(raw);
    if (!scan.ctx.discovery.underRoots(dir)) continue;
    for (const level of await chainOf(scan, dir, markers)) {
      for (const path of await namesIn(level, names)) {
        const facts = await contextFileFacts(scan, path, scan.ctx.discovery.projectOf(path));
        if (facts === null) continue;
        await emitLoad(
          scan,
          facts,
          loads
            ? {
                project: null,
                mode: "full",
                reason: `include directory ${tildify(dir, scan.paths.home)}: read in every session`,
                countsTowardHeadline: true,
                ordered: true,
              }
            : {
                project: null,
                mode: "never",
                reason: "include directory: loadMemoryFromIncludeDirectories is false",
                countsTowardHeadline: false,
                ordered: false,
              },
          null,
          0,
          new Set(),
        );
      }
    }
  }
}

/** Project scope: the chain, the just-in-time subdirectories and the linked-worktree copies. */
export async function collectProjectContextFiles(
  scan: GeminiScan,
  project: DiscoveredProject,
): Promise<void> {
  if (project.reachability !== "present") return;
  const fold = scan.ctx.identity.fold;
  const settings = settingsFor(scan, project);
  const { names } = contextFileNames(settings);
  const userNames = contextFileNames(scan.harnessSettings).names;
  const markers = boundaryMarkers(settings);
  const session = sessionDirOf(scan, project);
  const untrusted = trustOf(scan, project) === false;

  const emit = async (path: string, verdict: Verdict): Promise<void> => {
    const facts = await contextFileFacts(scan, path, project);
    if (facts === null) return;
    await emitLoad(scan, facts, verdict, project, 0, new Set());
  };

  const chain = (await chainOf(scan, session.dir, markers)).filter((dir) =>
    isUnder(fold(dir), fold(session.member)),
  );
  for (const level of chain) {
    for (const path of await namesIn(level, names)) {
      if (untrusted) {
        await emit(path, {
          project: project.id,
          mode: "unknown",
          reason: "untrusted project: context loading undocumented",
          countsTowardHeadline: false,
          ordered: false,
          confidence: "low",
        });
        continue;
      }
      const where =
        fold(dirname(path)) === fold(session.dir)
          ? "session directory"
          : "ancestor of the session directory";
      await emit(path, {
        project: project.id,
        mode: "full",
        reason: `${basename(path)} of the ${where}`,
        countsTowardHeadline: true,
        ordered: true,
      });
    }
  }
  for (const dir of await nestedLevels(session.dir, 0)) {
    for (const path of await namesIn(dir, names)) {
      await emit(
        path,
        untrusted
          ? {
              project: project.id,
              mode: "unknown",
              reason: "untrusted project: context loading undocumented",
              countsTowardHeadline: false,
              ordered: false,
              confidence: "low",
            }
          : {
              project: project.id,
              mode: "on-demand",
              reason:
                "subdirectory below the session directory: loaded just-in-time when a tool touches a path there",
              countsTowardHeadline: false,
              ordered: false,
            },
      );
    }
  }
  for (const member of project.members) {
    if (member.reachability !== "present" || fold(member.path) === fold(session.member)) continue;
    const name = member.name ?? basename(member.path);
    for (const level of await chainOf(scan, member.path, markers)) {
      for (const path of await namesIn(level, names)) {
        await emit(path, {
          project: project.id,
          mode: "full",
          reason: `in linked worktree ${name}: loaded by sessions started there`,
          countsTowardHeadline: false,
          ordered: false,
        });
      }
    }
  }
  // §14: `AGENTS.md` is one file with N readers, so Gemini states its verdict even when its own
  // `context.fileName` drops the name — and a name the user tier configures but this Project's
  // effective list drops gets the same "file not read by the harness" answer (07's reason list).
  const dropped = [...new Set([...userNames, "AGENTS.md"])].filter((name) => !names.includes(name));
  if (dropped.length === 0) return;
  const reason = `file not read by the harness: context.fileName = [${names.join(", ")}]`;
  for (const level of [...chain, ...(await nestedLevels(session.dir, 0))]) {
    for (const path of await namesIn(level, dropped)) {
      await emit(path, {
        project: project.id,
        mode: "never",
        reason,
        countsTowardHeadline: false,
        ordered: false,
      });
    }
  }
}

/** A path relative to the Project, for the nested-marker index (`Project.nestedMarkers`). */
export function relativeInProject(project: DiscoveredProject, path: string): string | null {
  return relativeUnder(path, project.path);
}
