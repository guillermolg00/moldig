import { mkdir, readdir, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit, scan } from "../../index.js";
import type {
  AuditIndex,
  Breadcrumb,
  Entity,
  HarnessCache,
  Index,
  LoadedByEdge,
} from "../../index/types.js";
import { loadFixture, normaliseSnapshot, type FixtureTree } from "../../testing/index.js";

/** After the fixture's synthetic timestamps (2023-11-14); `ages` are relative to it. */
const NOW = new Date("2026-08-26T12:00:00.000Z");
const ISO_ANYWHERE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const DATE_ANYWHERE = /(?<![\dT:-])\d{4}-\d{2}-\d{2}(?![\dT])/g;
const THREE_DAYS_MS = 3 * 86_400_000;
const PLATFORM = "darwin";
const DB = "home/.local/share/opencode/opencode.db";

let tree: FixtureTree;
let result: AuditIndex;
let before: Map<string, number>;
let after: Map<string, number>;

/** Ids fold the path part; the `#keyPath` suffix keeps its raw casing (ticket 07). */
const id = (kind: string, path: string): string => {
  const hash = path.indexOf("#");
  const file = hash === -1 ? path : path.slice(0, hash);
  const keyPath = hash === -1 ? "" : path.slice(hash);
  return `${kind}:${file.toLowerCase()}${keyPath}`;
};
const home = (rel: string): string => `${tree.home}/${rel}`;
const root = (rel: string): string => `${tree.root}/${rel}`;
const config = (rel: string): string => home(`.config/opencode/${rel}`);
const database = (): string => home(".local/share/opencode/opencode.db");
const sessionId = (session: string): string =>
  id("harness-cache", `${database()}#session/id/${session}`);

function entity(kind: string, path: string): Entity {
  const found = result.entities.find((item) => item.id === id(kind, path));
  if (found === undefined) throw new Error(`entity not found: ${id(kind, path)}`);
  return found;
}

function cacheUnit(path: string): HarnessCache {
  const found = entity("harness-cache", path);
  if (found.kind !== "harness-cache") throw new Error("kind");
  return found;
}

function loadedBy(kind: string, path: string, project?: string): LoadedByEdge {
  const from = id(kind, path);
  const edge = result.edges.find(
    (item) =>
      item.kind === "loaded-by" &&
      item.from === from &&
      item.to === "harness:opencode" &&
      (project === undefined || item.project === project),
  );
  if (edge === undefined || edge.kind !== "loaded-by")
    throw new Error(`loaded-by edge not found for ${from}`);
  return edge;
}

function crumb(predicate: (crumb: Breadcrumb) => boolean): Breadcrumb {
  const found = result.breadcrumbs.find(predicate);
  if (found === undefined) throw new Error("breadcrumb not found");
  return found;
}

/* oxlint-disable no-await-in-loop -- a depth-first listing of a tiny fixture tree */
/** Every file below `dir` with its mtime, so a scan that wrote anything is detectable. */
async function mtimes(
  dir: string,
  base = dir,
  out = new Map<string, number>(),
): Promise<Map<string, number>> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await mtimes(path, base, out);
      continue;
    }
    const stats = await stat(path).catch(() => null);
    out.set(relative(base, path), stats?.mtimeMs ?? -1);
  }
  return out;
}

/** Copy-time stamps differ per run; stamps derived from `NOW` lie on its whole-day grid. */
function stableTimes(json: string): string {
  const now = Date.now();
  return json
    .replaceAll(ISO_ANYWHERE, (stampText) => {
      const ms = Date.parse(stampText);
      const onGrid = (NOW.getTime() - ms) % 86_400_000 === 0;
      return !onGrid && Math.abs(ms - now) < THREE_DAYS_MS ? "<COPY-TIME>" : stampText;
    })
    .replaceAll(DATE_ANYWHERE, (date) =>
      Math.abs(Date.parse(`${date}T00:00:00.000Z`) - now) < THREE_DAYS_MS ? "<COPY-DATE>" : date,
    );
}

