/* oxlint-disable no-await-in-loop -- sequential on purpose: ordered, bounded disk IO */
/**
 * Codex's own state, exactly as ticket 08 §1 lists it. Codex documents no age-based deletion, so
 * `sweepDocumented: false` and nothing here is ever preselected: rollouts, `history.jsonl` and
 * `log/` are `kept` (Delete only), the databases are `kept` + `protection: "never"` +
 * `removal: none` (D104), and every top-level name the docs leave unexplained is a size-only
 * `undocumented` row so that "moldig shows 4.2 GB under `~/.codex`" stays true without pretending
 * to know what `.tmp/` is.
 *
 * No transcript is ever opened: a rollout's Project comes from the `threads` row that names it,
 * never from the `cwd` on its first line, and a `.jsonl.zst` is never decompressed.
 */
import { basename, join } from "node:path";
import type { HarnessCache, Surface } from "../../index/types.js";
import { formatOf } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { ageDays, isDirectory, listDir, statOrNull, toIso, treeStats } from "../../scan/fs.js";
import { addEntity, baseEntity, type CodexScan } from "./model.js";
import { DB_SIDECARS, GLOBAL_STATE_TMP, ROLLOUT_NAME, VERSIONED_DB } from "./paths.js";
import { isCredentialName, credentialEntity } from "./settings-files.js";
import { historyMaxBytes } from "./state.js";

const ACTIVITY_WINDOW_MS = 60 * 60 * 1000;
const NO_RETENTION: HarnessCache["retention"] = {
  days: null,
  bytes: null,
  count: null,
  source: null,
};

export interface UnitInput {
  paths: string[];
  cacheKind: string;
  unit: HarnessCache["unit"];
  session: string | null;
  project: DiscoveredProject | null;
  surface: Surface | null;
  rule: HarnessCache["rule"];
  retention?: HarnessCache["retention"];
  liveGuard: HarnessCache["liveGuard"] | ((newestMs: number | null) => HarnessCache["liveGuard"]);
  userContent: boolean;
  protection: HarnessCache["protection"];
  removal: HarnessCache["removal"];
  sensitive: boolean;
  label?: string;
  format?: HarnessCache["format"];
}

function recentActivity(now: Date): (newestMs: number | null) => HarnessCache["liveGuard"] {
  return (newestMs) => ({
    kind: "recent-activity",
    alive: newestMs !== null && now.getTime() - newestMs < ACTIVITY_WINDOW_MS,
  });
}

export async function cacheEntity(scan: CodexScan, input: UnitInput): Promise<HarnessCache | null> {
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
  const liveGuard =
    typeof input.liveGuard === "function" ? input.liveGuard(newest) : input.liveGuard;
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
    format: input.format ?? (input.unit === "dir" ? "dir" : formatOf(anchor)),
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
    surface: input.surface,
    session: input.session,
    // Codex has no slug directories: nothing on disk is named after a project path.
    slug: null,
    rule: input.rule,
    retention: input.retention ?? NO_RETENTION,
    liveGuard,
    // D122: a `protection: "undocumented"` row cannot carry `userContent` — the flag is unreachable.
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

interface Rollout {
  path: string;
  /** The thread uuid in the file name; the row that owns it, when the index still has one. */
  session: string;
  date: string;
  archived: boolean;
}

/** `sessions/YYYY/MM/DD/rollout-*.jsonl[.zst]`, four levels deep, and the flat archived twin. */
async function rolloutsUnder(dir: string, archived: boolean, depth = 0): Promise<Rollout[]> {
  if (depth > 4) return [];
  const out: Rollout[] = [];
  for (const entry of (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await rolloutsUnder(path, archived, depth + 1)));
      continue;
    }
    const match = ROLLOUT_NAME.exec(entry.name);
    if (match === null) continue;
    out.push({ path, session: match[2] ?? "", date: match[1] ?? "", archived });
  }
  return out;
}

