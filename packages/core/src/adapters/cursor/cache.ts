/* oxlint-disable no-await-in-loop -- sequential on purpose: emission order and bounded disk IO depend on it */
/**
 * Cursor's harness cache units, exactly as ticket 08 §1 lists them: the worktrees Cursor sweeps
 * by count, one `workspace` unit per `workspaceStorage/<id>/`, the `logs/<ts>/` directories, the
 * databases moldig never opens, the `mcp.json.backup*` clones, `~/.cursor/plans/`,
 * `~/.cursor/projects/<slug>/` and every other name the docs leave undocumented, so that "moldig
 * shows N GB under `~/.cursor`" stays true.
 *
 * Nothing here is ever preselected: no unit is `rule: "swept"` with a `retention.days` (ticket 08).
 * `state.vscdb` and its backup are `rule: "kept"` + `protection: "never"` + `removal: none` (D104)
 * and are opened by nothing in this adapter; a `workspaceStorage/<id>/` directory always holds one
 * of those databases, so the whole directory is size-only (D117): moldig shows the megabytes and
 * offers no checkbox over a file it promised never to touch.
 */
import { basename, join } from "node:path";
import type { HarnessCache } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import {
  ageDays,
  isDirectory,
  listDir,
  lstatOrNull,
  toIso,
  treeStats,
  type TreeStats,
} from "../../scan/fs.js";
import { formatOf } from "../../scan/context.js";
import { addEntity, baseEntity, HARNESS, type CursorScan } from "./model.js";

const ACTIVITY_WINDOW_MS = 60 * 60 * 1000;

const NO_RETENTION: HarnessCache["retention"] = {
  days: null,
  bytes: null,
  count: null,
  source: null,
};

/** Names of `~/.cursor` this adapter classifies; everything else is a size-only row. */
const CONFIG_CLASSIFIED = new Set([
  "mcp.json",
  "cli-config.json",
  "argv.json",
  "ide_state.json",
  "hooks.json",
  "permissions.json",
  "rules",
  "skills",
  "skills-cursor",
  "agents",
  "commands",
  "plans",
  "projects",
  "worktrees",
]);

/** Names of the app-support directory and of its `User/` this adapter classifies. */
const APP_SUPPORT_CLASSIFIED = new Set(["User", "logs"]);
const USER_CLASSIFIED = new Set([
  "workspaceStorage",
  "globalStorage",
  // Editor preferences: `settings.json` is a settings-file, the other two are neither read nor
  // listed (research 02 §macOS app state).
  "settings.json",
  "keybindings.json",
  "snippets",
]);

export interface UnitInput {
  paths: string[];
  /** Sub-trees that are units of their own, subtracted so no byte is counted twice. */
  exclude?: string[];
  cacheKind: string;
  unit: HarnessCache["unit"];
  project: DiscoveredProject | null;
  slug?: string | null;
  rule: HarnessCache["rule"];
  retention?: HarnessCache["retention"];
  liveGuard: HarnessCache["liveGuard"] | "recent-activity";
  userContent: boolean;
  protection: HarnessCache["protection"];
  removal: HarnessCache["removal"];
  sensitive: boolean;
  /** `"ide"` for the app-support tree and the worktrees; `null` where no source says (07 §8). */
  surface?: string | null;
  label?: string;
}

/**
 * `treeStats` with a set of sub-trees left out — the bytes **and** the timestamps: a unit's age is
 * its newest member (ticket 07/08), and a member that belongs to another unit is not one of them.
 */
async function statsExcept(
  path: string,
  excluded: Set<string>,
  fold: (path: string) => string,
  depth = 0,
): Promise<TreeStats> {
  const empty: TreeStats = { files: 0, bytes: 0, oldestMs: null, newestMs: null };
  if (excluded.has(fold(path)) || depth > 32) return empty;
  const stats = await lstatOrNull(path);
  if (stats === null) return empty;
  if (!stats.isDirectory()) return treeStats(path);
  const children = await Promise.all(
    (await listDir(path)).map((entry) =>
      statsExcept(join(path, entry.name), excluded, fold, depth + 1),
    ),
  );
  return children.reduce((sum, item) => combine(sum, item), empty);
}

