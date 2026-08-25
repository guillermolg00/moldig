/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * Context files Claude Code loads (research 01 §5): `~/.claude/CLAUDE.md` and
 * `~/.claude/rules/**` in every session; then, for a session started in a Project, every
 * `CLAUDE.md` / `.claude/CLAUDE.md` / `.claude/rules/**` / `CLAUDE.local.md` from the member
 * root down to the session directory, with `@path` imports expanded up to four hops; rules
 * with `paths:` and `CLAUDE.md` files below the session directory load on demand; copies in
 * another linked worktree load only for sessions started there.
 */
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ContextFile, ImportsEdge } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isFile, listDir, readText, realpathOrSelf, sha256 } from "../../scan/fs.js";
import { findImports, parseFrontmatter, stripBlockComments } from "../../scan/markdown.js";
import { ancestors, edgeId, isUnder, relativeUnder } from "../../scan/paths.js";
import {
  addEdge,
  addEntity,
  baseEntity,
  evidence,
  loadedBy,
  sessionDirOf,
  type ClaudeScan,
} from "./model.js";

const IMPORT_DEPTH = 4;
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

export interface ContextFileFacts {
  entity: ContextFile;
  /** Block comments and frontmatter stripped: what the harness injects. */
  loadedText: string;
  imports: { line: number; target: string }[];
}

/** Content hashes of every context file, for `duplicates` edges. */
export const contentHashes: WeakMap<ContextFile, string> = new WeakMap();

type Form = ContextFile["form"];

function scopeOf(form: Form, userScope: boolean): "user" | "project" | "local" {
  if (userScope) return "user";
  return form === "local" ? "local" : "project";
}

