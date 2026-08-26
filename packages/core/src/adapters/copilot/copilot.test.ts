import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit, scan } from "../../index.js";
import type {
  AgentDefinition,
  AuditIndex,
  Breadcrumb,
  Entity,
  HarnessCache,
  LoadedByEdge,
  McpServer,
  Skill,
} from "../../index/types.js";
import { loadFixture, normaliseSnapshot, type FixtureTree } from "../../testing/index.js";

/** After the case's synthetic timestamps (2023-11-14); its `ages` are relative to it. */
const NOW = new Date("2026-08-26T12:00:00.000Z");
const SESSION_A = "00000000-0000-4000-8000-000000000001";
const SESSION_GONE = "00000000-0000-4000-8000-000000000002";
const SESSION_SUBDIR = "00000000-0000-4000-8000-000000000003";
const STORAGE = ["1", "2", "3", "4"].map((digit) => digit.repeat(32));
const ISO_ANYWHERE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const DATE_ANYWHERE = /(?<![\dT:-])\d{4}-\d{2}-\d{2}(?![\dT])/g;
const THREE_DAYS_MS = 3 * 86_400_000;
/** Copilot has no path-derived slug directories, so the scan is pinned to one platform. */
const PLATFORM = "darwin";

let tree: FixtureTree;
let result: AuditIndex;

const id = (kind: string, path: string): string => {
  const hash = path.indexOf("#");
  const file = hash === -1 ? path : path.slice(0, hash);
  const keyPath = hash === -1 ? "" : path.slice(hash);
  return `${kind}:${file.toLowerCase()}${keyPath}`;
};
const home = (rel: string): string => `${tree.home}/${rel}`;
const root = (rel: string): string => `${tree.root}/${rel}`;
const code = (rel: string): string => home(`Library/Application Support/Code/User/${rel}`);
const session = (uuid: string): string => home(`.copilot/session-state/${uuid}`);

function entity(kind: string, path: string): Entity {
  const found = result.entities.find((item) => item.id === id(kind, path));
  if (found === undefined) throw new Error(`entity not found: ${id(kind, path)}`);
  return found;
}

function unit(path: string): HarnessCache {
  const found = entity("harness-cache", path);
  if (found.kind !== "harness-cache") throw new Error("kind");
  return found;
}

function mcp(path: string): McpServer {
  const found = entity("mcp-server", path);
  if (found.kind !== "mcp-server") throw new Error("kind");
  return found;
}

function skill(path: string): Skill {
  const found = entity("skill", path);
  if (found.kind !== "skill") throw new Error("kind");
  return found;
}

function agent(path: string): AgentDefinition {
  const found = entity("agent-definition", path);
  if (found.kind !== "agent-definition") throw new Error("kind");
  return found;
}

function loadedBy(kind: string, path: string): LoadedByEdge {
  const from = id(kind, path);
  const edge = result.edges.find((item) => item.kind === "loaded-by" && item.from === from);
  if (edge === undefined || edge.kind !== "loaded-by")
    throw new Error(`loaded-by edge not found for ${from}`);
  return edge;
}

function crumb(predicate: (crumb: Breadcrumb) => boolean): Breadcrumb {
  const found = result.breadcrumbs.find(predicate);
  if (found === undefined) throw new Error("breadcrumb not found");
  return found;
}

