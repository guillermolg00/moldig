/* oxlint-disable no-await-in-loop -- sequential on purpose: one row per unit, in the order ticket 08 lists them */
/**
 * Harness cache units exactly as ticket 08 §1 lists them for OpenCode. The database is a `kept`
 * unit that is never actionable (D104: `protection: "never"`, `removal.method: "none"`); a
 * **session** is a row inside it, so its unit has a `sqlite` locator, `metrics.bytes: 0` (the
 * file only shrinks when OpenCode vacuums) and the only removal the harness offers —
 * `opencode session delete <id>`, flagged *permanent* by the actions engine because nothing
 * recovers it. The legacy `storage/` tree and `log/` are `undocumented` (research 10: the
 * documented keep-10 log rule has no code behind it, so moldig fails closed); everything else
 * under the data, config and cache directories is a size-only row.
 */
import { basename, join } from "node:path";
import type { HarnessCache } from "../../index/types.js";
import { formatOf } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { ageDays, isDirectory, listDir, toIso, treeStats } from "../../scan/fs.js";
import type { SessionRow } from "./db.js";
import { addEntity, baseEntity, type OpenCodeScan } from "./model.js";
import { CREDENTIAL_FILES } from "./settings-files.js";

const ACTIVITY_WINDOW_MS = 60 * 60 * 1000;
const NO_RETENTION: HarnessCache["retention"] = {
  days: null,
  bytes: null,
  count: null,
  source: null,
};

interface UnitInput {
  paths: string[];
  cacheKind: string;
  unit: HarnessCache["unit"];
  session: string | null;
  project: DiscoveredProject | null;
  rule: HarnessCache["rule"];
  liveGuard: HarnessCache["liveGuard"] | "recent-activity";
  userContent: boolean;
  protection: HarnessCache["protection"];
  removal: HarnessCache["removal"];
  sensitive: boolean;
  label?: string;
}

function guardOf(
  scan: OpenCodeScan,
  guard: UnitInput["liveGuard"],
  newestMs: number | null,
): HarnessCache["liveGuard"] {
  if (guard !== "recent-activity") return guard;
  return {
    kind: "recent-activity",
    alive: newestMs !== null && scan.ctx.options.now.getTime() - newestMs < ACTIVITY_WINDOW_MS,
  };
}

async function cacheEntity(scan: OpenCodeScan, input: UnitInput): Promise<HarnessCache | null> {
  const anchor = input.paths[0];
  if (anchor === undefined) return null;
  const stats = await Promise.all(input.paths.map((path) => treeStats(path)));
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
  const locator: HarnessCache["locator"] =
    input.paths.length > 1
      ? { type: "paths", paths: input.paths }
      : input.unit === "dir"
        ? { type: "dir", path: anchor }
        : { type: "file", path: anchor };
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
    surface: "cli",
    session: input.session,
    slug: null,
    rule: input.rule,
    retention: NO_RETENTION,
    liveGuard: guardOf(scan, input.liveGuard, newest),
    userContent: input.userContent,
    members: {
      files,
      bytes,
      oldest: oldest === null ? null : toIso(oldest),
      newest: newest === null ? null : toIso(newest),
    },
  };
  return addEntity(scan, entity);
}

/** `session <id> · <date>` (+ ` · child of <parent>`, + ` · archived`) — ticket 08 §1. */
function sessionLabel(row: SessionRow): string {
  const parts = [`session ${row.id}`];
  if (row.timeUpdated !== null) parts.push(toIso(row.timeUpdated).slice(0, 10));
  if (row.parentId !== null) parts.push(`child of ${row.parentId}`);
  if (row.timeArchived !== null) parts.push("archived");
  return parts.join(" · ");
}