/** `rollout <uuid8> · <YYYY-MM-DD from the file name>` (+ ` · archived`). */
function rolloutLabel(rollout: Rollout): string {
  const head = `rollout ${rollout.session.slice(0, 8)} · ${rollout.date}`;
  return rollout.archived ? `${head} · archived` : head;
}

/** The `-wal` / `-shm` companions of a database, listed only when they already exist. */
async function sidecarsOf(file: string): Promise<string[]> {
  const found: string[] = [];
  for (const suffix of DB_SIDECARS) {
    if ((await statOrNull(file + suffix)) !== null) found.push(file + suffix);
  }
  return found;
}

async function collectDatabase(
  scan: CodexScan,
  file: string,
  surface: Surface | null,
): Promise<void> {
  const paths = [file, ...(await sidecarsOf(file))];
  await cacheEntity(scan, {
    paths,
    cacheKind: "database",
    unit: "database",
    session: null,
    project: null,
    surface,
    // D104: `HarnessCache.rule` has no `never` member — ticket 08's "never (`database`)" is a
    // `protection` value in a `rule` column.
    rule: "kept",
    liveGuard: null,
    userContent: false,
    protection: "never",
    removal: { method: "none" },
    sensitive: true,
    format: "sqlite",
  });
}

/** Top-level names of `$CODEX_HOME` this adapter accounts for elsewhere (§1.1's table). */
function classifiedNames(scan: CodexScan): Set<string> {
  return new Set([
    "config.toml",
    "AGENTS.md",
    "AGENTS.override.md",
    "skills",
    "rules",
    "hooks.json",
    "memories",
    "sessions",
    "archived_sessions",
    "history.jsonl",
    "sqlite",
    "shell_snapshots",
    ".codex-global-state.json",
    ".codex-global-state.json.bak",
    ...(scan.paths.logVia === "default" ? [basename(scan.paths.logDir)] : []),
  ]);
}