export async function contextFileEntity(
  scan: ClaudeScan,
  path: string,
  form: Form,
  project: DiscoveredProject | null,
): Promise<ContextFileFacts | null> {
  const text = await readText(path);
  if (text === null) return null;
  const frontmatter = parseFrontmatter(text);
  const loadedText = stripBlockComments(frontmatter.body);
  const imports = findImports(loadedText);
  const base = baseEntity(scan, {
    kind: "context-file",
    path,
    scope: scopeOf(form, project === null),
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
    form,
    fileName: basename(path),
    frontmatter: frontmatter.data,
    importCount: imports.length,
    containsMemorySection: /^## Gemini Added Memories/m.test(text),
  };
  const added = addEntity(scan, entity);
  contentHashes.set(added, sha256(text));
  return { entity: added, loadedText, imports };
}

interface LoadVerdict {
  project: string | null;
  mode: "full" | "on-demand";
  reason: string;
  countsTowardHeadline: boolean;
  ordered: boolean;
}

function hasPathsScope(entity: ContextFile): boolean {
  const paths = entity.frontmatter["paths"];
  return Array.isArray(paths) ? paths.length > 0 : typeof paths === "string" && paths !== "";
}

function resolveImportTarget(fromFile: string, target: string, home: string): string {
  if (target.startsWith("~/") || target === "~") return join(home, target.slice(2));
  if (isAbsolute(target)) return resolve(target);
  return resolve(dirname(fromFile), target);
}

/** Emits the loaded-by edge of a file and follows its imports (hop ≤ 4), returning imports resolved. */
async function emitLoad(
  scan: ClaudeScan,
  facts: ContextFileFacts,
  verdict: LoadVerdict,
  project: DiscoveredProject | null,
  hop: number,
  visited: Set<string>,
): Promise<number> {
  const { entity, loadedText, imports } = facts;
  visited.add(entity.id);
  const count = scan.ctx.tokenizer.count(loadedText);
  let importsResolved = 0;
  const resolved: { target: string; path: string; line: number }[] = [];
  if (hop < IMPORT_DEPTH) {
    const candidates = await Promise.all(
      imports.map(async (statement) => {
        const path = await realpathOrSelf(
          resolveImportTarget(entity.path, statement.target, scan.paths.home),
        );
        return (await isFile(path))
          ? { target: statement.target, path, line: statement.line }
          : null;
      }),
    );
    for (const candidate of candidates) if (candidate !== null) resolved.push(candidate);
  }
  importsResolved = resolved.length;
  loadedBy(scan, {
    from: entity.id,
    project: verdict.project,
    mode: verdict.mode,
    reason: verdict.reason,
    placement: entity.path,
    effectiveName: null,
    ordered: verdict.ordered,
    charsLoaded: loadedText.length,
    importsResolved,
    tokensLoaded: count.o200k,
    disableModelInvocation: null,
    countsTowardHeadline: verdict.countsTowardHeadline,
    evidence: [evidence("loading-rule", verdict.reason)],
  });
  for (const candidate of resolved) {
    const fold = scan.ctx.identity.fold;
    const insideProject =
      project !== null &&
      project.members.some((member) => isUnder(fold(candidate.path), fold(member.path)));
    const insideHome = project === null && isUnder(fold(candidate.path), fold(scan.paths.home));
    const owner = project ?? scan.ctx.discovery.projectOf(candidate.path);
    const targetFacts = await contextFileEntity(scan, candidate.path, "context", owner);
    if (targetFacts === null) continue;
    const edge: ImportsEdge = {
      id: edgeId("imports", entity.id, targetFacts.entity.id),
      kind: "imports",
      from: entity.id,
      to: targetFacts.entity.id,
      confidence: "certain",
      evidence: [evidence("import-statement", `line ${candidate.line}: @${candidate.target}`)],
      hop: hop + 1,
      external: !(insideProject || insideHome),
      syntax: "at-import",
    };
    addEdge(scan, edge);
    if (visited.has(targetFacts.entity.id)) continue;
    await emitLoad(
      scan,
      targetFacts,
      {
        ...verdict,
        reason: `imported by ${entity.label} (hop ${hop + 1})`,
      },
      project,
      hop + 1,
      visited,
    );
  }
  return importsResolved;
}

interface LevelFile {
  path: string;
  form: Form;
}

/** `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/rules/**`, `CLAUDE.local.md` of one directory, in load order. */
async function levelFiles(dir: string): Promise<LevelFile[]> {
  const out: LevelFile[] = [];
  const candidates: LevelFile[] = [
    { path: join(dir, "CLAUDE.md"), form: "context" },
    { path: join(dir, ".claude", "CLAUDE.md"), form: "context" },
  ];
  const present = await Promise.all(
    candidates.map(async (file) => ((await isFile(file.path)) ? file : null)),
  );
  for (const file of present) if (file !== null) out.push(file);
  for (const rule of await rulesUnder(join(dir, ".claude", "rules"), 0))
    out.push({ path: rule, form: "rule" });
  if (await isFile(join(dir, "CLAUDE.local.md")))
    out.push({ path: join(dir, "CLAUDE.local.md"), form: "local" });
  return out;
}

async function rulesUnder(dir: string, depth: number): Promise<string[]> {
  if (depth > NESTED_DEPTH) return [];
  const entries = await listDir(dir);
  const nested = await Promise.all(
    entries
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map(async (entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return rulesUnder(path, depth + 1);
        return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
      }),
  );
  return nested.flat();
}

/** Context files in directories below `dir` (never `dir` itself), bounded and pruned. */
async function nestedLevels(dir: string, depth: number): Promise<string[]> {
  if (depth >= NESTED_DEPTH) return [];
  const entries = await listDir(dir);
  const children = entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .filter((entry) => !PRUNED.has(entry.name) && !entry.name.startsWith("."))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const found = await Promise.all(
    children.map(async (entry) => {
      const child = join(dir, entry.name);
      if ((await listDir(child)).some((item) => item.name === "SKILL.md")) return [];
      const below = await nestedLevels(child, depth + 1);
      below.unshift(child);
      return below;
    }),
  );
  return found.flat();
}

async function loadLevel(
  scan: ClaudeScan,
  dir: string,
  project: DiscoveredProject | null,
  verdictOf: (file: LevelFile, entity: ContextFile) => LoadVerdict,
): Promise<void> {
  for (const file of await levelFiles(dir)) {
    const facts = await contextFileEntity(scan, file.path, file.form, project);
    if (facts === null) continue;
    await emitLoad(scan, facts, verdictOf(file, facts.entity), project, 0, new Set());
  }
}

/** User scope: `~/.claude/CLAUDE.md` and `~/.claude/rules/**` — the baseline of every session. */
export async function collectUserContextFiles(scan: ClaudeScan): Promise<void> {
  const userFile = join(scan.paths.configDir, "CLAUDE.md");
  const facts = (await isFile(userFile))
    ? await contextFileEntity(scan, userFile, "context", null)
    : null;
  if (facts !== null) {
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
  for (const rule of await rulesUnder(join(scan.paths.configDir, "rules"), 0)) {
    const ruleFacts = await contextFileEntity(scan, rule, "rule", null);
    if (ruleFacts === null) continue;
    const scoped = hasPathsScope(ruleFacts.entity);
    await emitLoad(
      scan,
      ruleFacts,
      scoped
        ? {
            project: null,
            mode: "on-demand",
            reason: "paths-scoped user rule",
            countsTowardHeadline: false,
            ordered: false,
          }
        : {
            project: null,
            mode: "full",
            reason: "user rule: read in every session",
            countsTowardHeadline: true,
            ordered: true,
          },
      null,
      0,
      new Set(),
    );
  }
}

/** Project scope: the chain a session started in the Project loads, plus on-demand and worktree copies. */
export async function collectProjectContextFiles(
  scan: ClaudeScan,
  project: DiscoveredProject,
): Promise<void> {
  if (project.reachability !== "present") return;
  const fold = scan.ctx.identity.fold;
  const session = sessionDirOf(scan, project);
  const levels = ancestors(session.dir)
    .filter((dir) => isUnder(fold(dir), fold(session.member)))
    .toReversed();
  const chainVerdict = (file: LevelFile, entity: ContextFile): LoadVerdict => {
    if (file.form === "rule" && hasPathsScope(entity)) {
      return {
        project: project.id,
        mode: "on-demand",
        reason: "paths-scoped rule",
        countsTowardHeadline: false,
        ordered: false,
      };
    }
    const level = relativeUnder(
      dirname(file.form === "rule" ? dirname(dirname(file.path)) : file.path),
      session.dir,
    );
    const where =
      level === "" || level === null ? "session directory" : "ancestor of the session directory";
    const what =
      file.form === "rule" ? "rule" : file.form === "local" ? "CLAUDE.local.md" : "CLAUDE.md";
    return {
      project: project.id,
      mode: "full",
      reason: `${what} of the ${where}`,
      countsTowardHeadline: true,
      ordered: true,
    };
  };
  for (const level of levels) await loadLevel(scan, level, project, chainVerdict);

  const onDemand = (reason: string) => (): LoadVerdict => ({
    project: project.id,
    mode: "on-demand",
    reason,
    countsTowardHeadline: false,
    ordered: false,
  });
  for (const dir of await nestedLevels(session.dir, 0)) {
    await loadLevel(
      scan,
      dir,
      project,
      onDemand("subdirectory below the session directory: loaded when Claude reads files there"),
    );
  }
  for (const member of project.members) {
    if (member.reachability !== "present" || fold(member.path) === fold(session.member)) continue;
    const name = member.name ?? basename(member.path);
    await loadLevel(scan, member.path, project, (file, entity) => ({
      project: project.id,
      mode: file.form === "rule" && hasPathsScope(entity) ? "on-demand" : "full",
      reason: `in linked worktree ${name}: loaded by sessions started there`,
      countsTowardHeadline: false,
      ordered: false,
    }));
    for (const dir of await nestedLevels(member.path, 0)) {
      await loadLevel(
        scan,
        dir,
        project,
        onDemand(`subdirectory of linked worktree ${name}: loaded on demand there`),
      );
    }
  }
}
