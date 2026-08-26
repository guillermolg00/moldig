/**
 * Project discovery (ticket 06, ADR-0006): one Project per real directory, folded to the
 * repository directory by reading `.git` (a directory, or a file whose `gitdir:` pointer names
 * `<main>/.git/worktrees/<name>`); bare directories (the home directory, its ancestors, `/`)
 * are never Projects; a missing directory keeps a Project identified by its recorded path with
 * reachability `orphan`; a missing path under an unmounted volume is `unreachable`. Roots bound
 * the Projects kept and are walked for markers (depth ≤ 6, pruned, no symlink following, no
 * device crossing). No process is spawned here.
 */
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { Breadcrumb, Project, Reachability, Warning } from "../index/types.js";
import { isDirectory, listDir, lstatOrNull, readText, realpathOrSelf, statOrNull } from "./fs.js";
import {
  ancestors,
  isUnder,
  pathEngine,
  presenceOf,
  relativeUnder,
  type PathIdentity,
  type ScanPlatform,
} from "./paths.js";

/**
 * A path git wrote into `.git` or `.git/worktrees/<name>/gitdir`, read back with the rules its
 * own spelling implies. git spells these with forward slashes on every platform, so on Windows
 * the file says `C:/Users/x/proj-wt/.git` while the directory it names is `C:\Users\x\proj-wt`:
 * without this the two never compare equal, and the linked worktree a user has checked out
 * comes back as a dead registration.
 */
function gitSpelling(spelling: string): string {
  return pathEngine(spelling).normalize(spelling);
}

export type StrayReason = "bare-directory" | "unresolved-slug";

export interface Member {
  path: string;
  role: "repository" | "worktree";
  name: string | null;
  gitdir: string | null;
  reachability: Reachability;
}

export interface DiscoveredProject {
  id: string;
  /** Folded identity key. */
  key: string;
  path: string;
  displayName: string;
  kind: Project["kind"];
  reachability: Reachability;
  unreachableReason: Project["unreachableReason"];
  enclosesCwd: boolean;
  discoveredBy: Set<"breadcrumb" | "marker-walk" | "cwd">;
  members: Member[];
  nestedMarkers: { relativePath: string; marker: string }[];
}

export interface Located {
  /** The Project the path folded into; `null` when stray or outside every Root. */
  project: DiscoveredProject | null;
  /** Subdirectory or worktree the path pointed at, relative to the Project's path. */
  relativePath: string | null;
  reachability: Reachability;
  strayReason: StrayReason | null;
  /** The resolved path (realpath when present, the recorded path otherwise). */
  path: string;
  /**
   * Ticket 06 rule 7: a Root narrows the scan to the Projects under it. A recorded path that
   * would name a Project (present, gone or unreachable) outside every Root is not part of
   * the scan: adapters emit neither a breadcrumb nor harness-owned state for it. Stray
   * (bare-directory) paths are user-scope state and are never outside the Roots.
   */
  outsideRoots: boolean;
}

export interface DiscoveryOptions {
  home: string;
  roots: readonly string[];
  cwd: string;
  platform: ScanPlatform;
  identity: PathIdentity;
  statDeadlineMs: number;
  /** The scan context's collector (D36): discovery emits the `stat-deadline` warning it detects. */
  warn: (warning: Warning) => void;
}

export interface Discovery {
  /** Resolves a recorded absolute path to its Project (registering it when needed). */
  locate(recordedPath: string, via: "breadcrumb" | "cwd"): Promise<Located>;
  /** Walks every Root for markers, registering the Projects they reveal. */
  walkRoots(): Promise<void>;
  /** Ticket 06 rule 8: the Project enclosing the working directory. */
  includeCwd(): Promise<void>;
  /**
   * D28: re-folds every gone path located before the Project that owns it existed, so the order
   * in which adapters, the Root walk and the cwd located paths stops mattering. Runs once, after
   * `walkRoots()` and `includeCwd()`, before the adapters collect.
   */
  refold(): Promise<void>;
  /** The Project whose members contain `path`, when already registered. */
  projectOf(path: string): DiscoveredProject | null;
  projects(): DiscoveredProject[];
  /** Whether `path` lies under one of the Roots (every path when there is none). */
  underRoots(path: string): boolean;
}

