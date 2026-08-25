/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * Harness cache units exactly as ticket 08 §1 lists them for Claude Code: a session is the
 * transcript plus every per-session directory (`<slug>/<id>/`, `file-history/<id>`,
 * `session-env/<id>`, `tasks/<id>`, `image-cache/<id>`, `uploads/<id>`, `debug/<id>.txt`),
 * anchored at the transcript; `shell-snapshots/*`, legacy `todos/*`, `backups/*` and the
 * other documented sets are their own units; `history.jsonl` and the small caches are kept;
 * names the docs leave undocumented are size-only rows. Transcripts are never opened here.
 */
import { basename, join } from "node:path";
import type { HarnessCache } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { ageDays, isDirectory, listDir, readJsonObject, toIso, treeStats } from "../../scan/fs.js";
import { formatOf } from "../../scan/context.js";
import { addEntity, baseEntity, type ClaudeScan } from "./model.js";
import { SESSION_ID } from "./paths.js";

const ACTIVITY_WINDOW_MS = 60 * 60 * 1000;

interface UnitInput {
  paths: string[];
  cacheKind: string;
  unit: HarnessCache["unit"];
  session: string | null;
  slug: string | null;
  project: DiscoveredProject | null;
  rule: HarnessCache["rule"];
  retention: HarnessCache["retention"];
  liveGuard: HarnessCache["liveGuard"] | ((newestMs: number | null) => HarnessCache["liveGuard"]);
  userContent: boolean;
  protection: HarnessCache["protection"];
  removal: HarnessCache["removal"];
  sensitive: boolean;
  /** A fixed label, or one derived from the unit's newest member (a session's date). */
  label?: string | ((newestMs: number | null) => string);
}

function recentActivity(now: Date): (newestMs: number | null) => HarnessCache["liveGuard"] {
  return (newestMs) => ({
    kind: "recent-activity",
    alive: newestMs !== null && now.getTime() - newestMs < ACTIVITY_WINDOW_MS,
  });
}