/** JSON in the shape the repo's formatter keeps (`oxfmt --check` runs over `__snapshots__`). */
function formattedJson(value: unknown, indent = "", prefix = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = indent + "  ";
    const primitives = value.every((item) => typeof item !== "object" || item === null);
    if (primitives) {
      const line = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
      if (prefix + indent.length + line.length <= 100) return line;
    }
    return `[\n${value.map((item) => inner + formattedJson(item, inner)).join(",\n")}\n${indent}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const inner = indent + "  ";
    const lines = entries.map(([key, item]) => {
      const head = `${JSON.stringify(key)}: `;
      return `${inner}${head}${formattedJson(item, inner, head.length)}`;
    });
    return `{\n${lines.join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

async function scanTree(
  fixture: FixtureTree,
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Index> {
  return scan({
    home: fixture.home,
    roots: fixture.roots,
    cwd: options.cwd ?? fixture.cwd,
    platform: PLATFORM,
    env: options.env ?? fixture.env,
    git: false,
    now: NOW,
  });
}

beforeAll(async () => {
  tree = await loadFixture("opencode/db-and-config", { now: NOW, platform: PLATFORM });
  before = await mtimes(tree.dir);
  result = await audit(await scanTree(tree));
  after = await mtimes(tree.dir);
});

afterAll(async () => {
  await tree.cleanup();
});

describe("opencode adapter over the db-and-config case", () => {
  it("describes the harness from what it wrote to disk", () => {
    const harness = result.harnesses.find((item) => item.harness === "opencode");
    expect(harness?.id).toBe("harness:opencode");
    expect(harness?.presence).toBe("installed");
    // §0: the newest `session` row's `version` column — no binary is run.
    expect(harness?.version).toBe("1.17.9");
    expect(harness?.effectiveModel).toBeNull();
    expect(harness?.modelFamily).toBeNull();
    expect(harness?.contextWindowTokens).toBeNull();
    expect(harness?.capabilities).toEqual({
      memoryLocation: "none",
      memoryReadSignal: "not-applicable",
      contextFileNames: ["AGENTS.md", "CLAUDE.md"],
      sweepDocumented: false,
    });
    expect(Object.values(harness?.caps ?? {}).every((value) => value === null)).toBe(true);
    expect(harness?.breadcrumbSources).toEqual([
      { kind: "project-row", path: database(), readInV1: true },
      {
        kind: "legacy-project-record",
        path: home(".local/share/opencode/storage/project"),
        readInV1: true,
      },
      { kind: "workspace-record", path: database(), readInV1: false },
      { kind: "session-cwd", path: database(), readInV1: false },
    ]);
    expect(harness?.userScope.paths.map((item) => item.path)).toEqual([
      home(".config/opencode"),
      home(".local/share/opencode"),
      home(".cache/opencode"),
      home(".local/state/opencode"),
    ]);
    expect(harness?.userScope.paths.every((item) => item.source === "default")).toBe(true);
    expect(result.scan.env).toEqual({});
    // The lock declares `version: 1` with v3 entry keys: reported, never guessed at.
    expect(result.warnings.map((item) => [item.code, item.harness])).toEqual([
      ["git-missing", null],
      ["unsupported-shape", "opencode"],
    ]);
    expect(result.warnings[1]?.path).toBe(home(".agents/.skill-lock.json"));
    expect(
      result.entities.some(
        (item) => item.path === home(".agents/.skill-lock.json") && item.harness === "opencode",
      ),
    ).toBe(false);
  });

  it("turns every project row and legacy record into a breadcrumb, one per distinct worktree", () => {
    const rows = result.breadcrumbs.filter((item) => item.kind === "project-row");
    const legacy = result.breadcrumbs.filter((item) => item.kind === "legacy-project-record");
    expect(rows).toHaveLength(4);
    expect(legacy).toHaveLength(2);
    expect(rows.every((item) => item.occurrences.count === 1)).toBe(true);
    const projectA = crumb((item) => item.kind === "project-row" && item.raw === root("project-a"));
    expect(projectA.locator).toEqual({
      type: "sqlite",
      file: database(),
      table: "project",
      keyColumn: "id",
      keyValue: "1111111111111111111111111111111111111111",
    });
    expect(projectA.resolution).toBe("direct");
    expect(projectA.project).toBe(id("project", root("project-a")));
    expect(projectA.refs.projectId).toBe("1111111111111111111111111111111111111111");
    expect(projectA.occurrences.first).toBe("2023-09-15T22:13:20.000Z");
    expect(projectA.state).toEqual([
      sessionId("ses_synthetic0001"),
      sessionId("ses_synthetic0002"),
    ]);
    // Edge case 1: the ghost worktree is an orphan Project, `~` and `/` are stray.
    const gone = crumb((item) => item.raw === root("gone"));
    expect(gone.reachability).toBe("orphan");
    expect(gone.project).toBe(id("project", root("gone")));
    expect(gone.state).toEqual([sessionId("ses_synthetic0003")]);
    const homeRow = crumb((item) => item.kind === "project-row" && item.raw === tree.home);
    const slashRow = crumb((item) => item.kind === "project-row" && item.raw === "/");
    expect(homeRow.project).toBeNull();
    expect(homeRow.strayReason).toBe("bare-directory");
    expect(slashRow.refs.projectId).toBe("global");
    expect(slashRow.strayReason).toBe("bare-directory");
    const harness = result.harnesses.find((item) => item.harness === "opencode");
    expect(harness?.userScope.stray).toContain(homeRow.id);
    expect(harness?.userScope.stray).toContain(slashRow.id);
    // Edge case 4: a legacy record whose id is also a database row is a second breadcrumb.
    const legacyA = crumb(
      (item) => item.kind === "legacy-project-record" && item.raw === root("project-a"),
    );
    expect(legacyA.locator).toEqual({
      type: "file",
      path: home(
        ".local/share/opencode/storage/project/1111111111111111111111111111111111111111.json",
      ),
    });
    expect(legacyA.state).toEqual([id("harness-cache", home(".local/share/opencode/storage"))]);
    expect(
      result.projects.find((item) => item.id === id("project", root("project-a")))?.breadcrumbs,
    ).toEqual([projectA.id, legacyA.id]);
    // Edge case 2/3: `project_directory`, `session.directory` and `workspace` are never read.
    expect(result.breadcrumbs.some((item) => item.kind === "session-cwd")).toBe(false);
    expect(result.breadcrumbs.some((item) => item.raw.endsWith("packages/api"))).toBe(false);
    expect(result.projects.every((item) => item.perHarness["opencode"]?.trusted !== true)).toBe(
      true,
    );
  });

  it("models every session row as a kept unit with a sqlite locator and the permanent delegate", () => {
    for (const session of ["0001", "0002", "0003", "0004"]) {
      const unit = cacheUnit(`${database()}#session/id/ses_synthetic${session}`);
      expect(unit.metrics.bytes).toBe(0);
      expect(unit.metrics.files).toBeNull();
      expect(unit.rule).toBe("kept");
      expect(unit.unit).toBe("session");
      expect(unit.cacheKind).toBe("transcript");
      expect(unit.protection).toBe("none");
      expect(unit.locator).toEqual({
        type: "sqlite",
        file: database(),
        table: "session",
        keyColumn: "id",
        keyValue: `ses_synthetic${session}`,
      });
      expect(unit.removal).toEqual({
        method: "delegate",
        command: `opencode session delete ses_synthetic${session}`,
      });
      expect(unit.liveGuard).toEqual({ kind: "recent-activity", alive: false });
      expect(unit.members.bytes).toBe(0);
    }
    // Edge case 2: a child session says so; edge case 3: an archived one too.
    expect(cacheUnit(`${database()}#session/id/ses_synthetic0002`).label).toBe(
      "session ses_synthetic0002 · 2023-11-14 · child of ses_synthetic0001",
    );
    expect(cacheUnit(`${database()}#session/id/ses_synthetic0004`).label).toBe(
      "session ses_synthetic0004 · 2023-10-15 · archived",
    );
    // A session of a stray project row belongs to no Project; one of a ghost row to the orphan.
    expect(cacheUnit(`${database()}#session/id/ses_synthetic0004`).project).toBeNull();
    expect(cacheUnit(`${database()}#session/id/ses_synthetic0003`).project).toBe(
      id("project", root("gone")),
    );
    // D111: a `kept` unit never enters a clean group.
    expect(
      result.findings.some(
        (finding) =>
          finding.category === "harness-cache" &&
          finding.id.endsWith(":transcript") &&
          finding.targets.some((target) => target.id === sessionId("ses_synthetic0001")),
      ),
    ).toBe(false);
    const orphan = result.findings.find(
      (finding) => finding.id === `finding:orphan:${id("project", root("gone"))}`,
    );
    expect(orphan?.targets.map((target) => target.id)).toContain(sessionId("ses_synthetic0003"));
  });

  it("keeps the database itself untouched and every other directory as its documented row", () => {
    const db = cacheUnit(database());
    expect(db.cacheKind).toBe("database");
    expect(db.unit).toBe("database");
    // Only the sidecar the fixture ships is listed; none is ever created.
    expect(db.locator).toEqual({
      type: "paths",
      paths: [database(), `${database()}-wal`],
    });
    // D104: a database is `kept` + `never` + no removal, for every harness.
    expect(db.rule).toBe("kept");
    expect(db.protection).toBe("never");
    expect(db.removal).toEqual({ method: "none" });
    expect(db.sensitive).toBe(true);
    const storage = cacheUnit(home(".local/share/opencode/storage"));
    expect([storage.cacheKind, storage.unit, storage.rule]).toEqual([
      "transcript",
      "dir",
      "undocumented",
    ]);
    expect(storage.removal).toEqual({ method: "trash" });
    expect(storage.liveGuard).toBeNull();
    expect(storage.metrics.ageDays).toBe(155);
    expect(storage.metrics.files).toBe(4);
    const log = cacheUnit(home(".local/share/opencode/log"));
    expect([log.cacheKind, log.rule, log.protection]).toEqual(["log", "undocumented", "none"]);
    expect(log.removal).toEqual({ method: "trash" });
    for (const rel of [
      ".local/share/opencode/bin",
      ".local/share/opencode/repos",
      ".local/share/opencode/snapshot",
      ".local/share/opencode/tool-output",
      ".config/opencode/context-mode",
      ".cache/opencode",
    ]) {
      const unit = cacheUnit(home(rel));
      expect([unit.cacheKind, unit.rule, unit.protection]).toEqual([
        "undocumented",
        "undocumented",
        "undocumented",
      ]);
      expect(unit.removal).toEqual({ method: "none" });
    }
    // `storage/{part,session_diff,migration}` are members of the one storage unit, not rows.
    expect(result.entities.some((item) => item.path.endsWith("/storage/part"))).toBe(false);
  });

  it("reads the database read-only: no sidecar appears and no mtime changes", () => {
    expect([...after.keys()].toSorted()).toEqual([...before.keys()].toSorted());
    expect([...after].filter(([path, mtime]) => before.get(path) !== mtime)).toEqual([]);
    expect(after.has("home/.local/share/opencode/opencode.db-shm")).toBe(false);
    expect(after.has("home/.local/share/opencode/opencode.db-wal")).toBe(true);
  });

  it("gives the AGENTS.md walk, the CLAUDE.md fallback and instructions[] their verdicts", () => {
    // Rule 1: the user file is the baseline; `~/.claude/CLAUDE.md` is absent, so no fallback edge.
    expect(loadedBy("context-file", config("AGENTS.md"))).toMatchObject({
      project: null,
      mode: "full",
      order: 0,
      countsTowardHeadline: true,
      reason: "user rules: read in every session",
    });
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "loaded-by" && edge.from === id("context-file", home(".claude/CLAUDE.md")),
      ),
    ).toBe(false);
    // Rule 3: a relative glob and an absolute path naming one file are one entity and one edge.
    expect(loadedBy("context-file", config("rules/rule-a.md")).order).toBe(1);
    expect(loadedBy("context-file", config("style.md"))).toMatchObject({
      order: 2,
      reason: "listed in instructions[] of ~/.config/opencode/opencode.json",
    });
    const rules = result.edges.filter(
      (edge) =>
        edge.kind === "loaded-by" &&
        edge.from === id("context-file", root("project-a/docs/rules.md")) &&
        edge.to === "harness:opencode",
    );
    expect(rules).toHaveLength(1);
    const projectA = id("project", root("project-a"));
    expect(loadedBy("context-file", root("project-a/AGENTS.md"), projectA)).toMatchObject({
      mode: "full",
      order: 0,
      reason: "AGENTS.md of the project root",
      countsTowardHeadline: true,
    });
    expect(loadedBy("context-file", root("project-a/docs/rules.md"), projectA)).toMatchObject({
      mode: "full",
      order: 1,
      reason: "listed in instructions[] of opencode.json",
    });
    const instructions = entity("context-file", root("project-a/docs/rules.md"));
    expect(instructions.kind === "context-file" && instructions.form).toBe("instructions");
    // A file below the session directory only costs sessions started there.
    expect(
      loadedBy("context-file", root("project-a/packages/api/AGENTS.md"), projectA),
    ).toMatchObject({
      mode: "full",
      order: null,
      countsTowardHeadline: false,
      reason: "loaded by sessions started in packages/api",
    });
    // Edge case 8: project-b has no AGENTS.md, so its CLAUDE.md is the per-walk fallback (D62).
    const projectB = id("project", root("project-b"));
    expect(loadedBy("context-file", root("project-b/CLAUDE.md"), projectB)).toMatchObject({
      mode: "full",
      order: 0,
      reason: "fallback: no AGENTS.md between the session directory and the project root",
    });
    const fallbackFile = entity("context-file", root("project-b/CLAUDE.md"));
    expect(fallbackFile.kind === "context-file" && fallbackFile.form).toBe("context");
    expect(loadedBy("context-file", root("project-b/CONTRIBUTING.md"), projectB)).toMatchObject({
      mode: "full",
      order: 1,
      reason: "listed in instructions[] of opencode.jsonc",
    });
    // Edge case 6: the payload of a skill is never a context file.
    expect(
      result.entities.some((item) => item.kind === "context-file" && item.path.includes("/skill/")),
    ).toBe(false);
  });

  it("keeps one Skill per real directory and records every path that reaches it", () => {
    // Edge case 5: both generations at user scope; the symlink and the store are placements.
    const findSkills = entity("skill", home(".agents/skills/find-skills"));
    if (findSkills.kind !== "skill") throw new Error("kind");
    expect(findSkills.harness).toBeNull();
    expect(findSkills.layout).toBe("canonical");
    expect(findSkills.placements.map((item) => [item.path, item.harness, item.isSymlink])).toEqual([
      [home(".agents/skills/find-skills"), null, false],
      [config("skills/find-skills"), "opencode", true],
    ]);
    expect(findSkills.placements[1]?.linkTarget).toBe("../../../.agents/skills/find-skills");
    expect(loadedBy("skill", home(".agents/skills/find-skills"))).toMatchObject({
      mode: "description-only",
      reason: "user skill",
      effectiveName: "find-skills",
      countsTowardHeadline: true,
    });
    const copy = entity("skill", config("skill/web-design-guidelines"));
    if (copy.kind !== "skill") throw new Error("kind");
    expect(copy.metrics.ageDays).toBe(200);
    expect(copy.origin).toBeNull();
    expect(copy.drift).toBe("unknown");
    expect(copy.sidecars).toEqual([]);
    // Edge case 6: the 64 KB AGENTS.md payload is bytes, not context.
    const payload = entity("skill", config("skill/vercel-react-best-practices"));
    expect(payload.metrics.files).toBe(6);
    expect(payload.metrics.bytes).toBeGreaterThan(64_000);
    // Edge case 7: three real copies of one name, identical bytes.
    const copies = new Set(
      [
        config("skill/web-design-guidelines"),
        root("project-a/.opencode/skill/web-design-guidelines"),
        root("project-a/.claude/skills/web-design-guidelines"),
      ].map((path) => id("skill", path)),
    );
    const duplicates = result.edges.filter(
      (edge) => edge.kind === "duplicates" && copies.has(edge.from),
    );
    expect(duplicates).toHaveLength(3);
    expect(
      duplicates.every(
        (edge) =>
          edge.kind === "duplicates" && edge.same === "content" && edge.confidence === "certain",
      ),
    ).toBe(true);
    // The `.claude/skills` copy carries both adapters' placements after the scan merge (D38).
    const shared = entity("skill", root("project-a/.claude/skills/web-design-guidelines"));
    if (shared.kind !== "skill") throw new Error("kind");
    expect(
      shared.placements.map((item) => item.harness ?? "").toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(["claude-code", "opencode"]);
    expect(shared.shared).toBeNull();
    expect(loadedBy("skill", root("project-a/.opencode/skills/skill-a"))).toMatchObject({
      mode: "description-only",
      reason: "project skill",
    });
    expect(
      result.projects.find((item) => item.id === id("project", root("project-a")))?.perHarness[
        "opencode"
      ]?.effectiveSettings,
    ).toMatchObject({ permission: { skill: "allow" } });
  });

  it("shadows the user agent and command with the project ones and never counts them", () => {
    const userAgent = id("agent-definition", config("agents/agent-a.md"));
    const projectAgent = id("agent-definition", root("project-a/.opencode/agents/agent-a.md"));
    // D39: an agent definition is spawned on demand and never enters the Headline number.
    expect(loadedBy("agent-definition", config("agents/agent-a.md"))).toMatchObject({
      mode: "on-demand",
      countsTowardHeadline: false,
      confidence: "medium",
    });
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "shadows" &&
          edge.from === projectAgent &&
          edge.to === userAgent &&
          edge.rule === "project > user",
      ),
    ).toBe(true);
    // D136: the user entity keeps its baseline verdict and gains a per-Project `shadowed` one.
    expect(
      loadedBy("agent-definition", config("agents/agent-a.md"), id("project", root("project-a")))
        .mode,
    ).toBe("shadowed");
    expect(loadedBy("skill", config("commands/command-a.md"))).toMatchObject({
      mode: "manual",
      effectiveName: "/command-a",
      tokensLoaded: 0,
      countsTowardHeadline: false,
    });
    expect(entity("skill", config("commands/command-a.md")).kind).toBe("skill");
  });

  it("maps the mcp entries of every layer and leaves the config files themselves alone", () => {
    const local = entity("mcp-server", `${config("opencode.json")}#mcp/server-local`);
    const remote = entity("mcp-server", `${config("opencode.json")}#mcp/server-remote`);
    const project = entity("mcp-server", `${root("project-a/opencode.json")}#mcp/project-server`);
    if (
      local.kind !== "mcp-server" ||
      remote.kind !== "mcp-server" ||
      project.kind !== "mcp-server"
    )
      throw new Error("kind");
    expect(local.transport).toBe("stdio");
    expect(local.command).toBe("<redacted>");
    expect(local.args).toEqual(["<redacted>"]);
    expect(local.envKeys).toEqual(["EXAMPLE_VAR"]);
    expect(local.rawKeys).toEqual(["type", "command", "cwd", "environment", "enabled"]);
    expect(local.approval).toBe("not-applicable");
    expect(remote.transport).toBe("remote");
    expect(remote.headerKeys).toEqual(["Authorization"]);
    expect(remote.secretKeys).toEqual(["Authorization"]);
    expect(remote.sensitive).toBe(true);
    expect(project.scope).toBe("project");
    expect(project.shared).toBeNull();
    for (const server of [local, remote, project]) {
      expect(server.removal).toEqual({ method: "backup-edit" });
      expect(loadedBy("mcp-server", `${server.path}#mcp/${server.name}`).mode).toBe("full");
    }
    // D142: a settings file is never deleted; its entries are.
    const userConfig = entity("settings-file", config("opencode.json"));
    if (userConfig.kind !== "settings-file") throw new Error("kind");
    expect(userConfig.role).toBe("settings");
    expect(userConfig.entries).toBe(2);
    expect(userConfig.topLevelKeys).toEqual(["$schema", "mcp", "instructions"]);
    expect(userConfig.protection).toBe("never");
    expect(userConfig.removal).toEqual({ method: "none" });
    // Edge case 8: JSONC with a comment and a trailing comma parses.
    const jsonc = entity("settings-file", root("project-b/opencode.jsonc"));
    if (jsonc.kind !== "settings-file") throw new Error("kind");
    expect(jsonc.format).toBe("jsonc");
    expect(jsonc.entries).toBe(0);
    expect(jsonc.topLevelKeys).toEqual(["$schema", "instructions"]);
    expect(result.warnings.some((item) => item.code === "parse-error")).toBe(false);
    // Edge case 9: the plugin workspace is a harness-owned manifest, its lockfiles nothing (D62).
    for (const path of [config("package.json"), root("project-a/.opencode/package.json")]) {
      const manifest = entity("settings-file", path);
      if (manifest.kind !== "settings-file") throw new Error("kind");
      expect(manifest.role).toBe("manifest");
      expect(manifest.ownership).toBe("harness");
      expect(manifest.entries).toBe(1);
    }
    for (const name of ["bun.lock", "package-lock.json", ".gitignore"]) {
      expect(result.entities.some((item) => item.path.endsWith(`/${name}`))).toBe(false);
    }
    // Edge case 9: `~/.config/opencode` carries markers but is never a Project.
    expect(result.projects.some((item) => item.path.includes("/.config/"))).toBe(false);
    expect(result.projects.map((item) => item.id)).toEqual([
      id("project", root("gone")),
      id("project", root("project-a")),
      id("project", root("project-b")),
    ]);
  });

  it("re-orders the chain when the session starts in a subdirectory", async () => {
    const index = await scanTree(tree, { cwd: root("project-a/packages/api") });
    const projectA = id("project", root("project-a"));
    const edges = index.edges.filter(
      (edge): edge is LoadedByEdge =>
        edge.kind === "loaded-by" && edge.to === "harness:opencode" && edge.project === projectA,
    );
    const chain = edges
      .filter((edge) => edge.order !== null)
      .toSorted((a, b) => (a.order ?? 0) - (b.order ?? 0));
    // D62: root-first, so the session directory's own AGENTS.md comes second.
    expect(chain.slice(0, 2).map((edge) => [edge.from, edge.reason])).toEqual([
      [id("context-file", root("project-a/AGENTS.md")), "AGENTS.md of the project root"],
      [
        id("context-file", root("project-a/packages/api/AGENTS.md")),
        "AGENTS.md of the session directory",
      ],
    ]);
    expect(
      index.projects.find((item) => item.id === projectA)?.perHarness["opencode"]?.sessionLoad
        .items[1]?.entity,
    ).toBe(id("context-file", root("project-a/packages/api/AGENTS.md")));
  });

  it("moves the user scope with OPENCODE_CONFIG and changes nothing else", async () => {
    const extra = tree.path("home/.config/opencode/extra.json");
    const index = await scanTree(tree, { env: { OPENCODE_CONFIG: extra } });
    expect(index.scan.env).toEqual({ OPENCODE_CONFIG: extra });
    const harness = index.harnesses.find((item) => item.harness === "opencode");
    expect(harness?.userScope.paths.at(-1)).toEqual({
      path: extra,
      role: "config",
      source: "env",
      envVar: "OPENCODE_CONFIG",
    });
    expect(index.entities.map((item) => item.id)).toEqual(result.entities.map((item) => item.id));
    expect(index.edges.map((item) => item.id)).toEqual(result.edges.map((item) => item.id));
    expect(index.breadcrumbs.map((item) => item.id)).toEqual(
      result.breadcrumbs.map((item) => item.id),
    );
    expect(index.warnings.map((item) => item.code)).toEqual(
      result.warnings.map((item) => item.code),
    );
  });

  it("matches the audit snapshot", async () => {
    const stable = normaliseSnapshot(result, tree);
    stable.scan.durationMs = 0;
    await expect(stableTimes(formattedJson(stable) + "\n")).toMatchFileSnapshot(
      "./__snapshots__/db-and-config.audit.json",
    );
  });
});

describe("opencode adapter with an unreadable database", () => {
  it("files exactly one sqlite-unreadable warning and still reads the configuration", async () => {
    const broken = await loadFixture("opencode/db-and-config", { now: NOW, platform: PLATFORM });
    try {
      await truncate(broken.path(DB), 0);
      const index = await scanTree(broken);
      const unreadable = index.warnings.filter((item) => item.code === "sqlite-unreadable");
      expect(unreadable).toHaveLength(1);
      expect(unreadable[0]?.harness).toBe("opencode");
      expect(unreadable[0]?.path).toBe(broken.path(DB));
      // The configuration side of the harness still ran.
      expect(
        index.entities.some(
          (item) =>
            item.kind === "mcp-server" &&
            item.path === `${broken.home}/.config/opencode/opencode.json`,
        ),
      ).toBe(true);
      // No session rows, no project-row breadcrumbs; the legacy records still resolve.
      expect(
        index.entities.some((item) => item.kind === "harness-cache" && item.unit === "session"),
      ).toBe(false);
      expect(index.breadcrumbs.map((item) => item.kind)).toEqual([
        "legacy-project-record",
        "legacy-project-record",
      ]);
      expect(index.harnesses.find((item) => item.harness === "opencode")?.version).toBeNull();
    } finally {
      await broken.cleanup();
    }
  });
});

describe("opencode adapter over the branches the fixture does not carry", () => {
  it("warns about an inline configuration and a URL instruction, and records neither as a file", async () => {
    const extra = await loadFixture("opencode/db-and-config", { now: NOW, platform: PLATFORM });
    try {
      const file = extra.path("home/.config/opencode/extra.json");
      await writeFile(
        file,
        JSON.stringify({ instructions: ["https://example.com/rules.md", "style.md"] }),
      );
      const index = await scanTree(extra, {
        env: { OPENCODE_CONFIG: file, OPENCODE_CONFIG_CONTENT: '{"model":"x/y"}' },
      });
      const shapes = index.warnings.filter((item) => item.code === "unsupported-shape");
      expect(shapes.map((item) => item.message).toSorted((a, b) => (a < b ? -1 : 1))).toEqual([
        ".skill-lock.json declares version 1 with version-3 entry keys: skill origins are not read",
        "OPENCODE_CONFIG_CONTENT holds inline configuration: not read",
        "instructions entry is a URL: not fetched",
      ]);
      // D110: `scan.env` carries only the overrides moldig honoured — never the inline one.
      expect(index.scan.env).toEqual({ OPENCODE_CONFIG: file });
      expect(index.entities.some((item) => item.path.includes("example.com"))).toBe(false);
      // The relative entry resolved against the extra file's own directory.
      expect(
        index.entities.some((item) => item.path === `${extra.home}/.config/opencode/style.md`),
      ).toBe(true);
    } finally {
      await extra.cleanup();
    }
  });

  it("disables the skills of a Project whose permission.skill is deny", async () => {
    const denied = await loadFixture("opencode/db-and-config", { now: NOW, platform: PLATFORM });
    try {
      const path = denied.path("root/project-a/opencode.json");
      const data = (await readFile(path, "utf8")).replace('"skill": "allow"', '"skill": "deny"');
      await writeFile(path, data);
      const index = await scanTree(denied);
      const projectA = `project:${`${denied.root}/project-a`.toLowerCase()}`;
      const verdicts = index.edges.filter(
        (edge): edge is LoadedByEdge =>
          edge.kind === "loaded-by" &&
          edge.to === "harness:opencode" &&
          edge.project === projectA &&
          edge.from.includes("skills/skill-a"),
      );
      expect(verdicts).toHaveLength(1);
      expect(verdicts[0]).toMatchObject({
        mode: "disabled",
        reason: "permission.skill: deny",
        tokensLoaded: 0,
        countsTowardHeadline: false,
        order: null,
      });
    } finally {
      await denied.cleanup();
    }
  });

  it("falls back to ~/.claude/CLAUDE.md only when the user AGENTS.md is absent and the switch is unset", async () => {
    const compat = await loadFixture("opencode/db-and-config", { now: NOW, platform: PLATFORM });
    try {
      const fallback = compat.path("home/.claude/CLAUDE.md");
      await mkdir(dirname(fallback), { recursive: true });
      await writeFile(fallback, "- user rules\n");
      const fallbackId = `context-file:${fallback.toLowerCase()}`;
      const verdict = (index: Index): LoadedByEdge => {
        const edge = index.edges.find(
          (item) =>
            item.kind === "loaded-by" && item.from === fallbackId && item.to === "harness:opencode",
        );
        if (edge === undefined || edge.kind !== "loaded-by") throw new Error("no fallback edge");
        return edge;
      };
      // Both present: the OpenCode file wins and the Claude one is never read.
      expect(verdict(await scanTree(compat))).toMatchObject({
        mode: "never",
        reason: "not read: ~/.config/opencode/AGENTS.md takes precedence",
        tokensLoaded: 0,
      });
      // The documented switch turns the compatibility off whatever else exists.
      expect(
        verdict(await scanTree(compat, { env: { OPENCODE_DISABLE_CLAUDE_CODE: "1" } })),
      ).toMatchObject({ mode: "never", reason: "OPENCODE_DISABLE_CLAUDE_CODE is set" });
      // Without the OpenCode file the Claude one is the baseline.
      await rm(compat.path("home/.config/opencode/AGENTS.md"));
      expect(verdict(await scanTree(compat))).toMatchObject({
        mode: "full",
        order: 0,
        reason: "fallback: no ~/.config/opencode/AGENTS.md (Claude Code compat)",
        countsTowardHeadline: true,
      });
    } finally {
      await compat.cleanup();
    }
  });
});