/**
 * D31: a harness record that names no folder at all (Cursor's multi-root `{"workspace": …}`
 * entry, a workspace-storage directory without `workspace.json`). The record is still a
 * Breadcrumb — it is what the harness wrote — but it points at nothing: Stray, never a Project,
 * never an Orphan finding. A record naming a remote scheme (`vscode-remote://`, `ssh://`) is
 * `unreachable` instead: the folder may well exist, just not on this machine.
 */
export interface UnresolvedTarget {
  path: null;
  project: null;
  resolution: "unresolved";
  strayReason: "unresolved-slug";
  reachability: Reachability;
  /** Whether `raw` named a non-`file:` URI scheme. */
  remote: boolean;
}

/** A URI scheme other than `file:` — the folder is somewhere moldig cannot reach (D31). */
function isRemoteUri(raw: string): boolean {
  const match = /^([A-Za-z][\w+.-]*):\/\//.exec(raw);
  return match !== null && match[1]?.toLowerCase() !== "file";
}

export function unresolvedTarget(raw: string | null): UnresolvedTarget {
  return {
    path: null,
    project: null,
    resolution: "unresolved",
    strayReason: "unresolved-slug",
    reachability: raw !== null && isRemoteUri(raw) ? "unreachable" : "orphan",
    remote: raw !== null && isRemoteUri(raw),
  };
}

/** One row of a session-cwd source before aggregation (D30). */
export interface SessionCwdRecord<TSource> {
  /** The path the row recorded, exactly as written. */
  path: string;
  /** When the row was created and last touched; either may be unknown. */
  first?: string | null;
  last?: string | null;
  /** Whatever identifies the row's origin: a session file, a row id, a table name. */
  source: TSource;
}

/** One Breadcrumb's worth of session-cwd rows (D30). */
export interface AggregatedSessionCwd<TSource> {
  /** The first spelling seen of the path (folded spellings are the same breadcrumb). */
  path: string;
  occurrences: Breadcrumb["occurrences"];
  /** The source of the newest row: what a `file` locator points at (D30). */
  newestSource: TSource;
  /** Every source that named this path, in input order. */
  sources: TSource[];
}

function earlier(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

function later(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a > b ? a : b;
}

/**
 * D30: session-cwd sources (Codex `threads.cwd`, Copilot's per-session `workspace.yaml`,
 * OpenCode `project.worktree`) emit **one Breadcrumb per distinct path** with
 * `occurrences {count, first, last}` filled — never one per row. Rows are grouped by the folded
 * path, so two spellings of one directory are one breadcrumb on darwin and win32; the result is
 * sorted by folded path, so two scans of one machine produce the same order.
 */
export function aggregateSessionCwds<TSource>(
  records: readonly SessionCwdRecord<TSource>[],
  fold: (path: string) => string,
): AggregatedSessionCwd<TSource>[] {
  const groups = new Map<
    string,
    { key: string; newest: string | null; entry: AggregatedSessionCwd<TSource> }
  >();
  for (const record of records) {
    const key = fold(record.path);
    const first = record.first ?? null;
    const last = record.last ?? null;
    // The newest row is the one whose `last` (else `first`) is the latest of the group.
    const stamp = last ?? first;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, {
        key,
        newest: stamp,
        entry: {
          path: record.path,
          occurrences: { count: 1, first, last },
          newestSource: record.source,
          sources: [record.source],
        },
      });
      continue;
    }
    const { occurrences } = existing.entry;
    if (stamp !== null && (existing.newest === null || stamp > existing.newest)) {
      existing.newest = stamp;
      existing.entry.newestSource = record.source;
    }
    occurrences.count += 1;
    occurrences.first = earlier(occurrences.first, first);
    occurrences.last = later(occurrences.last, last);
    existing.entry.sources.push(record.source);
  }
  return [...groups.values()]
    .toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((group) => group.entry);
}

/** Ticket 06 rule 7: files and directories that make a directory a Project. */
const MARKER_FILES = [
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "GEMINI.md",
  ".cursorrules",
  ".mcp.json",
  "opencode.json",
  "opencode.jsonc",
  "skills-lock.json",
];
const MARKER_DIRS = [".claude", ".cursor", ".codex", ".gemini", ".opencode", ".agents"];
const QUALIFIED_MARKERS = [
  ".github/copilot-instructions.md",
  ".github/instructions",
  ".github/skills",
  ".github/agents",
  ".github/prompts",
  ".github/mcp.json",
  ".vscode/mcp.json",
];
const PRUNED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "__pycache__",
  ".gradle",
  ".nx",
  ".expo",
  ".turbo",
  ".next",
  "coverage",
]);
const MAX_WALK_DEPTH = 6;

