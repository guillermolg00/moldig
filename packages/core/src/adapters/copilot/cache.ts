/* oxlint-disable no-await-in-loop -- sequential on purpose: bounded disk IO and a stable order */
/**
 * Harness cache units exactly as ticket 08 §1 lists them for Copilot: a session is the whole
 * `session-state/<uuid>/` directory and is **kept** (Delete only — sessions synced to the GitHub
 * account are untouched by design); `logs/*` is swept with no published number, so it is
 * tickable and never preselected; `session-store.db` and VS Code's `state.vscdb` are databases
 * moldig promises never to open (D104: `rule: "kept"`, `protection: "never"`, `removal: none`);
 * everything else under `<COPILOT_HOME>` is a size-only row. On the VS Code side D66 splits the
 * storage directory: VS Code's own `workspaceStorage/<id>/` is size-only, and only the
 * Copilot-specific subdirectories inside it are tickable.
 *
 * Nothing here opens a file: every number comes from `lstat`.
 */
import { basename, join } from "node:path";
import { formatOf } from "../../scan/context.js";
import type { EntityBase, HarnessCache, Surface } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { ageDays, isDirectory, listDir, lstatOrNull, toIso, treeStats } from "../../scan/fs.js";
import { addEntity, baseEntity, type CopilotScan } from "./model.js";
import { SESSION_ID } from "./paths.js";

const ACTIVITY_WINDOW_MS = 60 * 60 * 1000;

const NO_RETENTION: HarnessCache["retention"] = {
  days: null,
  bytes: null,
  count: null,
  source: null,
};

/** Ticket 08: the log prune has existed since 1.0.55 but publishes no age or count. */
const LOG_RETENTION: HarnessCache["retention"] = {
  days: null,
  bytes: null,
  count: null,
  source: "changelog 1.0.55",
};

export interface UnitInput {
  path: string;
  /** Sub-trees that are units of their own, subtracted so no byte is counted twice. */
  exclude?: string[];
  cacheKind: string;
  unit: HarnessCache["unit"];
  surface: Surface;
  producer?: EntityBase["producer"];
  session: string | null;
  project: DiscoveredProject | null;
  rule: HarnessCache["rule"];
  retention: HarnessCache["retention"];
  liveGuard: HarnessCache["liveGuard"] | "recent-activity";
  userContent: boolean;
  protection: EntityBase["protection"];
  removal: EntityBase["removal"];
  sensitive: boolean;
  label?: (newestMs: number | null) => string;
}

