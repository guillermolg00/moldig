/* oxlint-disable no-await-in-loop -- sequential on purpose: bounded disk IO and a stable emit order */
/**
 * Harness cache units exactly as ticket 08 §1 lists them for Gemini CLI (spec §10). A session is
 * the chat file plus every per-session member that joins it by `<id8>` — the first eight hex
 * characters of the session UUID; D73 makes the join best effort and D118 files a member that
 * joins nothing as `rule: "undocumented"` (tickable, never preselected). D120 is fail-closed: a
 * retention setting that is disabled, missing or unparseable turns every `swept` row into
 * `undocumented` for the whole harness.
 *
 * `antigravity/` and `antigravity-browser-profile/` are Google Antigravity's, not Gemini CLI's:
 * one size-only row each with a `producer` that is not this harness (D121), and nothing below them
 * is ever read. Transcripts are never opened.
 */
import { basename, join } from "node:path";
import type { HarnessCache } from "../../index/types.js";
import { formatOf } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { ageDays, isDirectory, listDir, toIso, treeStats } from "../../scan/fs.js";
import { addEntity, baseEntity, type GeminiScan } from "./model.js";
import { CHAT_FILE, SESSION_ID, SESSION_MEMBER } from "./paths.js";

const ACTIVITY_WINDOW_MS = 60 * 60 * 1000;

export interface UnitInput {
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
  label?: string | ((newestMs: number | null) => string);
  producer?: HarnessCache["producer"];
}

function recentActivity(now: Date): (newestMs: number | null) => HarnessCache["liveGuard"] {
  return (newestMs) => ({
    kind: "recent-activity",
    alive: newestMs !== null && now.getTime() - newestMs < ACTIVITY_WINDOW_MS,
  });
}