/** Markers present directly in `dir` (names relative to it). */
export async function markersIn(dir: string): Promise<string[]> {
  const entries = await listDir(dir);
  const names = new Set(entries.map((entry) => entry.name));
  const found: string[] = [];
  for (const file of MARKER_FILES) if (names.has(file)) found.push(file);
  for (const marker of MARKER_DIRS) if (names.has(marker)) found.push(marker);
  const qualified = await Promise.all(
    QUALIFIED_MARKERS.map(async (marker) =>
      (await lstatOrNull(join(dir, marker))) ? marker : null,
    ),
  );
  for (const marker of qualified) if (marker !== null) found.push(marker);
  return found;
}

type GitEntry =
  | { kind: "repository" }
  | { kind: "linked-worktree"; main: string; name: string; gitdir: string }
  | { kind: "detached-worktree"; gitdir: string }
  | null;

/** What `<dir>/.git` says: a repository, a linked worktree (pointer resolves) or a detached one. */
async function readGitEntry(dir: string): Promise<GitEntry> {
  const gitPath = join(dir, ".git");
  const stats = await lstatOrNull(gitPath);
  if (stats === null) return null;
  if (stats.isDirectory()) return { kind: "repository" };
  if (!stats.isFile()) return null;
  const text = await readText(gitPath);
  const match = text === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);
  if (match?.[1] === undefined) return null;
  const spelled = gitSpelling(match[1]);
  const pointer = pathEngine(spelled).isAbsolute(spelled) ? spelled : resolve(dir, spelled);
  const gitdir = await realpathOrSelf(pointer);
  const worktreesDir = dirname(gitdir);
  const mainGit = dirname(worktreesDir);
  if (basename(worktreesDir) === "worktrees" && basename(mainGit) === ".git") {
    if (await isDirectory(mainGit)) {
      return { kind: "linked-worktree", main: dirname(mainGit), name: basename(gitdir), gitdir };
    }
  }
  return { kind: "detached-worktree", gitdir };
}

interface Registration {
  name: string;
  gitdir: string;
  path: string;
}

/** `.git/worktrees/<name>/gitdir` entries of a repository (each names `<worktree>/.git`). */
async function worktreeRegistrations(repoDir: string): Promise<Registration[]> {
  const worktreesDir = join(repoDir, ".git", "worktrees");
  const entries = await listDir(worktreesDir);
  const registrations = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const gitdir = join(worktreesDir, entry.name);
        const text = await readText(join(gitdir, "gitdir"));
        if (text === null) return null;
        const target = text.trim();
        if (target === "") return null;
        const engine = pathEngine(target);
        return { name: entry.name, gitdir, path: gitSpelling(engine.dirname(target)) };
      }),
  );
  return registrations.filter((entry): entry is Registration => entry !== null);
}

interface Classification {
  /** The directory the Project is identified by (repository dir, worktree dir, or the dir itself). */
  projectDir: string;
  kind: Project["kind"];
  /** When the directory is a linked worktree: its registration data. */
  worktree: { name: string; gitdir: string; path: string } | null;
  isProject: boolean;
}