export async function cacheEntity(
  scan: CopilotScan,
  input: UnitInput,
): Promise<HarnessCache | null> {
  const stats = await treeStats(input.path);
  const excluded = await Promise.all((input.exclude ?? []).map((path) => treeStats(path)));
  const files = stats.files - excluded.reduce((sum, item) => sum + item.files, 0);
  const bytes = stats.bytes - excluded.reduce((sum, item) => sum + item.bytes, 0);
  const { oldestMs: oldest, newestMs: newest } = stats;
  const now = scan.ctx.options.now;
  const liveGuard: HarnessCache["liveGuard"] =
    input.liveGuard === "recent-activity"
      ? {
          kind: "recent-activity",
          alive: newest !== null && now.getTime() - newest < ACTIVITY_WINDOW_MS,
        }
      : input.liveGuard;
  const isDir = input.unit === "dir" || input.unit === "session";
  const base = baseEntity(scan, {
    kind: "harness-cache",
    path: input.path,
    scope: "user",
    project: input.project,
    ownership: "harness",
    locator: isDir ? { type: "dir", path: input.path } : { type: "file", path: input.path },
    format: isDir ? "dir" : formatOf(input.path),
    label: input.label?.(newest) ?? basename(input.path),
    sensitive: input.sensitive,
    protection: input.protection,
    removal: input.removal,
    ...(input.producer === undefined ? {} : { producer: input.producer }),
    metrics: {
      bytes,
      files,
      lines: null,
      mtime: newest === null ? null : toIso(newest),
      ageDays: newest === null ? null : ageDays(newest, now),
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
    slug: null,
    rule: input.rule,
    retention: input.retention,
    liveGuard,
    // D122: a `protection: "undocumented"` row never carries `userContent` — the flag is
    // unreachable there, so Copilot's `command-history-state.json` loses it.
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

/** `session <8 chars> · <date of the newest member>` — member file names never appear (they leak titles). */
function sessionLabel(id: string): (newestMs: number | null) => string {
  return (newestMs) =>
    newestMs === null
      ? `session ${id.slice(0, 8)}`
      : `session ${id.slice(0, 8)} · ${toIso(newestMs).slice(0, 10)}`;
}

/** Entries of `<COPILOT_HOME>` this adapter classifies; everything else is a size-only row. */
const CLASSIFIED = new Set([
  "config.json",
  "settings.json",
  "lsp-config.json",
  "permissions-config.json",
  "mcp-config.json",
  "mcp-oauth-config",
  "mcp-secrets",
  "copilot-instructions.md",
  "instructions",
  "agents",
  "skills",
  "prompts",
  "session-state",
  "session-store.db",
  "session-store.db-wal",
  "session-store.db-shm",
  "logs",
]);

/** A subdirectory of a VS Code workspace-storage directory that Copilot itself wrote (D66). */
function isCopilotStorage(name: string): boolean {
  return name.toLowerCase().includes("copilot");
}

async function databaseUnit(
  scan: CopilotScan,
  path: string,
  surface: Surface,
  producer: EntityBase["producer"],
): Promise<void> {
  if ((await lstatOrNull(path)) === null) return;
  await cacheEntity(scan, {
    path,
    cacheKind: "database",
    unit: "database",
    surface,
    ...(producer === null ? {} : { producer }),
    session: null,
    project: null,
    // D104: `HarnessCache.rule` has no `never` member — ticket 08's "never (database)" is the
    // `protection` value. A database is kept, protected, and has no removal method at all.
    rule: "kept",
    retention: NO_RETENTION,
    liveGuard: null,
    userContent: false,
    protection: "never",
    removal: { method: "none" },
    sensitive: true,
  });
}

export async function collectCache(scan: CopilotScan): Promise<void> {
  const { paths } = scan;

  // Sessions: one unit per `session-state/<uuid>/`, kept.
  for (const record of scan.sessions) {
    await cacheEntity(scan, {
      path: record.dir,
      cacheKind: "transcript",
      unit: "session",
      surface: "cli",
      session: SESSION_ID.test(record.id) ? record.id : null,
      project: record.located?.project ?? null,
      rule: "kept",
      retention: NO_RETENTION,
      liveGuard: "recent-activity",
      userContent: false,
      protection: "none",
      removal: { method: "trash" },
      sensitive: true,
      label: sessionLabel(record.id),
    });
  }

  // `logs/process-<ts>-<pid>.log`: swept with no published number → tickable, never preselected.
  for (const entry of (await listDir(paths.logs)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile()) continue;
    await cacheEntity(scan, {
      path: join(paths.logs, entry.name),
      cacheKind: "log",
      unit: "file",
      surface: "cli",
      session: null,
      project: null,
      rule: "swept",
      retention: LOG_RETENTION,
      liveGuard: "recent-activity",
      userContent: false,
      protection: "none",
      removal: { method: "trash" },
      sensitive: false,
    });
  }

  await databaseUnit(scan, paths.sessionStore, "cli", null);

  // Everything else under `<COPILOT_HOME>`: size-only rows, so "4.2 GB under ~/.copilot" stays
  // true without moldig pretending to know what `pkg/` is.
  for (const entry of (await listDir(paths.cliHome)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (CLASSIFIED.has(entry.name)) continue;
    const path = join(paths.cliHome, entry.name);
    await cacheEntity(scan, {
      path,
      cacheKind: "undocumented",
      unit: entry.isDirectory() ? "dir" : "file",
      surface: "cli",
      session: null,
      project: null,
      rule: "undocumented",
      retention: NO_RETENTION,
      liveGuard: null,
      userContent: false,
      protection: "undocumented",
      removal: { method: "none" },
      sensitive: false,
    });
  }

  // VS Code. D66/D117: the storage directory belongs to VS Code and holds a database moldig
  // promised never to touch, so the directory is size-only; the Copilot subdirectories inside
  // it are the tickable part.
  for (const record of scan.workspaces) {
    const children = (await listDir(record.dir)).filter(
      (entry) => entry.isDirectory() && isCopilotStorage(entry.name),
    );
    const copilotDirs = children.map((entry) => join(record.dir, entry.name));
    await cacheEntity(scan, {
      path: record.dir,
      ...(copilotDirs.length === 0 ? {} : { exclude: copilotDirs }),
      cacheKind: "workspace",
      unit: "dir",
      surface: "vscode",
      producer: { harness: "other-app", surface: "vscode" },
      session: null,
      project: record.located?.project ?? null,
      rule: "undocumented",
      retention: NO_RETENTION,
      liveGuard: null,
      userContent: false,
      protection: "undocumented",
      removal: { method: "none" },
      sensitive: true,
    });
    for (const dir of copilotDirs.toSorted((a, b) => a.localeCompare(b))) {
      await cacheEntity(scan, {
        path: dir,
        cacheKind: "undocumented",
        unit: "dir",
        surface: "vscode",
        producer: { harness: "copilot", surface: "vscode" },
        session: null,
        project: record.located?.project ?? null,
        rule: "undocumented",
        retention: NO_RETENTION,
        liveGuard: null,
        userContent: false,
        protection: "none",
        removal: { method: "trash" },
        sensitive: true,
      });
    }
  }

  for (const name of ["state.vscdb", "state.vscdb.backup"]) {
    await databaseUnit(scan, join(paths.globalStorage, name), "vscode", {
      harness: "other-app",
      surface: "vscode",
    });
  }
  const chatStorage = join(paths.globalStorage, "github.copilot-chat");
  if (await isDirectory(chatStorage)) {
    await cacheEntity(scan, {
      path: chatStorage,
      cacheKind: "undocumented",
      unit: "dir",
      surface: "vscode",
      producer: { harness: "copilot", surface: "vscode" },
      session: null,
      project: null,
      rule: "undocumented",
      retention: NO_RETENTION,
      liveGuard: null,
      userContent: false,
      protection: "undocumented",
      removal: { method: "none" },
      sensitive: true,
    });
  }
}
