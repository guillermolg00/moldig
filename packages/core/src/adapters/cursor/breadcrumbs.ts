/* oxlint-disable no-await-in-loop -- sequential on purpose: resolution order and bounded disk IO depend on it */
/**
 * Cursor's breadcrumbs (ticket 06 §1; spec §1.3): the `workspace.json` of every
 * `<app-support>/User/workspaceStorage/<id>/` (`workspace-record`), the directories of
 * `~/.cursor/projects/` (`slug-directory`, resolved through the records and the known Projects —
 * a slug is never split) and the leaves of `~/.cursor/worktrees/` (`worktree-directory`, whose
 * target is the repository their `.git` pointer names).
 *
 * The `history.recentlyOpenedPathsList` row of `globalStorage/state.vscdb` is a breadcrumb source
 * moldig lists and never reads: no database is opened by this adapter (ticket 06 §1, D104).
 */
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Breadcrumb } from "../../index/types.js";
import { warning, type ScanContext } from "../../scan/context.js";
import { unresolvedTarget, type Located, type UnresolvedTarget } from "../../scan/discovery.js";
import {
  isDirectory,
  isRecord,
  listDir,
  lstatOrNull,
  readText,
  statOrNull,
} from "../../scan/fs.js";
import { isUnder } from "../../scan/paths.js";
import { HARNESS, type CursorScan } from "./model.js";
import { cursorSlug, isTmpSlug, isWindowId, type CursorPaths } from "./paths.js";

export interface WorkspaceRecord {
  /** The md5 directory name — `Breadcrumb.refs.workspaceStorageId`. */
  id: string;
  dir: string;
  file: string;
  /** Whether `workspace.json` exists at all (a storage dir without one yields no breadcrumb). */
  hasRecord: boolean;
  raw: string | null;
  form: "folder" | "workspace" | "none";
  mtimeMs: number | null;
  /** The marker Cursor writes when it records the workspace as deleted (ticket 08). */
  obsolete: boolean;
  located: Located | null;
  unresolved: UnresolvedTarget | null;
  /** Ticket 06 rule 7: the target is a Project outside every Root — no breadcrumb, no state. */
  dropped: boolean;
}

export interface SlugResolution {
  dir: string;
  slug: string;
  located: Located | null;
  resolution: Breadcrumb["resolution"];
  recordedForm: Breadcrumb["recordedForm"];
}

export interface WorktreeLeaf {
  /** `~/.cursor/worktrees/<repo>/<id>/`. */
  dir: string;
  name: string;
  /** The repository the `gitdir:` pointer names, when the pointer has the documented shape. */
  main: string | null;
  located: Located | null;
  /** `<main>/.git/worktrees/<name>/gitdir` names this leaf: git still knows about it. */
  registered: boolean;
}

/** The decoded path of a `file:` URI, or `null` when it is not one moldig can turn into a path. */
function pathOfUri(raw: string): string | null {
  try {
    return fileURLToPath(raw);
  } catch {
    return null;
  }
}

/**
 * One `workspace-record` per storage directory (the directory, not the folder, is the record):
 * `{"folder": uri}` names a directory, `{"workspace": uri}` an untitled multi-root workspace file
 * that moldig does not open (D31) and a non-`file:` scheme a folder on another machine (D31).
 */
export async function readWorkspaceRecords(
  ctx: ScanContext,
  paths: CursorPaths,
): Promise<WorkspaceRecord[]> {
  const entries = (await listDir(paths.workspaceStorage))
    .filter((entry) => entry.isDirectory())
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const out: WorkspaceRecord[] = [];
  for (const entry of entries) {
    const dir = join(paths.workspaceStorage, entry.name);
    const file = join(dir, "workspace.json");
    const text = await readText(file);
    const stats = text === null ? null : await statOrNull(file);
    const record: WorkspaceRecord = {
      id: entry.name,
      dir,
      file,
      hasRecord: text !== null,
      raw: null,
      form: "none",
      mtimeMs: stats?.mtimeMs ?? null,
      obsolete: (await lstatOrNull(join(dir, "obsolete"))) !== null,
      located: null,
      unresolved: null,
      dropped: false,
    };
    out.push(record);
    if (text === null) continue;
    let data: unknown = null;
    try {
      data = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
      ctx.warn(
        warning("parse-error", "workspace.json is not valid JSON", HARNESS, file, "partial"),
      );
      continue;
    }
    const folder = isRecord(data) ? data["folder"] : undefined;
    const workspace = isRecord(data) ? data["workspace"] : undefined;
    if (typeof folder === "string") {
      record.form = "folder";
      record.raw = folder;
      const decoded = pathOfUri(folder);
      if (decoded === null) {
        record.unresolved = unresolvedTarget(folder);
        continue;
      }
      const located = await ctx.discovery.locate(decoded, "breadcrumb");
      if (located.outsideRoots) record.dropped = true;
      else record.located = located;
      continue;
    }
    if (typeof workspace === "string") {
      // D31: a record that names no folder is a Breadcrumb pointing at nothing — Stray, never a
      // Project; `Workspaces/<ts>/workspace.json` is not parsed for its `folders[]` in v1.
      record.form = "workspace";
      record.raw = workspace;
      record.unresolved = unresolvedTarget(workspace);
      continue;
    }
    ctx.warn(
      warning(
        "unsupported-shape",
        "workspace.json names neither a folder nor a workspace",
        HARNESS,
        file,
        "skipped",
      ),
    );
  }
  return out;
}