/** Copy-time stamps (files the case does not age) differ per run; stamps on `NOW`'s day grid stay. */
function stableTimes(json: string): string {
  const now = Date.now();
  return json
    .replaceAll(ISO_ANYWHERE, (stamp) => {
      const ms = Date.parse(stamp);
      const onGrid = (NOW.getTime() - ms) % 86_400_000 === 0;
      return !onGrid && Math.abs(ms - now) < THREE_DAYS_MS ? "<COPY-TIME>" : stamp;
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

beforeAll(async () => {
  tree = await loadFixture("copilot/trust-and-sessions", {
    cwd: "root/project-a",
    now: NOW,
    platform: PLATFORM,
  });
  const index = await scan({
    home: tree.home,
    roots: tree.roots,
    cwd: tree.cwd,
    platform: PLATFORM,
    env: tree.env,
    harnesses: ["copilot"],
    git: false,
    now: NOW,
  });
  // Memory is server-side: the adapter must emit no memory unit at all.
  if (index.entities.some((item) => item.kind === "memory-file"))
    throw new Error("Copilot has no local memory unit");
  result = await audit(index);
});

afterAll(async () => {
  await tree.cleanup();
});

describe("copilot adapter over the trust-and-sessions case", () => {
  it("describes one harness with two surfaces and no local memory", () => {
    const harness = result.harnesses[0];
    expect(result.harnesses).toHaveLength(1);
    expect(harness?.id).toBe("harness:copilot");
    expect(harness?.surfaces).toEqual(["cli", "vscode"]);
    expect(harness?.presence).toBe("installed");
    expect(harness?.version).toBeNull();
    expect(harness?.capabilities).toEqual({
      memoryLocation: "server-side",
      memoryReadSignal: "not-applicable",
      contextFileNames: ["copilot-instructions.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md"],
      sweepDocumented: false,
    });
    expect(harness?.caps).toEqual({
      memoryIndexLines: null,
      memoryIndexBytes: null,
      chainMaxBytes: null,
      skillDescriptionChars: null,
      importDepth: null,
    });
    // `config.json` `model` is `<redacted>`: a redacted value is not a model id.
    expect(harness?.effectiveModel).toBeNull();
    expect(harness?.modelFamily).toBeNull();
    expect(harness?.effectiveSettings["model"]).toBe("<redacted>");
    expect(harness?.effectiveSettings["logged_in_users"]).toBe("<redacted>");
    expect(harness?.effectiveSettings["last_logged_in_user"]).toBe("<redacted>");
    expect(harness?.effectiveSettings["banner"]).toBe("<redacted>");
    expect(harness?.effectiveSettings["allowed_urls"]).toBe("<redacted>");
    expect(harness?.effectiveSettings["render_markdown"]).toBe(true);
    // The `github.copilot.enable` map keeps its key names verbatim.
    expect(harness?.effectiveSettings["github.copilot.enable"]).toEqual({
      "<redacted>-1": true,
      yaml: true,
      plaintext: true,
      markdown: false,
      typescriptreact: true,
      typescript: true,
    });
    expect(harness?.userScope.paths.map((item) => [item.path, item.role])).toEqual([
      [home(".copilot"), "data"],
      [home("Library/Application Support/Code"), "app-support"],
    ]);
    expect(result.scan.env).toEqual({});
    expect(result.warnings.map((warning) => warning.code)).toEqual(["git-missing"]);
  });

  it("names the six breadcrumb sources, three of them not read in v1", () => {
    expect(
      result.harnesses[0]?.breadcrumbSources.map((source) => [source.kind, source.readInV1]),
    ).toEqual([
      ["trust-entry", true],
      ["session-cwd", true],
      ["workspace-record", true],
      ["workspace-record", false],
      ["trust-entry", false],
      ["workspace-record", false],
    ]);
    const notRead = result.harnesses[0]?.breadcrumbSources.filter((source) => !source.readInV1);
    expect(notRead?.map((source) => source.path)).toEqual([
      code("globalStorage/state.vscdb"),
      code("globalStorage/state.vscdb"),
      code("globalStorage/storage.json"),
    ]);
  });

  it("case 1: trusted_folders holds a repository, a ghost and the home directory", () => {
    const projectA = crumb((item) => item.kind === "trust-entry" && item.raw === root("project-a"));
    expect(projectA.project).toBe(id("project", root("project-a")));
    expect(projectA.reachability).toBe("present");
    expect(projectA.locator).toEqual({
      type: "array-value",
      file: home(".copilot/config.json"),
      format: "json",
      keyPath: ["trusted_folders"],
      value: root("project-a"),
    });
    expect(projectA.state).toEqual([]);
    const gone = crumb((item) => item.kind === "trust-entry" && item.raw === root("gone"));
    expect(gone.project).toBe(id("project", root("gone")));
    expect(gone.reachability).toBe("orphan");
    const homeEntry = crumb((item) => item.kind === "trust-entry" && item.raw === tree.home);
    expect(homeEntry.project).toBeNull();
    expect(homeEntry.strayReason).toBe("bare-directory");
    expect(result.harnesses[0]?.userScope.stray).toContain(homeEntry.id);
    // The ghost is a Project of kind `unknown`; the home directory never becomes one.
    expect(result.projects.map((project) => project.id)).toEqual([
      id("project", root("gone")),
      id("project", root("project-a")),
    ]);
    expect(result.projects[0]?.kind).toBe("unknown");
    expect(result.projects.some((project) => project.path === tree.home)).toBe(false);
    expect(result.projects[0]?.perHarness["copilot"]?.trusted).toBe(true);
    expect(result.projects[1]?.perHarness["copilot"]?.trusted).toBe(true);
  });

  it("case 2: one session-cwd breadcrumb per distinct path, folded to the git root", () => {
    const sessionCwds = result.breadcrumbs.filter((item) => item.kind === "session-cwd");
    expect(sessionCwds.map((item) => item.raw)).toEqual([
      root("gone"),
      root("project-a"),
      root("project-a/packages/api"),
    ]);
    const projectA = crumb((item) => item.kind === "session-cwd" && item.raw === root("project-a"));
    expect(projectA.occurrences).toEqual({
      count: 1,
      first: "2026-01-15T12:00:00.000Z",
      last: "2026-01-15T12:00:00.000Z",
    });
    expect(projectA.refs).toEqual({ lastSessionId: SESSION_A });
    expect(projectA.state).toEqual([id("harness-cache", session(SESSION_A))]);
    expect(projectA.locator).toEqual({
      type: "entry",
      file: `${session(SESSION_A)}/workspace.yaml`,
      format: "yaml",
      keyPath: ["cwd"],
    });
    // The SUBDIR session's cwd is below the repository: it folds to the git root and keeps the
    // subdirectory it actually pointed at.
    const subdir = crumb(
      (item) => item.kind === "session-cwd" && item.raw === root("project-a/packages/api"),
    );
    expect(subdir.project).toBe(id("project", root("project-a")));
    expect(subdir.relativePathInProject).toBe("packages/api");
    expect(subdir.refs).toEqual({ lastSessionId: SESSION_SUBDIR });
    const gone = crumb((item) => item.kind === "session-cwd" && item.raw === root("gone"));
    expect(gone.project).toBe(id("project", root("gone")));
    expect(gone.reachability).toBe("orphan");
    expect(gone.refs).toEqual({ lastSessionId: SESSION_GONE });
  });

  it("case 3: three session units, kept, aged 3 / 200 / 40 days, with 6 / 2 / 3 files", () => {
    const a = unit(session(SESSION_A));
    const ghost = unit(session(SESSION_GONE));
    const subdir = unit(session(SESSION_SUBDIR));
    for (const item of [a, ghost, subdir]) {
      expect(item.cacheKind).toBe("transcript");
      expect(item.unit).toBe("session");
      expect(item.surface).toBe("cli");
      // Ticket 08: sessions are kept — Delete only, never in the clean sweep.
      expect(item.rule).toBe("kept");
      expect(item.retention).toEqual({ days: null, bytes: null, count: null, source: null });
      expect(item.protection).toBe("none");
      expect(item.removal).toEqual({ method: "trash" });
      expect(item.liveGuard).toEqual({ kind: "recent-activity", alive: false });
      expect(item.userContent).toBe(false);
      expect(item.locator).toEqual({ type: "dir", path: item.path });
    }
    expect([a.metrics.ageDays, ghost.metrics.ageDays, subdir.metrics.ageDays]).toEqual([
      3, 200, 40,
    ]);
    // The README's tree, not its prose: 6 / 2 / 3 regular files.
    expect([a.members.files, ghost.members.files, subdir.members.files]).toEqual([6, 2, 3]);
    // The ghost session has no `events.jsonl` and still becomes a unit; it folds into `gone`.
    expect(ghost.project).toBe(id("project", root("gone")));
    expect(a.project).toBe(id("project", root("project-a")));
    expect(subdir.project).toBe(id("project", root("project-a")));
    // A session label never names a member file: checkpoint names leak conversation titles.
    expect(a.label).toBe("session 00000000 · 2026-08-23");
    expect(result.entities.some((item) => item.path.includes("001-checkpoint.md"))).toBe(false);
  });

  it("case 4 and 5: markdown and a database inside session state are members, not entities", () => {
    for (const name of ["plan.md", "checkpoints/index.md", "checkpoints/001-checkpoint.md"]) {
      expect(
        result.entities.some((item) => item.kind === "context-file" && item.path.endsWith(name)),
      ).toBe(false);
    }
    expect(result.entities.some((item) => item.path.endsWith("session.db"))).toBe(false);
    expect(result.entities.some((item) => item.path.endsWith("events.jsonl"))).toBe(false);
    // `session.db` is counted in the unit's bytes without ever being opened.
    expect(unit(session(SESSION_A)).metrics.bytes).toBeGreaterThan(0);
    expect(result.warnings.some((warning) => warning.code === "sqlite-unreadable")).toBe(false);
  });

  it("case 6: four workspace records, two folding into one Project, and a size-only storage dir", () => {
    const records = result.breadcrumbs.filter((item) => item.kind === "workspace-record");
    expect(records).toHaveLength(4);
    expect(
      records
        .map((item) => item.refs.workspaceStorageId ?? "")
        .toSorted((a, b) => a.localeCompare(b)),
    ).toEqual(STORAGE);
    const forProjectA = records.filter((item) => item.project === id("project", root("project-a")));
    expect(forProjectA).toHaveLength(2);
    expect(forProjectA.every((item) => item.recordedForm === "file-uri")).toBe(true);
    const homeRecord = crumb(
      (item) => item.kind === "workspace-record" && item.refs.workspaceStorageId === STORAGE[2],
    );
    expect(homeRecord.project).toBeNull();
    expect(homeRecord.strayReason).toBe("bare-directory");
    const ghost = crumb(
      (item) => item.kind === "workspace-record" && item.refs.workspaceStorageId === STORAGE[3],
    );
    expect(ghost.project).toBe(id("project", root("gone")));
    expect(ghost.reachability).toBe("orphan");
    // D66/D117: VS Code's own storage directory is size-only — moldig shows the megabytes and
    // offers no checkbox over a directory that holds a database it promised never to touch.
    for (const storageId of STORAGE) {
      const storage = unit(code(`workspaceStorage/${storageId}`));
      expect(storage.cacheKind).toBe("workspace");
      expect(storage.surface).toBe("vscode");
      expect(storage.producer).toEqual({ harness: "other-app", surface: "vscode" });
      expect(storage.rule).toBe("undocumented");
      expect(storage.protection).toBe("undocumented");
      expect(storage.removal).toEqual({ method: "none" });
    }
    expect(unit(code(`workspaceStorage/${STORAGE[3]}`)).metrics.ageDays).toBe(200);
    expect(unit(code(`workspaceStorage/${STORAGE[1]}`)).metrics.ageDays).toBe(120);
    // D104: the database row is kept, protected and has no removal method at all.
    const database = unit(code("globalStorage/state.vscdb"));
    expect(database.cacheKind).toBe("database");
    expect(database.rule).toBe("kept");
    expect(database.protection).toBe("never");
    expect(database.removal).toEqual({ method: "none" });
    const storageJson = entity("settings-file", code("globalStorage/storage.json"));
    if (storageJson.kind !== "settings-file") throw new Error("kind");
    expect(storageJson.role).toBe("state");
    expect(storageJson.ownership).toBe("harness");
    expect(storageJson.protection).toBe("never");
  });

  it("case 7: the two MCP schemas side by side", () => {
    const cliUser = home(".copilot/mcp-config.json");
    const local = mcp(`${cliUser}#mcpServers/server-local`);
    expect(local.transport).toBe("stdio");
    expect(local.invalid).toBeNull();
    expect(local.rawKeys).toEqual(["type", "command", "args", "env", "tools"]);
    expect(local.envKeys).toEqual(["EXAMPLE_VAR"]);
    expect(loadedBy("mcp-server", `${cliUser}#mcpServers/server-local`)).toMatchObject({
      mode: "full",
      reason: "user scope (the CLI): available in every session",
    });
    const userHttp = mcp(`${cliUser}#mcpServers/server-http`);
    expect(userHttp.transport).toBe("http");
    expect(userHttp.headerKeys).toEqual(["Authorization"]);
    expect(userHttp.secretKeys).toEqual(["Authorization"]);
    expect(userHttp.approval).toBe("not-applicable");
    // VS Code's schema: `servers`, and `inputs[]` are never entries.
    const vscodeUser = code("mcp.json");
    const vscodeHttp = mcp(`${vscodeUser}#servers/server-http`);
    expect(vscodeHttp.transport).toBe("http");
    expect(loadedBy("mcp-server", `${vscodeUser}#servers/server-http`).reason).toBe(
      "user scope (VS Code): available in every session",
    );
    expect(result.entities.some((item) => item.id.includes("#inputs"))).toBe(false);
    // The project files: `.github/mcp.json` is the CLI's, `.vscode/mcp.json` is VS Code's.
    const githubMcp = root("project-a/.github/mcp.json");
    expect(loadedBy("mcp-server", `${githubMcp}#mcpServers/server-stdio`)).toMatchObject({
      mode: "full",
      reason: "project scope (the CLI): trusted folder",
    });
    const vscodeMcp = root("project-a/.vscode/mcp.json");
    expect(loadedBy("mcp-server", `${vscodeMcp}#servers/server-stdio`)).toMatchObject({
      mode: "unknown",
      reason: "VS Code workspace trust recorded in state.vscdb, which moldig never opens",
    });
    expect(mcp(`${vscodeMcp}#servers/server-sse`).transport).toBe("sse");
    expect(result.entities.filter((item) => item.kind === "mcp-server")).toHaveLength(7);
    for (const item of result.entities) {
      if (item.kind !== "mcp-server") continue;
      expect(item.usesInterpolation).toBe(false);
      expect(item.removal).toEqual({ method: "backup-edit" });
    }
    // A server configured on both surfaces pairs by endpoint, never by name alone. Skill pairs
    // belong to the shared stores adapter (ticket 22), so this counts MCP subjects only.
    const servers = new Set(
      result.entities.filter((item) => item.kind === "mcp-server").map((item) => item.id),
    );
    const duplicates = result.edges.filter(
      (edge) => edge.kind === "duplicates" && servers.has(edge.from),
    );
    expect(duplicates).toHaveLength(3);
    expect(duplicates.every((edge) => edge.kind === "duplicates" && edge.same === "endpoint")).toBe(
      true,
    );
    // D142: the configuration files themselves are never removed, only their entries.
    for (const item of result.entities) {
      if (item.kind !== "settings-file") continue;
      expect(item.protection).toBe("never");
      expect(item.removal).toEqual({ method: "none" });
    }
    const settings = entity("settings-file", githubMcp);
    if (settings.kind !== "settings-file") throw new Error("kind");
    expect(settings.role).toBe("mcp-config");
    expect(settings.entries).toBe(2);
  });

  it("case 8: the agent suffix rule, and a .github that never qualifies", () => {
    const planner = agent(root("project-a/.github/agents/planner.agent.md"));
    expect(planner.form).toBe("markdown");
    // D39: an agent definition never counts toward the Headline, for any harness.
    expect(loadedBy("agent-definition", planner.path)).toMatchObject({
      mode: "on-demand",
      countsTowardHeadline: false,
      confidence: "medium",
    });
    const reviewer = agent(root("project-a/.github/agents/reviewer.md"));
    expect(loadedBy("agent-definition", reviewer.path)).toMatchObject({
      mode: "unknown",
      reason: "no .agent.md suffix: not a documented agent file name",
      confidence: "low",
    });
    for (const name of ["ISSUE_TEMPLATE.md", "PULL_REQUEST_TEMPLATE.md", "workflows/ci.yml"]) {
      expect(result.entities.some((item) => item.path.endsWith(name))).toBe(false);
    }
    // project-b's `.github/` holds only workflows, CODEOWNERS and a Dependabot file, and its
    // `.vscode/` has no `mcp.json`: no marker, no breadcrumb, no Project — and never read.
    expect(result.projects.some((project) => project.path === root("project-b"))).toBe(false);
    expect(result.entities.some((item) => item.path.startsWith(root("project-b")))).toBe(false);
  });

  it("case 9: the settings that widen discovery, the workspace layer winning", () => {
    const api = root("project-a/.github/instructions/api.instructions.md");
    expect(loadedBy("context-file", api)).toMatchObject({
      mode: "on-demand",
      reason: "applyTo-scoped rule: included when matching files are in context",
      countsTowardHeadline: false,
    });
    // `docs/instructions` is disabled by the user layer and re-enabled by `.vscode/settings.json`.
    const db = root("project-a/docs/instructions/db.instructions.md");
    expect(loadedBy("context-file", db).mode).toBe("on-demand");
    const global = home(".copilot/instructions/global.instructions.md");
    expect(loadedBy("context-file", global)).toMatchObject({
      mode: "full",
      reason: "applyTo: ** — included in every request",
      project: null,
      countsTowardHeadline: true,
    });
    // `.claude/skills` and `~/.claude/skills` are named by the settings but do not exist here.
    expect(result.entities.some((item) => item.path.includes(".claude/skills"))).toBe(false);
    expect(result.projects[1]?.perHarness["copilot"]?.effectiveSettings).toEqual({
      "chat.useAgentsMdFile": true,
      "chat.instructionsFilesLocations": {
        ".github/instructions": true,
        "docs/instructions": true,
      },
    });
  });

  it("case 10: one skill in the store reached by a symlink, one real copy in the repository", () => {
    const store = skill(home(".agents/skills/skill-a"));
    // A directory several harnesses link into belongs to none of them.
    expect(store.harness).toBeNull();
    expect(store.layout).toBe("canonical");
    expect(store.placements.map((item) => [item.path, item.harness, item.isSymlink])).toEqual([
      [home(".agents/skills/skill-a"), null, false],
      [home(".copilot/skills/skill-a"), "copilot", true],
    ]);
    expect(store.placements[1]?.linkTarget).toBe("../../.agents/skills/skill-a");
    expect(store.placements[1]?.dangling).toBe(false);
    expect(loadedBy("skill", store.path)).toMatchObject({
      mode: "description-only",
      project: null,
      countsTowardHeadline: true,
    });
    const project = skill(root("project-a/.github/skills/skill-a"));
    expect(project.layout).toBe("copy");
    expect(project.harness).toBe("copilot");
    expect(project.placements).toHaveLength(1);
    expect(project.placements[0]?.surface).toBeNull();
    expect(project.shared).toBeNull();
    expect(loadedBy("skill", project.path).project).toBe(id("project", root("project-a")));
    // The two are the same name and content: pairing them is the cross-adapter pass, not this one.
    expect(result.edges.some((edge) => edge.kind === "duplicates" && edge.same === "content")).toBe(
      false,
    );
  });

  it("loads the instructions chain in order and the prompt file on demand", () => {
    const repository = root("project-a/.github/copilot-instructions.md");
    const file = entity("context-file", repository);
    if (file.kind !== "context-file") throw new Error("kind");
    expect(file.form).toBe("instructions");
    // The README's tree, not its prose: 62 lines.
    expect(file.metrics.lines).toBe(62);
    expect(file.importCount).toBe(0);
    expect(loadedBy("context-file", repository)).toMatchObject({
      mode: "full",
      reason: "repository instructions: included in every request (CLI and VS Code)",
      order: 0,
      countsTowardHeadline: true,
    });
    expect(loadedBy("context-file", home(".copilot/copilot-instructions.md"))).toMatchObject({
      mode: "full",
      reason: "user instructions: included in every Copilot CLI session",
      project: null,
      order: 0,
    });
    expect(loadedBy("context-file", root("project-a/AGENTS.md"))).toMatchObject({
      mode: "full",
      reason: "AGENTS.md of the repository root: nearest wins (CLI and VS Code)",
      countsTowardHeadline: true,
    });
    expect(loadedBy("context-file", root("project-a/packages/api/AGENTS.md"))).toMatchObject({
      mode: "on-demand",
      reason: "nested AGENTS.md: nearest wins when working in that subtree",
      countsTowardHeadline: false,
    });
    const prompt = skill(root("project-a/.github/prompts/x.prompt.md"));
    expect(prompt.form).toBe("command-file");
    expect(prompt.name).toBe("x");
    expect(prompt.frontmatter["agent"]).toBe("agent");
    expect(loadedBy("skill", prompt.path)).toMatchObject({
      mode: "on-demand",
      reason: "prompt file: run as /x",
      countsTowardHeadline: false,
    });
  });

  it("sweeps the log and nothing else, and never preselects a row", () => {
    const log = unit(home(".copilot/logs/process-1700000000000-1.log"));
    expect(log.cacheKind).toBe("log");
    expect(log.rule).toBe("swept");
    expect(log.retention).toEqual({
      days: null,
      bytes: null,
      count: null,
      source: "changelog 1.0.55",
    });
    expect(log.metrics.ageDays).toBe(90);
    expect(log.protection).toBe("none");
    // Size-only rows for the entries the config-dir reference does not document.
    for (const name of ["ide", "pkg"]) {
      const row = unit(home(`.copilot/${name}`));
      expect(row.rule).toBe("undocumented");
      expect(row.protection).toBe("undocumented");
      expect(row.members.files).toBe(0);
      expect(row.userContent).toBe(false);
    }
    // Ticket 08's Answer: nothing Copilot leaves behind is ever ticked by default.
    for (const finding of result.findings) {
      if (finding.category !== "harness-cache") continue;
      expect(finding.action.preselect).toBe(false);
      expect(finding.targets.every((target) => target.preselect !== true)).toBe(true);
    }
    const cacheBytes = result.entities
      .filter((item) => item.kind === "harness-cache")
      .reduce((sum, item) => sum + item.metrics.bytes, 0);
    expect(result.totals.harnessCacheBytes).toBe(cacheBytes);
  });

  it("files the ghost Project's Orphan finding over its kept state", () => {
    const orphan = result.findings.find((finding) => finding.category === "orphan");
    expect(orphan?.container).toBe(id("project", root("gone")));
    expect(orphan?.targets.filter((target) => target.role === "breadcrumb")).toHaveLength(3);
    // D111: a `rule: kept` unit never enters a clean group — the session is Delete-only, so the
    // finding lists it without a tick.
    expect(
      orphan?.targets.filter((target) => target.role === "state" && target.preselect === true),
    ).toEqual([]);
    expect(orphan?.severity).toBe("medium");
    expect(result.headline.focus).toEqual({
      project: id("project", root("project-a")),
      reason: "cwd",
    });
    expect(result.headline.perHarness[0]?.harness).toBe("copilot");
    expect(result.headline.perHarness[0]?.baseline.mid).toBeGreaterThan(0);
    expect(result.headline.perHarness[0]?.project.mid).toBeGreaterThan(0);
  });

  it("matches the audit snapshot", async () => {
    const stable = normaliseSnapshot(result, tree);
    stable.scan.durationMs = 0;
    await expect(stableTimes(formattedJson(stable) + "\n")).toMatchFileSnapshot(
      "./__snapshots__/trust-and-sessions.audit.json",
    );
  });
});

/**
 * D147: an adapter that finds no trace of its harness emits nothing — no `Harness` row, no
 * verdict on a shared `AGENTS.md` that no Copilot session can ever read, and no warnings. For a
 * harness with two surfaces, "no trace" means neither `~/.copilot` nor anything of Copilot's on
 * the VS Code side.
 */
describe("copilot on a machine that never ran it (D147)", () => {
  async function scanBare(prepare?: (bare: FixtureTree) => Promise<void>): Promise<{
    index: Awaited<ReturnType<typeof scan>>;
    home: string;
    cleanup: () => Promise<void>;
  }> {
    const bare = await loadFixture("shared/root-tree", { now: NOW, platform: PLATFORM });
    await prepare?.(bare);
    const index = await scan({
      home: bare.home,
      roots: bare.roots,
      cwd: bare.root,
      platform: PLATFORM,
      env: { COPILOT_HOME: join(bare.home, ".copilot") },
      harnesses: ["copilot"],
      git: false,
      now: NOW,
    });
    return { index, home: bare.home, cleanup: () => bare.cleanup() };
  }

  it("contributes no harness row, no entity, no verdict and no warning", async () => {
    const { index, home: bareHome, cleanup } = await scanBare();
    try {
      expect(index.harnesses).toEqual([]);
      expect(index.breadcrumbs).toEqual([]);
      // The shared stores adapter always runs (D21), so `AGENTS.md` and the store's skills are
      // still there; what must be absent is anything this harness owns or reaches.
      expect(index.entities.every((item) => item.harness === null)).toBe(true);
      expect(
        index.entities.every(
          (item) =>
            item.kind !== "skill" ||
            item.placements.every((placement) => placement.harness !== "copilot"),
        ),
      ).toBe(true);
      expect(index.edges.every((edge) => edge.to !== "harness:copilot")).toBe(true);
      expect(index.projects.every((project) => project.perHarness["copilot"] === undefined)).toBe(
        true,
      );
      // The case carries an `AGENTS.md`: it must not gain a verdict for a harness that is not here.
      expect(index.warnings.every((warning) => warning.harness !== "copilot")).toBe(true);
      // The override moldig honoured is still on the record: one env entry is not a harness.
      expect(index.scan.env).toEqual({ COPILOT_HOME: join(bareHome, ".copilot") });
    } finally {
      await cleanup();
    }
  });

  it("a VS Code with no Copilot in it is still no trace", async () => {
    const { index, cleanup } = await scanBare(async (bare) => {
      // VS Code installed, with a workspace record and a global state database — but nothing of
      // Copilot's anywhere in it.
      const user = join(bare.home, "Library/Application Support/Code/User");
      await mkdir(join(user, "workspaceStorage", "abc"), { recursive: true });
      await writeFile(
        join(user, "workspaceStorage", "abc", "workspace.json"),
        JSON.stringify({ folder: `file://${bare.root}/monorepo` }),
      );
      await mkdir(join(user, "globalStorage"), { recursive: true });
      await writeFile(join(user, "globalStorage", "state.vscdb"), "SQLite format 3 truncated");
      await writeFile(join(user, "settings.json"), '{"editor.fontSize": 13}');
    });
    try {
      expect(index.harnesses).toEqual([]);
      // The shared stores adapter always runs (D21): what must be absent is Copilot's own.
      expect(index.entities.every((item) => item.harness === null)).toBe(true);
      expect(index.breadcrumbs).toEqual([]);
      expect(index.warnings.every((warning) => warning.harness !== "copilot")).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it("one `chat.*` key in VS Code's settings is a trace, and the harness is shown", async () => {
    const { index, cleanup } = await scanBare(async (bare) => {
      const user = join(bare.home, "Library/Application Support/Code/User");
      await mkdir(user, { recursive: true });
      await writeFile(join(user, "settings.json"), '{"chat.useAgentsMdFile": false}');
    });
    try {
      expect(index.harnesses.map((harness) => [harness.harness, harness.presence])).toEqual([
        ["copilot", "config-only"],
      ]);
      expect(index.harnesses[0]?.effectiveSettings).toEqual({ "chat.useAgentsMdFile": false });
      // The settings file the keys came from is Copilot's one row: no repository here carries a
      // qualifying `.github/`, so nothing of any Project's is read. The rest of the index is the
      // shared stores adapter's, which always runs (D21).
      expect(
        index.entities
          .filter((item) => item.harness === "copilot")
          .map((item) => [item.kind, item.path.endsWith("settings.json")]),
      ).toEqual([["settings-file", true]]);
      expect(index.breadcrumbs).toEqual([]);
    } finally {
      await cleanup();
    }
  });
});

/**
 * The promise the adapter makes about the files it must never open, proved on a copy of the case
 * augmented with the material the README leaves out on purpose: a `session-store.db`, the two
 * credential stores, and a Copilot subdirectory inside a VS Code workspace-storage directory.
 */
describe("copilot never opens a database or a credential store", () => {
  it("leaves every byte, every mtime and every sidecar as it found them", async () => {
    const augmented = await loadFixture("copilot/trust-and-sessions", {
      cwd: "root/project-a",
      now: NOW,
      platform: PLATFORM,
    });
    try {
      const sessionStore = join(augmented.home, ".copilot", "session-store.db");
      const oauth = join(augmented.home, ".copilot", "mcp-oauth-config");
      const secrets = join(augmented.home, ".copilot", "mcp-secrets");
      const chat = join(
        augmented.home,
        "Library/Application Support/Code/User/workspaceStorage",
        STORAGE[0] ?? "",
        "GitHub.copilot-chat",
      );
      // A SQLite header and nothing behind it: if moldig opened it, `node:sqlite` would fail and
      // the scan would carry a `sqlite-unreadable` warning.
      await writeFile(sessionStore, Buffer.from("SQLite format 3 truncated"));
      await mkdir(oauth, { recursive: true });
      await writeFile(join(oauth, "0123456789abcdef.json"), '{"access_token":"nope"}');
      await mkdir(secrets, { recursive: true });
      await writeFile(join(secrets, "server-http"), "nope");
      await mkdir(chat, { recursive: true });
      await writeFile(join(chat, "chatSessions.json"), "[]");

      const vscdb = join(
        augmented.home,
        "Library/Application Support/Code/User/globalStorage/state.vscdb",
      );
      const watched = [vscdb, sessionStore, join(oauth, "0123456789abcdef.json")];
      const before = await Promise.all(
        watched.map(async (path) => {
          const stats = await lstat(path);
          return [stats.size, stats.mtimeMs] as const;
        }),
      );

      const index = await scan({
        home: augmented.home,
        roots: augmented.roots,
        cwd: augmented.cwd,
        platform: PLATFORM,
        env: augmented.env,
        harnesses: ["copilot"],
        git: false,
        now: NOW,
      });

      const after = await Promise.all(
        watched.map(async (path) => {
          const stats = await lstat(path);
          return [stats.size, stats.mtimeMs] as const;
        }),
      );
      expect(after).toEqual(before);
      // D37: a read-only scanner never creates a `-wal` or `-shm` sidecar beside a database.
      const globalStorage = await readdir(
        join(augmented.home, "Library/Application Support/Code/User/globalStorage"),
      );
      expect(globalStorage.toSorted((a, b) => a.localeCompare(b))).toEqual([
        "state.vscdb",
        "storage.json",
      ]);
      expect(
        (await readdir(join(augmented.home, ".copilot"))).filter((name) =>
          name.startsWith("session-store.db"),
        ),
      ).toEqual(["session-store.db"]);
      expect(index.warnings.some((warning) => warning.code === "sqlite-unreadable")).toBe(false);

      const byId = new Map(index.entities.map((item) => [item.id, item]));
      const database = byId.get(id("harness-cache", sessionStore.toLowerCase()));
      expect(database?.kind === "harness-cache" && database.cacheKind).toBe("database");
      expect(database?.protection).toBe("never");
      expect(database?.removal).toEqual({ method: "none" });
      for (const store of [oauth, secrets]) {
        const credentials = byId.get(id("settings-file", store.toLowerCase()));
        if (credentials?.kind !== "settings-file") throw new Error("credentials row missing");
        expect(credentials.role).toBe("credentials");
        expect(credentials.topLevelKeys).toEqual([]);
        expect(credentials.format).toBe("dir");
        expect(credentials.protection).toBe("never");
        expect(credentials.sensitive).toBe(true);
      }
      // D66: the Copilot subdirectory inside VS Code's storage is the tickable part; the
      // directory around it stays size-only, and its bytes are not counted twice.
      const copilotDir = byId.get(id("harness-cache", chat.toLowerCase()));
      if (copilotDir?.kind !== "harness-cache") throw new Error("copilot storage row missing");
      expect(copilotDir.protection).toBe("none");
      expect(copilotDir.removal).toEqual({ method: "trash" });
      expect(copilotDir.producer).toEqual({ harness: "copilot", surface: "vscode" });
      const parent = byId.get(
        id(
          "harness-cache",
          join(
            augmented.home,
            "Library/Application Support/Code/User/workspaceStorage",
            STORAGE[0] ?? "",
          ).toLowerCase(),
        ),
      );
      if (parent?.kind !== "harness-cache") throw new Error("workspace storage row missing");
      expect(parent.protection).toBe("undocumented");
      expect(parent.members.files).toBe(1);
    } finally {
      await augmented.cleanup();
    }
  });
});