function combine(a: TreeStats, b: TreeStats): TreeStats {
  return {
    files: a.files + b.files,
    bytes: a.bytes + b.bytes,
    oldestMs:
      a.oldestMs === null
        ? b.oldestMs
        : b.oldestMs === null
          ? a.oldestMs
          : Math.min(a.oldestMs, b.oldestMs),
    newestMs:
      a.newestMs === null
        ? b.newestMs
        : b.newestMs === null
          ? a.newestMs
          : Math.max(a.newestMs, b.newestMs),
  };
}

export async function cacheEntity(
  scan: CursorScan,
  input: UnitInput,
): Promise<HarnessCache | null> {
  const anchor = input.paths[0];
  if (anchor === undefined) return null;
  const fold = scan.ctx.identity.fold;
  const excluded = new Set((input.exclude ?? []).map((path) => fold(path)));
  const stats = await Promise.all(
    input.paths.map((path) =>
      excluded.size === 0 ? treeStats(path) : statsExcept(path, excluded, fold),
    ),
  );
  const files = stats.reduce((sum, item) => sum + item.files, 0);
  const bytes = stats.reduce((sum, item) => sum + item.bytes, 0);
  const oldest = stats.reduce<number | null>(
    (min, item) =>
      item.oldestMs === null ? min : min === null ? item.oldestMs : Math.min(min, item.oldestMs),
    null,
  );
  const newest = stats.reduce<number | null>(
    (max, item) =>
      item.newestMs === null ? max : max === null ? item.newestMs : Math.max(max, item.newestMs),
    null,
  );
  const liveGuard: HarnessCache["liveGuard"] =
    input.liveGuard === "recent-activity"
      ? {
          kind: "recent-activity",
          alive: newest !== null && scan.ctx.options.now.getTime() - newest < ACTIVITY_WINDOW_MS,
        }
      : input.liveGuard;
  const locator: HarnessCache["locator"] =
    input.paths.length > 1
      ? { type: "paths", paths: input.paths }
      : input.unit === "dir"
        ? { type: "dir", path: anchor }
        : { type: "file", path: anchor };
  const surface = input.surface ?? null;
  const base = baseEntity(scan, {
    kind: "harness-cache",
    path: anchor,
    scope: "user",
    project: input.project,
    ownership: "harness",
    locator,
    format: input.unit === "dir" ? "dir" : formatOf(anchor),
    label: input.label ?? basename(anchor),
    sensitive: input.sensitive,
    protection: input.protection,
    removal: input.removal,
    producer: surface === null ? null : { harness: HARNESS, surface },
    metrics: {
      bytes,
      files,
      lines: null,
      mtime: newest === null ? null : toIso(newest),
      ageDays: newest === null ? null : ageDays(newest, scan.ctx.options.now),
      tokens: null,
      lastUsed: null,
    },
  });
  const entity: HarnessCache = {
    ...base,
    kind: "harness-cache",
    cacheKind: input.cacheKind,
    unit: input.unit,
    surface,
    session: null,
    slug: input.slug ?? null,
    rule: input.rule,
    retention: input.retention ?? NO_RETENTION,
    liveGuard,
    // D122: a `protection: "undocumented"` row never carries `userContent` — the flag is
    // unreachable on a row with no checkbox (ticket 08 marks `~/.cursor/plans/` as user content;
    // it stays visible as a size-only row instead).
    userContent: input.protection === "undocumented" ? false : input.userContent,
    members: {
      files,
      bytes,
      oldest: oldest === null ? null : toIso(oldest),
      newest: newest === null ? null : toIso(newest),
    },
  };
  return addEntity(scan, entity);
}