/**
 * Ticket 06 §6 adapted to Cursor: slug → the slug of a `workspace-record`'s path → the slug of a
 * member of a known Project → stray "unresolved slug". Slugs are compared through
 * `identity.fold`, never split; a slug naming a Project outside every Root leaves the scan.
 */
export async function resolveSlugs(
  ctx: ScanContext,
  paths: CursorPaths,
  records: readonly WorkspaceRecord[],
): Promise<SlugResolution[]> {
  const fold = ctx.identity.fold;
  const entries = (await listDir(paths.projectsDir))
    .filter((entry) => entry.isDirectory())
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const out: SlugResolution[] = [];
  for (const entry of entries) {
    const dir = join(paths.projectsDir, entry.name);
    const folded = fold(entry.name);
    const matches = records.filter(
      (record) =>
        !record.dropped &&
        record.located !== null &&
        fold(cursorSlug(record.located.path)) === folded,
    );
    const byKey =
      matches.find((record) => record.located?.reachability === "present") ?? matches[0];
    if (byKey?.located != null) {
      out.push({
        dir,
        slug: entry.name,
        located: byKey.located,
        resolution: "slug-by-key",
        recordedForm: "slug",
      });
      continue;
    }
    const known = ctx.discovery
      .projects()
      .flatMap((project) => project.members.map((member) => member.path))
      .toSorted((a, b) => a.localeCompare(b))
      .find((path) => fold(cursorSlug(path)) === folded);
    if (known !== undefined) {
      const located = await ctx.discovery.locate(known, "breadcrumb");
      // Ticket 06 rule 7: a slug naming a Project outside every Root leaves the scan with it —
      // no breadcrumb, no state.
      if (located.outsideRoots) continue;
      out.push({
        dir,
        slug: entry.name,
        located,
        resolution: "slug-by-existence",
        recordedForm: "slug",
      });
      continue;
    }
    // Nothing resolved it: only now does the name's own shape matter (a fixture tree under
    // `$TMPDIR` would otherwise make every resolvable slug look like a temporary directory).
    out.push({
      dir,
      slug: entry.name,
      located: null,
      resolution: "unresolved",
      recordedForm: isWindowId(entry.name)
        ? "window-id"
        : isTmpSlug(entry.name, ctx.options.env["TMPDIR"])
          ? "tmp"
          : "slug",
    });
  }
  return out;
}

/**
 * The repository a Cursor worktree leaf belongs to, read from its own `.git` pointer. The shared
 * `readGitEntry` answers `detached-worktree` **without** a `main` once the repository is gone, so
 * a stale leaf could not be attributed through it; the pointer's documented shape
 * (`<main>/.git/worktrees/<name>`) is parsed here instead.
 */
async function mainRepositoryOf(leaf: string): Promise<string | null> {
  const text = await readText(join(leaf, ".git"));
  const match = text === null ? null : /^gitdir:\s*(.+?)\s*$/m.exec(text);
  const pointer = match?.[1];
  if (pointer === undefined) return null;
  const gitdir = isAbsolute(pointer) ? resolve(pointer) : resolve(leaf, pointer);
  const worktrees = dirname(gitdir);
  const mainGit = dirname(worktrees);
  if (basename(worktrees) !== "worktrees" || basename(mainGit) !== ".git") return null;
  return dirname(mainGit);
}

/** Whether `<main>/.git/worktrees/<name>/gitdir` still names this leaf (the git back-link). */
async function isRegistered(
  main: string,
  name: string,
  leaf: string,
  same: (a: string, b: string) => boolean,
): Promise<boolean> {
  const text = await readText(join(main, ".git", "worktrees", name, "gitdir"));
  if (text === null) return false;
  const target = text.trim();
  return target !== "" && same(dirname(target), leaf);
}