export async function collectCache(scan: CodexScan): Promise<void> {
  const now = scan.ctx.options.now;
  const { paths } = scan;

  // Rollouts. The Project of a rollout is the Project of the `threads` row that names it — the
  // `cwd` on the file's first line is never read (06 "Not read in v1").
  const byRolloutPath = new Map<string, string>();
  const byThreadId = new Map<string, string>();
  for (const { crumb, located } of scan.cwds) {
    for (const row of crumb.sources) {
      if (located.project === null) continue;
      if (row.rolloutPath !== null) {
        byRolloutPath.set(scan.ctx.identity.fold(row.rolloutPath), located.project.id);
      }
      byThreadId.set(row.id, located.project.id);
    }
  }
  const projectById = new Map(
    scan.ctx.discovery.projects().map((project) => [project.id, project]),
  );
  const rollouts = [
    ...(await rolloutsUnder(paths.sessions, false)),
    ...(await rolloutsUnder(paths.archivedSessions, true)),
  ];
  for (const rollout of rollouts) {
    const projectId =
      byRolloutPath.get(scan.ctx.identity.fold(rollout.path)) ??
      byThreadId.get(rollout.session) ??
      null;
    const entity = await cacheEntity(scan, {
      paths: [rollout.path],
      cacheKind: "transcript",
      unit: "session",
      session: rollout.session === "" ? null : rollout.session,
      project: projectId === null ? null : (projectById.get(projectId) ?? null),
      // `threads.source` is not mapped to a surface: rows are never decoded that far (§1.9).
      surface: null,
      rule: "kept",
      liveGuard: recentActivity(now),
      userContent: false,
      protection: "none",
      removal: { method: "trash" },
      sensitive: true,
      label: rolloutLabel(rollout),
    });
    if (entity !== null) scan.rolloutUnits.set(scan.ctx.identity.fold(rollout.path), entity.id);
  }

  // `history.jsonl`: every prompt ever typed — user content, kept, Delete only.
  const history = join(paths.dir, "history.jsonl");
  if ((await statOrNull(history)) !== null) {
    await cacheEntity(scan, {
      paths: [history],
      cacheKind: "log",
      unit: "file",
      session: null,
      project: null,
      surface: null,
      rule: "kept",
      retention: {
        days: null,
        bytes: historyMaxBytes(scan.raw),
        count: null,
        source: "history.max_bytes",
      },
      liveGuard: null,
      userContent: true,
      protection: "none",
      removal: { method: "trash" },
      sensitive: true,
    });
  }

  // `log/` (or `log_dir`): listed even when empty, so the row exists before the first crash.
  if (await isDirectory(paths.logDir)) {
    await cacheEntity(scan, {
      paths: [paths.logDir],
      cacheKind: "log",
      unit: "dir",
      session: null,
      project: null,
      surface: null,
      rule: "kept",
      liveGuard: null,
      userContent: false,
      protection: "none",
      removal: { method: "trash" },
      sensitive: false,
    });
  }

  // The versioned databases, wherever `sqlite_home` put them; `memories_N.sqlite` belongs to the
  // memory unit instead (D109) and is emitted there.
  for (const entry of (await listDir(paths.sqliteHome)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile() || !VERSIONED_DB.test(entry.name)) continue;
    if (entry.name.startsWith("memories_")) continue;
    await collectDatabase(scan, join(paths.sqliteHome, entry.name), null);
  }
  const desktopDbs = join(paths.dir, "sqlite");
  for (const entry of (await listDir(desktopDbs)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".db")) continue;
    await collectDatabase(scan, join(desktopDbs, entry.name), "desktop");
  }

  // The desktop state's backup clone: D55 makes it tickable (trash), never preselected.
  const backup = `${paths.globalState}.bak`;
  if ((await statOrNull(backup)) !== null) {
    await cacheEntity(scan, {
      paths: [backup],
      cacheKind: "config-backup",
      unit: "file",
      session: null,
      project: null,
      surface: "desktop",
      rule: "undocumented",
      liveGuard: null,
      userContent: false,
      protection: "none",
      removal: { method: "trash" },
      sensitive: false,
      format: "json",
    });
  }

  const entries = (await listDir(paths.dir)).toSorted((a, b) => a.name.localeCompare(b.name));
  const classified = classifiedNames(scan);
  for (const entry of entries) {
    const path = join(paths.dir, entry.name);
    if (entry.name === "shell_snapshots") {
      await cacheEntity(scan, {
        paths: [path],
        cacheKind: "shell-snapshot",
        unit: "dir",
        session: null,
        project: null,
        // D123: the snapshots carry no surface of their own.
        surface: null,
        rule: "undocumented",
        liveGuard: null,
        userContent: false,
        protection: "undocumented",
        removal: { method: "none" },
        sensitive: true,
      });
      continue;
    }
    // `..codex-global-state.json.tmp-<ms>-<uuid>`: a desktop write that never completed.
    if (GLOBAL_STATE_TMP.test(entry.name)) {
      await cacheEntity(scan, {
        paths: [path],
        cacheKind: "config-backup",
        unit: "file",
        session: null,
        project: null,
        surface: "desktop",
        rule: "undocumented",
        liveGuard: null,
        userContent: false,
        protection: "undocumented",
        removal: { method: "none" },
        sensitive: false,
        format: "json",
      });
      continue;
    }
    if (classified.has(entry.name)) continue;
    if (entry.name.endsWith(".config.toml")) continue;
    if (VERSIONED_DB.test(entry.name)) continue;
    if (DB_SIDECARS.some((suffix) => entry.name.endsWith(suffix))) continue;
    // Credential material is stat'ed and listed as a settings file, never as a cache row (D65).
    if (isCredentialName(entry.name)) {
      await credentialEntity(scan, path);
      continue;
    }
    const directory = entry.isDirectory();
    await cacheEntity(scan, {
      paths: [path],
      cacheKind: "undocumented",
      unit: directory ? "dir" : "file",
      session: null,
      project: null,
      surface: null,
      rule: "undocumented",
      liveGuard: null,
      userContent: false,
      protection: "undocumented",
      removal: { method: "none" },
      sensitive: false,
    });
  }
}