export async function cacheEntity(
  scan: GeminiScan,
  input: UnitInput,
): Promise<HarnessCache | null> {
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
    ...(input.producer === undefined ? {} : { producer: input.producer }),
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

/** Directly under a slug directory, these names are units of their own or belong elsewhere. */
const SLUG_KNOWN = new Set([
  "chats",
  "logs",
  "tool-outputs",
  "memory",
  "checkpoints",
  "shell_history",
  ".project_root",
  "logs.json",
]);

interface Member {
  path: string;
  sid: string;
  cacheKind: string;
  unit: "dir" | "file";
  userContent: boolean;
}

/** Every per-session member of a slug directory, with the session id its name carries. */
async function membersOf(slugDir: string): Promise<Member[]> {
  const out: Member[] = [];
  for (const entry of (await listDir(join(slugDir, "chats"))).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory() && SESSION_ID.test(entry.name)) {
      out.push({
        path: join(slugDir, "chats", entry.name),
        sid: entry.name,
        cacheKind: "subagent-transcript",
        unit: "dir",
        userContent: false,
      });
    }
  }
  for (const [dir, kind, unit] of [
    ["logs", "log", "file"],
    ["tool-outputs", "tool-result", "dir"],
  ] as const) {
    for (const entry of (await listDir(join(slugDir, dir))).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const match = SESSION_MEMBER.exec(entry.name);
      if (match?.[1] === undefined) continue;
      out.push({
        path: join(slugDir, dir, entry.name),
        sid: match[1],
        cacheKind: kind,
        unit,
        userContent: false,
      });
    }
  }
  for (const entry of (await listDir(slugDir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || !SESSION_ID.test(entry.name)) continue;
    out.push({
      path: join(slugDir, entry.name),
      sid: entry.name,
      // Plans, tasks and the tracker of one session (ticket 08 §1: `userContent: false`).
      cacheKind: "plan",
      unit: "dir",
      userContent: false,
    });
  }
  return out;
}

function sessionLabel(id8: string): (newestMs: number | null) => string {
  return (newestMs) =>
    newestMs === null ? `session ${id8}` : `session ${id8} · ${toIso(newestMs).slice(0, 10)}`;
}

export async function collectCache(scan: GeminiScan): Promise<void> {
  const now = scan.ctx.options.now;
  const { days, count, disabled } = scan.retention;
  // D120: with no sweep to point at, a `swept` row would promise a cleanup that never happens.
  const swept: HarnessCache["rule"] = disabled ? "undocumented" : "swept";
  const sweepRetention: HarnessCache["retention"] = {
    days,
    bytes: null,
    count,
    source: "general.sessionRetention.maxAge",
  };
  const none: HarnessCache["retention"] = { days: null, bytes: null, count: null, source: null };

  for (const slug of scan.slugs) {
    const project = slug.located?.project ?? null;
    if (slug.store === "history") {
      // The shadow git of a Project's checkpoints: kept, never swept, `.git` never opened.
      await cacheEntity(scan, {
        paths: [slug.dir],
        cacheKind: "checkpoint",
        unit: "dir",
        session: null,
        slug: slug.slug,
        project,
        rule: "kept",
        retention: none,
        liveGuard: null,
        userContent: false,
        protection: "none",
        removal: { method: "trash" },
        sensitive: false,
      });
      continue;
    }
    const members = await membersOf(slug.dir);
    const claimed = new Set<string>();
    for (const entry of (await listDir(join(slug.dir, "chats"))).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const match = CHAT_FILE.exec(entry.name);
      if (!entry.isFile() || match?.[2] === undefined) continue;
      const id8 = match[2].toLowerCase();
      // D73: the join is best effort — a member whose `<id8>` does not match simply does not join.
      const joined = members.filter((member) => member.sid.slice(0, 8).toLowerCase() === id8);
      for (const member of joined) claimed.add(member.path);
      const anchor = join(slug.dir, "chats", entry.name);
      await cacheEntity(scan, {
        paths: [anchor, ...joined.map((member) => member.path)],
        cacheKind: "transcript",
        unit: "session",
        session: joined[0]?.sid ?? null,
        slug: slug.slug,
        project,
        rule: swept,
        retention: sweepRetention,
        liveGuard: recentActivity(now),
        userContent: joined.some((member) => member.userContent),
        protection: "none",
        removal: { method: "trash" },
        sensitive: true,
        label: sessionLabel(id8),
      });
    }
    for (const member of members) {
      if (claimed.has(member.path)) continue;
      await cacheEntity(scan, {
        paths: [member.path],
        cacheKind: member.cacheKind,
        unit: member.unit,
        session: member.sid,
        slug: slug.slug,
        project,
        // D118: a member no chat file claims is undocumented, not swept.
        rule: "undocumented",
        retention: sweepRetention,
        liveGuard: recentActivity(now),
        userContent: member.userContent,
        protection: "none",
        removal: { method: "trash" },
        sensitive: true,
      });
    }
    for (const [name, kind, rule, sensitive, userContent] of [
      ["checkpoints", "checkpoint", "undocumented", false, false],
      ["shell_history", "log", "kept", true, false],
      [".project_root", "undocumented", "kept", false, false],
    ] as const) {
      const path = join(slug.dir, name);
      const stats = await treeStats(path);
      if (stats.files === 0 && !(await isDirectory(path))) continue;
      const dir = await isDirectory(path);
      await cacheEntity(scan, {
        paths: [path],
        cacheKind: kind,
        unit: dir ? "dir" : "file",
        session: null,
        slug: slug.slug,
        project,
        rule,
        retention: none,
        liveGuard: rule === "undocumented" ? recentActivity(now) : null,
        userContent,
        protection: "none",
        removal: { method: "trash" },
        sensitive,
      });
    }
    for (const entry of (await listDir(slug.dir)).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const path = join(slug.dir, entry.name);
      if (SLUG_KNOWN.has(entry.name) || (entry.isDirectory() && SESSION_ID.test(entry.name)))
        continue;
      if (/^checkpoint-.+\.json$/.test(entry.name)) {
        // A tagged checkpoint is the user's own saved state: kept, Delete only.
        await cacheEntity(scan, {
          paths: [path],
          cacheKind: "checkpoint",
          unit: "file",
          session: null,
          slug: slug.slug,
          project,
          rule: "kept",
          retention: none,
          liveGuard: null,
          userContent: true,
          protection: "none",
          removal: { method: "trash" },
          sensitive: true,
        });
        continue;
      }
      // Anything else directly under a slug directory is a size-only row (08 cross-harness rules).
      await cacheEntity(scan, {
        paths: [path],
        cacheKind: "undocumented",
        unit: entry.isDirectory() ? "dir" : "file",
        session: null,
        slug: slug.slug,
        project,
        rule: "undocumented",
        retention: none,
        liveGuard: null,
        userContent: false,
        protection: "undocumented",
        removal: { method: "none" },
        sensitive: false,
      });
    }
    // The legacy log file the docs name but describe no sweep for.
    const legacyLog = join(slug.dir, "logs.json");
    if ((await treeStats(legacyLog)).files > 0) {
      await cacheEntity(scan, {
        paths: [legacyLog],
        cacheKind: "log",
        unit: "file",
        session: null,
        slug: slug.slug,
        project,
        rule: "undocumented",
        retention: none,
        liveGuard: null,
        userContent: false,
        protection: "undocumented",
        removal: { method: "none" },
        sensitive: false,
      });
    }
  }

  // `tmp/bin/` and `tmp/background-processes/`: never slug directories, never swept.
  const binDir = join(scan.paths.tmpDir, "bin");
  if (await isDirectory(binDir)) {
    await cacheEntity(scan, {
      paths: [binDir],
      cacheKind: "undocumented",
      unit: "dir",
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
  const background = join(scan.paths.tmpDir, "background-processes");
  for (const entry of (await listDir(background)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile()) continue;
    await cacheEntity(scan, {
      paths: [join(background, entry.name)],
      cacheKind: "log",
      unit: "file",
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

  // D55: the rotating backup next to the live settings file — tickable, never preselected.
  const orig = join(scan.paths.geminiDir, "settings.json.orig");
  if ((await treeStats(orig)).files > 0) {
    await cacheEntity(scan, {
      paths: [orig],
      cacheKind: "config-backup",
      unit: "file",
      session: null,
      slug: null,
      project: null,
      rule: "undocumented",
      retention: none,
      liveGuard: null,
      userContent: false,
      protection: "none",
      removal: { method: "trash" },
      sensitive: true,
    });
  }

  // D121: Antigravity's own state lives under `~/.gemini` but is not Gemini CLI's. One size-only
  // row each; nothing below is read, so its skills and `mcp_config.json` never become entities.
  for (const name of ["antigravity", "antigravity-browser-profile"]) {
    const path = join(scan.paths.geminiDir, name);
    if (!(await isDirectory(path))) continue;
    await cacheEntity(scan, {
      paths: [path],
      cacheKind: "undocumented",
      unit: "dir",
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
      // D121 asks for `surface: null`; index v0 freezes `producer.surface` as a `Surface`, so the
      // IDE surface ticket 08 §1 names is what the row can carry until 07 is amended.
      producer: { harness: "other-app", surface: "ide" },
    });
  }
}