async function cacheEntity(scan: ClaudeScan, input: UnitInput): Promise<HarnessCache | null> {
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
  // Ticket 07: a session is a multi-directory unit anchored at its transcript (`paths[0]`),
  // whatever its member count today; other units are the file or directory they are.
  const locator: HarnessCache["locator"] =
    input.unit === "session" || input.paths.length > 1
      ? { type: "paths", paths: input.paths }
      : input.unit === "dir"
        ? { type: "dir", path: anchor }
        : { type: "file", path: anchor };
  const label =
    typeof input.label === "function" ? input.label(newest) : (input.label ?? basename(anchor));
  const base = baseEntity(scan, {
    kind: "harness-cache",
    path: anchor,
    scope: "user",
    project: input.project,
    ownership: "harness",
    locator,
    format: input.unit === "dir" ? "dir" : formatOf(anchor),
    label,
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
    slug: input.slug,
    rule: input.rule,
    retention: input.retention,
    liveGuard,
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

/** Per-session directories outside the slug dir, by the cacheKind ticket 07 names for them. */
const SESSION_DIRS: [string, string][] = [
  ["file-history", "file-history"],
  ["session-env", "session-env"],
  ["tasks", "task-list"],
  ["image-cache", "paste-cache"],
  ["uploads", "paste-cache"],
];

/** Directories whose files are units of their own (`swept`, days retention). */
const FILE_UNIT_DIRS: [string, string, boolean][] = [
  ["shell-snapshots", "shell-snapshot", false],
  ["todos", "task-list", false],
  ["plans", "plan", true],
  ["paste-cache", "paste-cache", true],
  ["feedback-bundles", "log", true],
  ["usage-data", "log", true],
];
const DIR_UNITS: [string, string][] = [
  ["statsig", "log"],
  ["logs", "log"],
];
const KEPT_FILES: [string, boolean][] = [
  ["history.jsonl", true],
  ["stats-cache.json", false],
  ["remote-settings.json", false],
  ["policy-limits.json", false],
];
const UNDOCUMENTED = [
  "jobs",
  "daemon",
  "chrome",
  "ide",
  "downloads",
  "memory",
  "mcp-needs-auth-cache.json",
  ".last-cleanup",
  ".last-update-result.json",
  "bridge-pointer.json",
  "scheduled_tasks.lock",
];

/** Live sessions registry (`~/.claude/sessions/<pid>.json`): session id → pid. */
async function liveSessions(configDir: string): Promise<Map<string, number>> {
  const dir = join(configDir, "sessions");
  const out = new Map<string, number>();
  const entries = (await listDir(dir)).filter(
    (entry) => entry.isFile() && entry.name.endsWith(".json"),
  );
  const records = await Promise.all(entries.map((entry) => readJsonObject(join(dir, entry.name))));
  for (const record of records) {
    if (record === null) continue;
    const sessionId = record["sessionId"];
    const pid = record["pid"];
    if (typeof sessionId === "string" && typeof pid === "number") out.set(sessionId, pid);
  }
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function collectCache(scan: ClaudeScan, projects: DiscoveredProject[]): Promise<void> {
  const { configDir } = scan.paths;
  const now = scan.ctx.options.now;
  const days = scan.retention.days;
  const swept: HarnessCache["rule"] = scan.retention.invalid ? "undocumented" : "swept";
  const daysRetention: HarnessCache["retention"] = {
    days,
    bytes: null,
    count: null,
    source: "cleanupPeriodDays",
  };
  const none: HarnessCache["retention"] = { days: null, bytes: null, count: null, source: null };
  const registry = await liveSessions(configDir);
  const seenSessions = new Set<string>();

  // Session units.
  for (const { slug, located } of scan.slugs) {
    for (const head of slug.transcripts) {
      const id = head.sessionId;
      seenSessions.add(id);
      const candidates = [
        join(slug.dir, id),
        ...SESSION_DIRS.map(([dir]) => join(configDir, dir, id)),
      ];
      const present = await Promise.all(
        candidates.map(async (path) => ((await isDirectory(path)) ? path : null)),
      );
      const debug = join(configDir, "debug", `${id}.txt`);
      const paths = [head.path, ...present.filter((path): path is string => path !== null)];
      if ((await treeStats(debug)).files > 0) paths.push(debug);
      const pid = registry.get(id);
      const project = located?.project ?? null;
      await cacheEntity(scan, {
        paths,
        cacheKind: "transcript",
        unit: "session",
        session: id,
        slug: slug.slug,
        project,
        rule: swept,
        retention: daysRetention,
        liveGuard: { kind: "pid", alive: pid !== undefined && pidAlive(pid) },
        userContent: present.includes(join(configDir, "uploads", id)),
        protection: "none",
        removal: { method: "trash" },
        sensitive: true,
        label: sessionLabel(id),
      });
    }
    for (const name of slug.otherEntries) {
      if (name === "sessions-index.json") continue;
      const path = join(slug.dir, name);
      const isSessionDir = SESSION_ID.test(name) && (await isDirectory(path));
      await cacheEntity(scan, {
        paths: [path],
        cacheKind: isSessionDir ? "transcript" : "undocumented",
        unit: isSessionDir ? "dir" : (await isDirectory(path)) ? "dir" : "file",
        session: isSessionDir ? name : null,
        slug: slug.slug,
        project: located?.project ?? null,
        rule: isSessionDir ? swept : "undocumented",
        retention: isSessionDir ? daysRetention : none,
        liveGuard: isSessionDir ? recentActivity(now) : null,
        userContent: false,
        protection: isSessionDir ? "none" : "undocumented",
        removal: isSessionDir ? { method: "trash" } : { method: "none" },
        sensitive: isSessionDir,
      });
    }
  }

  // Per-session members whose transcript is gone.
  for (const [dirName, cacheKind] of SESSION_DIRS) {
    const dir = join(configDir, dirName);
    for (const entry of (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || seenSessions.has(entry.name)) continue;
      await cacheEntity(scan, {
        paths: [join(dir, entry.name)],
        cacheKind,
        unit: "dir",
        session: SESSION_ID.test(entry.name) ? entry.name : null,
        slug: null,
        project: null,
        rule: swept,
        retention: daysRetention,
        liveGuard: recentActivity(now),
        userContent: dirName === "uploads",
        protection: "none",
        removal: { method: "trash" },
        sensitive: true,
      });
    }
  }
  const debugDir = join(configDir, "debug");
  for (const entry of (await listDir(debugDir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (
      !entry.isFile() ||
      !entry.name.endsWith(".txt") ||
      seenSessions.has(basename(entry.name, ".txt"))
    )
      continue;
    await cacheEntity(scan, {
      paths: [join(debugDir, entry.name)],
      cacheKind: "debug-log",
      unit: "file",
      session: SESSION_ID.test(basename(entry.name, ".txt")) ? basename(entry.name, ".txt") : null,
      slug: null,
      project: null,
      rule: swept,
      retention: daysRetention,
      liveGuard: recentActivity(now),
      userContent: false,
      protection: "none",
      removal: { method: "trash" },
      sensitive: true,
    });
  }

  // File units.
  for (const [dirName, cacheKind, userContent] of FILE_UNIT_DIRS) {
    const dir = join(configDir, dirName);
    for (const entry of (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() && !entry.isDirectory()) continue;
      const sessionMatch = /^([0-9a-f-]{36})/i.exec(entry.name);
      await cacheEntity(scan, {
        paths: [join(dir, entry.name)],
        cacheKind,
        unit: entry.isDirectory() ? "dir" : "file",
        session:
          sessionMatch?.[1] !== undefined && SESSION_ID.test(sessionMatch[1])
            ? sessionMatch[1]
            : null,
        slug: null,
        project: null,
        rule: swept,
        retention: daysRetention,
        liveGuard: recentActivity(now),
        userContent,
        protection: "none",
        removal: { method: "trash" },
        sensitive:
          cacheKind === "shell-snapshot" || cacheKind === "paste-cache" || cacheKind === "plan",
      });
    }
  }
  const backups = join(configDir, "backups");
  for (const entry of (await listDir(backups)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile()) continue;
    await cacheEntity(scan, {
      paths: [join(backups, entry.name)],
      cacheKind: "config-backup",
      unit: "file",
      session: null,
      slug: null,
      project: null,
      rule: swept,
      retention: { days: null, bytes: null, count: 5, source: "claude-directory" },
      liveGuard: null,
      userContent: false,
      protection: "none",
      removal: { method: "trash" },
      sensitive: true,
    });
  }
  for (const [dirName, cacheKind] of DIR_UNITS) {
    const dir = join(configDir, dirName);
    if (!(await isDirectory(dir))) continue;
    await cacheEntity(scan, {
      paths: [dir],
      cacheKind,
      unit: "dir",
      session: null,
      slug: null,
      project: null,
      rule: swept,
      retention: daysRetention,
      liveGuard: recentActivity(now),
      userContent: false,
      protection: "none",
      removal: { method: "trash" },
      sensitive: false,
    });
  }
  for (const [name, userContent] of KEPT_FILES) {
    const path = join(configDir, name);
    if ((await treeStats(path)).files === 0) continue;
    await cacheEntity(scan, {
      paths: [path],
      cacheKind: "log",
      unit: "file",
      session: null,
      slug: null,
      project: null,
      rule: "kept",
      retention: none,
      liveGuard: null,
      userContent,
      protection: "none",
      removal: { method: "trash" },
      sensitive: userContent,
    });
  }
  const changelog = join(configDir, "cache", "changelog.md");
  if ((await treeStats(changelog)).files > 0) {
    await cacheEntity(scan, {
      paths: [changelog],
      cacheKind: "log",
      unit: "file",
      session: null,
      slug: null,
      project: null,
      rule: "kept",
      retention: none,
      liveGuard: null,
      userContent: false,
      protection: "none",
      removal: { method: "trash" },
      sensitive: false,
    });
  }
  for (const name of UNDOCUMENTED) {
    const path = join(configDir, name);
    const stats = await treeStats(path);
    if (stats.files === 0 && !(await isDirectory(path))) continue;
    await cacheEntity(scan, {
      paths: [path],
      cacheKind: "undocumented",
      unit: (await isDirectory(path)) ? "dir" : "file",
      session: null,
      slug: null,
      project: null,
      rule: "undocumented",
      retention: none,
      liveGuard: null,
      userContent: false,
      protection: "undocumented",
      removal: { method: "none" },
      sensitive: false,
    });
  }

  // <repo>/.claude/worktrees/<name>: swept when not registered in the repository's .git/worktrees.
  for (const project of projects) {
    if (project.reachability !== "present") continue;
    const dir = join(project.path, ".claude", "worktrees");
    for (const entry of (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory()) continue;
      const path = join(dir, entry.name);
      const registered = project.members.some(
        (member) => member.role === "worktree" && scan.ctx.identity.same(member.path, path),
      );
      await cacheEntity(scan, {
        paths: [path],
        cacheKind: "worktree",
        unit: "dir",
        session: null,
        slug: null,
        project,
        rule: swept,
        retention: daysRetention,
        liveGuard: { kind: "install-path", alive: registered },
        userContent: false,
        protection: registered ? "live" : "none",
        removal: registered ? { method: "none" } : { method: "trash" },
        sensitive: false,
      });
    }
  }
}

/** `session <8 chars> · <date of the newest member>` (a unit's age is its newest member, 07/08). */
function sessionLabel(sessionId: string): (newestMs: number | null) => string {
  return (newestMs) =>
    newestMs === null
      ? `session ${sessionId.slice(0, 8)}`
      : `session ${sessionId.slice(0, 8)} · ${toIso(newestMs).slice(0, 10)}`;
}
