/**
 * Project discovery (ticket 06, ADR-0006): one Project per real directory, folded to the
 * repository directory by reading `.git` (a directory, or a file whose `gitdir:` pointer names
 * `<main>/.git/worktrees/<name>`); bare directories (the home directory, its ancestors, `/`)
 * are never Projects; a missing directory keeps a Project identified by its recorded path with
 * reachability `orphan`; a missing path under an unmounted volume is `unreachable`. Roots bound
 * the Projects kept and are walked for markers (depth ≤ 6, pruned, no symlink following, no
 * device crossing). No process is spawned here.
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Project, Reachability } from "../index/types.js";
import { isDirectory, listDir, lstatOrNull, readText, realpathOrSelf, statOrNull } from "./fs.js";
import { ancestors, isUnder, presenceOf, relativeUnder, type PathIdentity } from "./paths.js";

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
  platform: NodeJS.Platform;
  identity: PathIdentity;
  statDeadlineMs: number;
}

export interface Discovery {
  /** Resolves a recorded absolute path to its Project (registering it when needed). */
  locate(recordedPath: string, via: "breadcrumb" | "cwd"): Promise<Located>;
  /** Walks every Root for markers, registering the Projects they reveal. */
  walkRoots(): Promise<void>;
  /** Ticket 06 rule 8: the Project enclosing the working directory. */
  includeCwd(): Promise<void>;
  /** The Project whose members contain `path`, when already registered. */
  projectOf(path: string): DiscoveredProject | null;
  projects(): DiscoveredProject[];
  /** Whether `path` lies under one of the Roots (every path when there is none). */
  underRoots(path: string): boolean;
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
  const pointer = isAbsolute(match[1]) ? match[1] : resolve(dir, match[1]);
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
        return { name: entry.name, gitdir, path: dirname(target) };
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
        const presence = await presenceOf(
          registration.path,
          options.platform,
          options.statDeadlineMs,
          realpathOrSelf,
        );
        const reachability: Reachability =
          presence.kind === "present"
            ? "present"
            : presence.kind === "orphan"
              ? "orphan"
              : "unreachable";
        return {
          path: presence.kind === "present" ? presence.realpath : registration.path,
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

  async function locate(recordedPath: string, via: "breadcrumb" | "cwd"): Promise<Located> {
    const absolute = resolve(recordedPath);
    const presence = await presenceOf(
      absolute,
      options.platform,
      options.statDeadlineMs,
      realpathOrSelf,
    );
    if (presence.kind !== "present") {
      const reachability: Reachability = presence.kind === "orphan" ? "orphan" : "unreachable";
      const owner = registeredWorktreeOwner(absolute);
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
      // A missing subdirectory of a present repository still belongs to that repository.
      const nearest = ancestors(absolute)
        .slice(1)
        .find((dir) => registry.has(fold(dir)));
      if (nearest !== undefined) {
        const parent = registry.get(fold(nearest));
        if (parent !== undefined && parent.reachability === "present") {
          parent.discoveredBy.add(via);
          return {
            project: parent,
            relativePath: memberRelative(parent, absolute),
            reachability,
            strayReason: null,
            path: absolute,
            outsideRoots: false,
          };
        }
      }
      if (!underRoots(absolute)) {
        return {
          project: null,
          relativePath: null,
          reachability,
          strayReason: null,
          path: absolute,
          outsideRoots: true,
        };
      }
      const reason = presence.kind === "unreachable" ? presence.reason : null;
      const project = registerGone(absolute, reachability, reason, via);
      return {
        project,
        relativePath: null,
        reachability,
        strayReason: null,
        path: absolute,
        outsideRoots: false,
      };
    }
    const real = presence.realpath;
    const stats = await statOrNull(real);
    if (stats === null || !stats.isDirectory()) {
      return {
        project: null,
        relativePath: null,
        reachability: "orphan",
        strayReason: null,
        path: real,
        outsideRoots: false,
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
    if (!underRoots(classification.projectDir)) {
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

  return {
    locate,
    walkRoots,
    includeCwd,
    projectOf,
    projects: () =>
      [...registry.values()].toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    underRoots,
  };
}