/** One leaf per `~/.cursor/worktrees/<repo>/<id>/` holding a `.git` file (research 02 [30]). */
export async function readWorktreeLeaves(
  ctx: ScanContext,
  paths: CursorPaths,
): Promise<WorktreeLeaf[]> {
  const out: WorktreeLeaf[] = [];
  const repos = (await listDir(paths.worktreesDir))
    .filter((entry) => entry.isDirectory())
    .toSorted((a, b) => a.name.localeCompare(b.name));
  for (const repo of repos) {
    const repoDir = join(paths.worktreesDir, repo.name);
    const leaves = (await listDir(repoDir))
      .filter((entry) => entry.isDirectory())
      .toSorted((a, b) => a.name.localeCompare(b.name));
    for (const leaf of leaves) {
      const dir = join(repoDir, leaf.name);
      const main = await mainRepositoryOf(dir);
      if (main === null) {
        out.push({ dir, name: leaf.name, main: null, located: null, registered: false });
        continue;
      }
      const located = await ctx.discovery.locate(main, "breadcrumb");
      const registered =
        located.reachability === "present" &&
        (await isRegistered(main, leaf.name, dir, ctx.identity.same));
      out.push({
        dir,
        name: leaf.name,
        main,
        located: located.outsideRoots ? null : located,
        registered,
      });
    }
  }
  return out;
}

function crumb(
  scan: CursorScan,
  locatorText: string,
  kind: Breadcrumb["kind"],
  raw: string,
  recordedForm: Breadcrumb["recordedForm"],
  located: Located | UnresolvedTarget | null,
  resolution: Breadcrumb["resolution"],
  locator: Breadcrumb["locator"],
  occurrences: Breadcrumb["occurrences"],
  refs: Breadcrumb["refs"],
  state: string[],
  relativePathInProject: string | null = null,
): Breadcrumb {
  const project = located === null ? null : (located.project?.id ?? null);
  return {
    id: `breadcrumb:${HARNESS}:${scan.ctx.identity.fold(locatorText)}`,
    harness: HARNESS,
    kind,
    raw,
    recordedForm,
    path: located?.path ?? null,
    resolution,
    project,
    strayReason: located?.strayReason ?? (resolution === "unresolved" ? "unresolved-slug" : null),
    relativePathInProject:
      relativePathInProject ??
      (located !== null && "relativePath" in located ? located.relativePath : null),
    reachability: located?.reachability ?? "orphan",
    locator,
    occurrences,
    refs,
    state,
  };
}

/** Harness-owned entity ids whose path lies under `dir` — the state a breadcrumb speaks for. */
function stateUnder(scan: CursorScan, dir: string): string[] {
  const fold = scan.ctx.identity.fold;
  return [...scan.entities.values()]
    .filter((entity) => entity.ownership === "harness" && isUnder(fold(entity.path), fold(dir)))
    .map((entity) => entity.id)
    .toSorted();
}

export function collectBreadcrumbs(scan: CursorScan): void {
  for (const record of scan.records) {
    if (record.dropped || record.form === "none") continue;
    const target = record.located ?? record.unresolved;
    if (target === null) continue;
    const stamp = record.mtimeMs === null ? null : new Date(record.mtimeMs).toISOString();
    scan.breadcrumbs.push(
      crumb(
        scan,
        record.file,
        "workspace-record",
        record.raw ?? "",
        "file-uri",
        target,
        record.located === null ? "unresolved" : "direct",
        { type: "file", path: record.file },
        { count: 1, first: stamp, last: stamp },
        { workspaceStorageId: record.id },
        stateUnder(scan, record.dir),
      ),
    );
  }
  for (const slug of scan.slugs) {
    scan.breadcrumbs.push(
      crumb(
        scan,
        slug.dir,
        "slug-directory",
        slug.slug,
        slug.recordedForm,
        slug.located,
        slug.resolution,
        { type: "dir", path: slug.dir },
        { count: 1, first: null, last: null },
        {},
        stateUnder(scan, slug.dir),
      ),
    );
  }
  for (const leaf of scan.worktrees) {
    if (leaf.main !== null && leaf.located === null) continue;
    const project = leaf.located?.project ?? null;
    scan.breadcrumbs.push(
      crumb(
        scan,
        leaf.dir,
        "worktree-directory",
        leaf.dir,
        "path",
        leaf.located,
        leaf.located === null ? "unresolved" : "direct",
        { type: "dir", path: leaf.dir },
        { count: 1, first: null, last: null },
        {},
        stateUnder(scan, leaf.dir),
        project === null ? null : relative(project.path, leaf.dir).split(sep).join("/"),
      ),
    );
  }
  scan.breadcrumbs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Whether the harness wrote state of its own — `presence: "installed"` (D70). */
export async function hasHarnessState(paths: CursorPaths): Promise<boolean> {
  if ((await listDir(paths.workspaceStorage)).length > 0) return true;
  if (await isDirectory(paths.globalStorage)) return true;
  if ((await listDir(paths.projectsDir)).length > 0) return true;
  return (await listDir(paths.worktreesDir)).length > 0;
}