/** One `session` row: `metrics.bytes: 0`, a `sqlite` locator and the permanent delegate. */
function sessionUnit(
  scan: OpenCodeScan,
  row: SessionRow,
  project: DiscoveredProject | null,
): HarnessCache {
  const file = scan.database.path;
  const base = baseEntity(scan, {
    kind: "harness-cache",
    path: file,
    keyPath: ["session", "id", row.id],
    scope: "user",
    project,
    ownership: "harness",
    locator: { type: "sqlite", file, table: "session", keyColumn: "id", keyValue: row.id },
    format: "sqlite",
    label: sessionLabel(row),
    sensitive: true,
    protection: "none",
    removal: { method: "delegate", command: `opencode session delete ${row.id}` },
    metrics: {
      bytes: 0,
      files: null,
      lines: null,
      mtime: row.timeUpdated === null ? null : toIso(row.timeUpdated),
      ageDays: row.timeUpdated === null ? null : ageDays(row.timeUpdated, scan.ctx.options.now),
      tokens: null,
      lastUsed: null,
    },
  });
  const entity: HarnessCache = {
    ...base,
    kind: "harness-cache",
    cacheKind: "transcript",
    unit: "session",
    surface: "cli",
    session: row.id,
    slug: null,
    rule: "kept",
    retention: NO_RETENTION,
    liveGuard: guardOf(scan, "recent-activity", row.timeUpdated),
    userContent: false,
    members: {
      files: 0,
      bytes: 0,
      oldest: row.timeCreated === null ? null : toIso(row.timeCreated),
      newest: row.timeUpdated === null ? null : toIso(row.timeUpdated),
    },
  };
  return addEntity(scan, entity);
}

/** Top-level entries of the data directory that ticket 08 names; everything else is size-only. */
const NAMED_DATA_ENTRIES = new Set([
  "opencode.db",
  "opencode.db-wal",
  "opencode.db-shm",
  "storage",
  "log",
  ...CREDENTIAL_FILES,
]);

export async function collectCache(scan: OpenCodeScan): Promise<void> {
  const { database, paths } = scan;

  // The database itself: kept, never actionable (D104), `paths` when a sidecar exists.
  if (database.present) {
    await cacheEntity(scan, {
      paths: [database.path, ...database.sidecars],
      cacheKind: "database",
      unit: "database",
      session: null,
      project: null,
      rule: "kept",
      liveGuard: "recent-activity",
      userContent: false,
      protection: "never",
      removal: { method: "none" },
      sensitive: true,
    });
  }

  // Session rows, attributed to the Project their `project_id` row names.
  const projectOfRow = new Map<string, DiscoveredProject | null>();
  for (const row of database.projects) {
    projectOfRow.set(row.id, scan.rowLocated.get(row.worktree)?.project ?? null);
  }
  for (const row of database.sessions.toSorted((a, b) => a.id.localeCompare(b.id))) {
    const unit = sessionUnit(scan, row, projectOfRow.get(row.projectId) ?? null);
    scan.sessionUnits.set(row.id, unit.id);
  }

  // The legacy JSON store `opencode.db` superseded: one unit for the whole tree.
  if (await isDirectory(paths.storageDir)) {
    const unit = await cacheEntity(scan, {
      paths: [paths.storageDir],
      cacheKind: "transcript",
      unit: "dir",
      session: null,
      project: null,
      rule: "undocumented",
      liveGuard: null,
      userContent: false,
      protection: "none",
      removal: { method: "trash" },
      sensitive: true,
      label: "legacy storage",
    });
    scan.storageUnit = unit?.id ?? null;
  }

  if (await isDirectory(paths.logDir)) {
    await cacheEntity(scan, {
      paths: [paths.logDir],
      cacheKind: "log",
      unit: "dir",
      session: null,
      project: null,
      rule: "undocumented",
      liveGuard: "recent-activity",
      userContent: false,
      protection: "none",
      removal: { method: "trash" },
      sensitive: false,
    });
  }

  // Size-only rows: everything else the harness keeps, which moldig will not pretend to know.
  const sizeOnly: string[] = [];
  for (const entry of (await listDir(paths.dataDir)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (NAMED_DATA_ENTRIES.has(entry.name)) continue;
    sizeOnly.push(join(paths.dataDir, entry.name));
  }
  sizeOnly.push(join(paths.configDir, "node_modules"), join(paths.configDir, "context-mode"));
  sizeOnly.push(paths.cacheDir);
  for (const path of sizeOnly) {
    const directory = await isDirectory(path);
    if (!directory && (await treeStats(path)).files === 0) continue;
    await cacheEntity(scan, {
      paths: [path],
      cacheKind: "undocumented",
      unit: directory ? "dir" : "file",
      session: null,
      project: null,
      rule: "undocumented",
      liveGuard: null,
      userContent: false,
      protection: "undocumented",
      removal: { method: "none" },
      sensitive: false,
    });
  }
}