/** One size-only row per unclassified entry, so the harness total stays true (ticket 08). */
async function sizeOnly(
  scan: CursorScan,
  path: string,
  surface: string | null,
  sensitive = false,
): Promise<void> {
  await cacheEntity(scan, {
    paths: [path],
    cacheKind: "undocumented",
    unit: (await isDirectory(path)) ? "dir" : "file",
    project: null,
    rule: "undocumented",
    liveGuard: null,
    userContent: false,
    protection: "undocumented",
    removal: { method: "none" },
    sensitive,
    surface,
  });
}

async function collectAppSupport(scan: CursorScan): Promise<void> {
  const { appSupport, userDir, globalStorage, logsDir } = scan.paths;

  for (const record of scan.records) {
    if (record.dropped) continue;
    const hints: string[] = [];
    if (!record.hasRecord) hints.push("no workspace.json");
    // Ticket 08: the marker Cursor writes when it records the workspace as deleted.
    if (record.obsolete) hints.push("Cursor marked this workspace deleted");
    await cacheEntity(scan, {
      paths: [record.dir],
      cacheKind: "workspace",
      unit: "dir",
      project: record.located?.project ?? null,
      rule: "undocumented",
      liveGuard: null,
      userContent: false,
      // D117: the directory always holds a `protection: never` database — size-only, no checkbox.
      protection: "undocumented",
      removal: { method: "none" },
      sensitive: true,
      surface: "ide",
      label: [record.id.slice(0, 8), ...hints].join(" · "),
    });
  }

  // The databases: listed, sized, never opened (ticket 06 §1; D104).
  const main = join(globalStorage, "state.vscdb");
  const sidecars = [`${main}-wal`, `${main}-shm`];
  for (const [path, members] of [
    [main, [main, ...sidecars]],
    [join(globalStorage, "state.vscdb.backup"), [join(globalStorage, "state.vscdb.backup")]],
  ] as [string, string[]][]) {
    if ((await treeStats(path)).files === 0) continue;
    await cacheEntity(scan, {
      paths: members,
      cacheKind: "database",
      unit: "database",
      project: null,
      // D104: `HarnessCache.rule` has no `never` member — "never" is what `protection` says.
      rule: "kept",
      liveGuard: null,
      userContent: false,
      protection: "never",
      removal: { method: "none" },
      sensitive: true,
      surface: "ide",
      label: basename(path),
    });
  }
  const globalKnown = new Set([
    "state.vscdb",
    "state.vscdb-wal",
    "state.vscdb-shm",
    "state.vscdb.backup",
    "storage.json",
  ]);
  for (const entry of (await listDir(globalStorage)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (globalKnown.has(entry.name)) continue;
    await sizeOnly(scan, join(globalStorage, entry.name), "ide");
  }

  // `logs/<yyyymmddThhmmss>/`: upstream VS Code keeps the 10 newest; Cursor's fork is unverified,
  // so the rule fails closed to `undocumented` (ticket 08).
  for (const entry of (await listDir(logsDir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    await cacheEntity(scan, {
      paths: [join(logsDir, entry.name)],
      cacheKind: "log",
      unit: "dir",
      project: null,
      rule: "undocumented",
      liveGuard: "recent-activity",
      userContent: false,
      protection: "none",
      removal: { method: "trash" },
      sensitive: false,
      surface: "ide",
    });
  }

  for (const entry of (await listDir(appSupport)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (APP_SUPPORT_CLASSIFIED.has(entry.name)) continue;
    await sizeOnly(scan, join(appSupport, entry.name), "ide");
  }
  for (const entry of (await listDir(userDir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (USER_CLASSIFIED.has(entry.name)) continue;
    // `User/History/` is the editor's local file history: the file bodies are the user's own.
    await sizeOnly(scan, join(userDir, entry.name), "ide", entry.name === "History");
  }
}

async function collectConfigDir(scan: CursorScan): Promise<void> {
  const { configDir, plansDir } = scan.paths;

  // `~/.cursor/projects/<slug>/`: transcripts and side state, size-only. D126: the MCP cache
  // inside it is its own `mcp-cache` unit — stat only, never opened.
  for (const slug of scan.slugs) {
    const mcpDirs = [join(slug.dir, "mcps"), join(slug.dir, "mcp-cache.json")];
    const present: string[] = [];
    for (const path of mcpDirs) if ((await treeStats(path)).files > 0) present.push(path);
    await cacheEntity(scan, {
      paths: [slug.dir],
      exclude: present,
      cacheKind: "undocumented",
      unit: "dir",
      project: slug.located?.project ?? null,
      slug: slug.slug,
      rule: "undocumented",
      liveGuard: null,
      userContent: false,
      protection: "undocumented",
      removal: { method: "none" },
      sensitive: true,
    });
    for (const path of present) {
      await cacheEntity(scan, {
        paths: [path],
        cacheKind: "mcp-cache",
        unit: (await isDirectory(path)) ? "dir" : "file",
        project: slug.located?.project ?? null,
        slug: slug.slug,
        rule: "undocumented",
        liveGuard: null,
        userContent: false,
        protection: "undocumented",
        removal: { method: "none" },
        sensitive: true,
      });
    }
  }
  // A slug directory whose Project lies outside every Root left the scan with it: ticket 06
  // rule 7 leaves neither a breadcrumb nor state behind, so `scan.slugs` is the whole list.

  // `~/.cursor/worktrees/<repo>/<id>/`: swept by count, never by age — so never preselected.
  // A leaf still registered in its repository's `.git/worktrees/` is live and offers no action.
  const retention: HarnessCache["retention"] = {
    days: null,
    bytes: null,
    count: scan.retention.count,
    source: "cursor.worktreeMaxCount",
  };
  for (const leaf of scan.worktrees) {
    if (leaf.main !== null && leaf.located === null) continue;
    await cacheEntity(scan, {
      paths: [leaf.dir],
      cacheKind: "worktree",
      unit: "dir",
      project: leaf.located?.project ?? null,
      // D120: an unusable retention value fails closed to `undocumented` for the whole harness.
      rule: scan.retention.invalid ? "undocumented" : "swept",
      retention,
      liveGuard: { kind: "install-path", alive: leaf.registered },
      userContent: false,
      protection: leaf.registered ? "live" : "none",
      removal: leaf.registered ? { method: "none" } : { method: "trash" },
      sensitive: false,
      surface: "ide",
      label: `${basename(join(leaf.dir, ".."))}/${leaf.name}`,
    });
  }

  if ((await treeStats(plansDir)).files > 0) {
    await cacheEntity(scan, {
      paths: [plansDir],
      cacheKind: "plan",
      unit: "dir",
      project: null,
      rule: "undocumented",
      liveGuard: null,
      userContent: true,
      protection: "undocumented",
      removal: { method: "none" },
      sensitive: true,
    });
  }

  for (const entry of (await listDir(configDir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (CONFIG_CLASSIFIED.has(entry.name)) continue;
    const path = join(configDir, entry.name);
    if (/^mcp\.json\.backup\d*$/.test(entry.name)) {
      // D55: a backup clone of the MCP configuration — tickable, trashable, never preselected,
      // and never opened (D65): it is a copy of the live file, secrets included.
      await cacheEntity(scan, {
        paths: [path],
        cacheKind: "config-backup",
        unit: "file",
        project: null,
        rule: "undocumented",
        liveGuard: null,
        userContent: false,
        protection: "none",
        removal: { method: "trash" },
        sensitive: true,
      });
      continue;
    }
    await sizeOnly(scan, path, null);
  }
}

export async function collectCache(scan: CursorScan): Promise<void> {
  await collectAppSupport(scan);
  await collectConfigDir(scan);
}