export function createDiscovery(options: DiscoveryOptions): Discovery {
  const { identity } = options;
  const fold = identity.fold;
  const registry = new Map<string, DiscoveredProject>();
  const classifications = new Map<string, Promise<Classification>>();
  /** Every gone path that registered a Project of its own — the re-fold pass revisits them (D28). */
  const gone: { located: Located; via: "breadcrumb" | "cwd" }[] = [];
  const homeFolded = fold(resolve(options.home));
  const bareDirs = new Set(ancestors(resolve(options.home)).map(fold));

  function isBare(realDir: string): boolean {
    const folded = fold(realDir);
    return bareDirs.has(folded) || folded === homeFolded;
  }

  function underRoots(path: string): boolean {
    if (options.roots.length === 0) return true;
    return options.roots.some((root) => isUnder(fold(path), fold(resolve(root))));
  }

  /**
   * Whether a Project directory is part of the scan. A Root narrows the scan to what lies under
   * it (ticket 06 rule 7) — and a Root *inside* a Project selects that Project whole (D24), so a
   * Project directory that encloses a Root is in scope too, however far above it sits.
   */
  function inScope(projectDir: string): boolean {
    if (options.roots.length === 0) return true;
    const folded = fold(projectDir);
    return options.roots.some((root) => {
      const rootFolded = fold(resolve(root));
      return isUnder(folded, rootFolded) || isUnder(rootFolded, folded);
    });
  }

  const statDeadlineWarned = new Set<string>();

  /** D36: the `stat-deadline` warning discovery already detects but never emitted. */
  function warnStatDeadline(path: string): void {
    const key = fold(path);
    if (statDeadlineWarned.has(key)) return;
    statDeadlineWarned.add(key);
    options.warn({
      code: "stat-deadline",
      message:
        `stat of ${path} passed the ${options.statDeadlineMs} ms deadline: ` +
        "the directory is reported unreachable",
      harness: null,
      path,
      effect: "partial",
    });
  }

  /** `presenceOf` plus the `stat-deadline` warning its timeout answer stands for (D36). */
  async function presence(path: string): ReturnType<typeof presenceOf> {
    const result = await presenceOf(path, options.platform, options.statDeadlineMs, realpathOrSelf);
    if (result.kind === "unreachable" && result.reason === "stat-timeout") warnStatDeadline(path);
    return result;
  }

  /** Walks up from a real directory to the nearest `.git`, folding worktrees into their main repository. */
  async function classify(realDir: string): Promise<Classification> {
    const key = fold(realDir);
    const cached = classifications.get(key);
    if (cached !== undefined) return cached;
    const promise = (async (): Promise<Classification> => {
      const chain = ancestors(realDir);
      const entries = await Promise.all(chain.map((dir) => readGitEntry(dir)));
      for (const [index, entry] of entries.entries()) {
        const dir = chain[index];
        if (entry === null || dir === undefined) continue;
        if (isBare(dir)) break;
        if (entry.kind === "repository") {
          return { projectDir: dir, kind: "repository", worktree: null, isProject: true };
        }
        if (entry.kind === "linked-worktree") {
          return {
            // oxlint-disable-next-line no-await-in-loop -- reached once: the nearest `.git` ends the walk
            projectDir: await realpathOrSelf(entry.main),
            kind: "repository",
            worktree: { name: entry.name, gitdir: entry.gitdir, path: dir },
            isProject: true,
          };
        }
        return { projectDir: dir, kind: "detached-worktree", worktree: null, isProject: true };
      }
      if (isBare(realDir))
        return { projectDir: realDir, kind: "plain-directory", worktree: null, isProject: false };
      const markers = await markersIn(realDir);
      return {
        projectDir: realDir,
        kind: "plain-directory",
        worktree: null,
        isProject: markers.length > 0,
      };
    })();
    classifications.set(key, promise);
    return promise;
  }

  async function membersOf(projectDir: string, kind: Project["kind"]): Promise<Member[]> {
    const members: Member[] = [
      { path: projectDir, role: "repository", name: null, gitdir: null, reachability: "present" },
    ];
    if (kind !== "repository") return members;
    const registrations = await worktreeRegistrations(projectDir);
    const resolved = await Promise.all(
      registrations.map(async (registration) => {
        const found = await presence(registration.path);
        const reachability: Reachability =
          found.kind === "present" ? "present" : found.kind === "orphan" ? "orphan" : "unreachable";
        return {
          path: found.kind === "present" ? found.realpath : registration.path,
          role: "worktree" as const,
          name: registration.name,
          gitdir: registration.gitdir,
          reachability,
        };
      }),
    );
    members.push(...resolved);
    return members;
  }

  async function register(
    projectDir: string,
    kind: Project["kind"],
    via: "breadcrumb" | "marker-walk" | "cwd",
  ): Promise<DiscoveredProject> {
    const key = fold(projectDir);
    const existing = registry.get(key);
    if (existing !== undefined) {
      existing.discoveredBy.add(via);
      return existing;
    }
    const project: DiscoveredProject = {
      id: `project:${key}`,
      key,
      path: projectDir,
      displayName: basename(projectDir) || projectDir,
      kind,
      reachability: "present",
      unreachableReason: null,
      enclosesCwd: false,
      discoveredBy: new Set([via]),
      members: await membersOf(projectDir, kind),
      nestedMarkers: [],
    };
    registry.set(key, project);
    return project;
  }

  function registerGone(
    recordedPath: string,
    reachability: "orphan" | "unreachable",
    reason: Project["unreachableReason"],
    via: "breadcrumb" | "cwd",
  ): DiscoveredProject {
    const key = fold(recordedPath);
    const existing = registry.get(key);
    if (existing !== undefined) {
      existing.discoveredBy.add(via);
      return existing;
    }
    const project: DiscoveredProject = {
      id: `project:${key}`,
      key,
      path: recordedPath,
      displayName: basename(recordedPath) || recordedPath,
      kind: "unknown",
      reachability,
      unreachableReason: reason,
      enclosesCwd: false,
      discoveredBy: new Set([via]),
      members: [],
      nestedMarkers: [],
    };
    registry.set(key, project);
    return project;
  }

  function projectOf(path: string): DiscoveredProject | null {
    const folded = fold(path);
    for (const project of registry.values()) {
      for (const member of project.members) {
        if (isUnder(folded, fold(member.path))) return project;
      }
    }
    return null;
  }

  /** Subdirectory or worktree a path pointed at, relative to the Project's path (`../wt` for a worktree). */
  function memberRelative(project: DiscoveredProject, path: string): string | null {
    if (fold(path) === fold(project.path)) return null;
    return relative(project.path, path).split(sep).join("/");
  }

  /** Ticket 06 rule 18: a ghost path matching a registered worktree folds into that Project. */
  function registeredWorktreeOwner(recordedPath: string): DiscoveredProject | null {
    const folded = fold(recordedPath);
    for (const project of registry.values()) {
      if (
        project.members.some((member) => member.role === "worktree" && fold(member.path) === folded)
      ) {
        return project;
      }
    }
    return null;
  }

  /** The present Project a gone path folds into: a registered worktree, else a live ancestor. */
  function ownerOfGone(absolute: string): DiscoveredProject | null {
    const owner = registeredWorktreeOwner(absolute);
    if (owner !== null) return owner;
    // A missing subdirectory of a present repository still belongs to that repository.
    for (const dir of ancestors(absolute).slice(1)) {
      const candidate = registry.get(fold(dir));
      if (candidate !== undefined && candidate.reachability === "present") return candidate;
    }
    return null;
  }

  async function locate(recordedPath: string, via: "breadcrumb" | "cwd"): Promise<Located> {
    const absolute = resolve(recordedPath);
    const found = await presence(absolute);
    if (found.kind !== "present") {
      const reachability: Reachability = found.kind === "orphan" ? "orphan" : "unreachable";
      const owner = ownerOfGone(absolute);
      if (owner !== null) {
        owner.discoveredBy.add(via);
        return {
          project: owner,
          relativePath: memberRelative(owner, absolute),
          reachability,
          strayReason: null,
          path: absolute,
          outsideRoots: false,
        };
      }
      if (!inScope(absolute)) {
        return {
          project: null,
          relativePath: null,
          reachability,
          strayReason: null,
          path: absolute,
          outsideRoots: true,
        };
      }
      const reason = found.kind === "unreachable" ? found.reason : null;
      const project = registerGone(absolute, reachability, reason, via);
      const located: Located = {
        project,
        relativePath: null,
        reachability,
        strayReason: null,
        path: absolute,
        outsideRoots: false,
      };
      // D28: keep it, so a Project registered later by the walk still claims it.
      gone.push({ located, via });
      return located;
    }
    const real = found.realpath;
    const stats = await statOrNull(real);
    if (stats !== null && !stats.isDirectory()) {
      // D32: a breadcrumb naming a file (a VS Code `fileUri`) folds through its parent directory
      // and keeps the file path; a present file is never `orphan` — Orphan means the target is gone.
      const parent = await locate(dirname(real), via);
      return {
        project: parent.project,
        relativePath: parent.project === null ? null : memberRelative(parent.project, real),
        reachability: "present",
        strayReason: parent.project === null && !parent.outsideRoots ? "bare-directory" : null,
        path: real,
        outsideRoots: parent.outsideRoots,
      };
    }
    const classification = await classify(real);
    if (!classification.isProject) {
      return {
        project: null,
        relativePath: null,
        reachability: "present",
        strayReason: "bare-directory",
        path: real,
        outsideRoots: false,
      };
    }
    if (!inScope(classification.projectDir)) {
      return {
        project: null,
        relativePath: null,
        reachability: "present",
        strayReason: null,
        path: real,
        outsideRoots: true,
      };
    }
    const project = await register(classification.projectDir, classification.kind, via);
    if (classification.worktree !== null) {
      const { worktree } = classification;
      if (!project.members.some((member) => fold(member.path) === fold(worktree.path))) {
        project.members.push({
          path: worktree.path,
          role: "worktree",
          name: worktree.name,
          gitdir: worktree.gitdir,
          reachability: "present",
        });
      }
    }
    return {
      project,
      relativePath: memberRelative(project, real),
      reachability: "present",
      strayReason: null,
      path: real,
      outsideRoots: false,
    };
  }

  async function walkDir(dir: string, depth: number, device: number): Promise<void> {
    if (depth > MAX_WALK_DEPTH) return;
    const stats = await statOrNull(dir);
    if (stats === null || !stats.isDirectory() || stats.dev !== device) return;
    const entries = await listDir(dir);
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has("SKILL.md")) return;
    const markers = await markersIn(dir);
    if (markers.length > 0 && !isBare(dir)) {
      const classification = await classify(dir);
      const project = await register(classification.projectDir, classification.kind, "marker-walk");
      if (fold(classification.projectDir) !== fold(dir) && classification.worktree === null) {
        const relativeDir = relativeUnder(dir, project.path);
        for (const marker of markers) {
          project.nestedMarkers.push({
            relativePath:
              relativeDir === null || relativeDir === "" ? marker : `${relativeDir}/${marker}`,
            marker,
          });
        }
      } else if (classification.worktree !== null) {
        if (!project.members.some((member) => fold(member.path) === fold(dir))) {
          project.members.push({
            path: dir,
            role: "worktree",
            name: classification.worktree.name,
            gitdir: classification.worktree.gitdir,
            reachability: "present",
          });
        }
      }
    }
    await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .filter((entry) => !PRUNED_DIRS.has(entry.name) && !entry.name.startsWith("."))
        .map((entry) => walkDir(join(dir, entry.name), depth + 1, device)),
    );
  }

  async function walkRoots(): Promise<void> {
    await Promise.all(
      options.roots.map(async (root) => {
        const real = await realpathOrSelf(resolve(root));
        const stats = await statOrNull(real);
        if (stats === null || !stats.isDirectory()) return;
        await walkDir(real, 0, stats.dev);
      }),
    );
  }

  async function includeCwd(): Promise<void> {
    const located = await locate(options.cwd, "cwd");
    const target = located.project ?? projectOf(located.path);
    if (target !== null) target.enclosesCwd = true;
  }

  /**
   * D28: a gone path located before the Project that owns it was registered became a gone Project
   * of its own. Now that the Root walk and the cwd have run, every one of them is offered its
   * owner again; the `Located` the adapter is holding is updated in place and the gone Project it
   * created disappears when nothing points at it any more. Locating order stops mattering.
   */
  function refold(): Promise<void> {
    const claimed = new Map<string, number>();
    for (const { located } of gone) {
      if (located.project === null) continue;
      claimed.set(located.project.key, (claimed.get(located.project.key) ?? 0) + 1);
    }
    for (const entry of gone) {
      const { located } = entry;
      const stale = located.project;
      if (stale === null) continue;
      const owner = ownerOfGone(located.path);
      if (owner === null || owner.key === stale.key) continue;
      owner.discoveredBy.add(entry.via);
      if (stale.enclosesCwd) owner.enclosesCwd = true;
      located.project = owner;
      located.relativePath = memberRelative(owner, located.path);
      const left = (claimed.get(stale.key) ?? 1) - 1;
      claimed.set(stale.key, left);
      if (left === 0) registry.delete(stale.key);
    }
    return Promise.resolve();
  }

  return {
    locate,
    walkRoots,
    includeCwd,
    refold,
    projectOf,
    projects: () =>
      [...registry.values()].toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    underRoots,
  };
}
