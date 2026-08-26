import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit, scan } from "../../index.js";
import type { AuditIndex, Breadcrumb, Entity, LoadedByEdge } from "../../index/types.js";
import {
  loadFixture,
  normaliseSnapshot,
  treePaths,
  type FixtureTree,
} from "../../testing/index.js";

/** After the fixture's synthetic timestamps (2023-11-14); `ages` are relative to it (same `now` for both). */
const NOW = new Date("2026-08-26T12:00:00.000Z");
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const SESSION_WT = "44444444-4444-4444-8444-444444444444";
const ISO_ANYWHERE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const DATE_ANYWHERE = /(?<![\dT:-])\d{4}-\d{2}-\d{2}(?![\dT])/g;
const THREE_DAYS_MS = 3 * 86_400_000;

let tree: FixtureTree;
let result: AuditIndex;

/** The scan runs as `darwin` whatever the host, so the snapshot is one: ids fold the path part (never the `#keyPath`). */
const PLATFORM = "darwin";
const { home, root, slugDir, homeSlug, rootSlug, id } = treePaths(() => tree);
/** `~/.claude/projects/<root slug>-<name>/…` — the case's own slug directories. */
const slug = (name: string, ...rest: string[]): string => slugDir(`${rootSlug()}-${name}`, ...rest);

function entity(kind: string, path: string): Entity {
  const found = result.entities.find((item) => item.id === id(kind, path));
  if (found === undefined) throw new Error(`entity not found: ${id(kind, path)}`);
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

/**
 * Files the fixture does not age carry the copy's mtime; any timestamp within three days of
 * the real clock is a copy-time stamp and would differ per run (ages of such files are 0
 * either way). Stamps derived from `NOW` (`generatedAt`, the aged files at `NOW - n days`) lie
 * on a whole-day grid from `NOW` and are kept. The bare date of a session label (its newest
 * member's day) follows the same rule. Applied to the serialised snapshot.
 */
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

/**
 * JSON in the shape the repo's formatter keeps (`oxfmt --check` runs over `__snapshots__`):
 * objects always expanded, arrays of primitives on one line when they fit in 100 columns.
 */
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
  tree = await loadFixture("claude-code/breadcrumbs", {
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
    git: false,
    now: NOW,
  });
  const memory = index.entities.find((item) => item.kind === "memory-file");
  if (memory?.kind === "memory-file" && memory.readSignal.source !== "not-computed")
    throw new Error("scan must not compute the read signal");
  result = await audit(index);
});

afterAll(async () => {
  await tree.cleanup();
});

describe("claude-code adapter over the breadcrumbs case", () => {
  it("describes the harness from what it wrote to disk", () => {
    const harness = result.harnesses[0];
    expect(result.harnesses).toHaveLength(1);
    expect(harness?.id).toBe("harness:claude-code");
    expect(harness?.presence).toBe("installed");
    expect(harness?.version).toBe("2.1.245");
    expect(harness?.contextWindowTokens).toBeNull();
    expect(harness?.capabilities).toEqual({
      memoryLocation: "file",
      memoryReadSignal: "exact",
      contextFileNames: ["CLAUDE.md", "CLAUDE.local.md"],
      sweepDocumented: true,
    });
    expect(harness?.caps.importDepth).toBe(4);
    expect(harness?.effectiveSettings["cleanupPeriodDays"]).toBe(20);
    expect(harness?.effectiveSettings["env"]).toEqual({ EXAMPLE_VAR: "<redacted>" });
    expect(harness?.userScope.paths.map((item) => item.path)).toEqual([
      home(".claude"),
      home(".claude.json"),
    ]);
    expect(result.scan.env).toEqual({});
    expect(result.tokenizer.encoding).toBe("o200k_base");
    expect(result.tokenizer.fallbackUsed).toBe(false);
    expect(result.warnings.map((warning) => warning.code)).toEqual(["git-missing"]);
    expect(result.scan.git).toEqual({ available: false, version: null });
  });

  it("folds the subdirectory and the linked worktree into project-a and keeps the dead registration as an orphan member", () => {
    expect(result.projects.map((project) => project.id)).toEqual([
      id("project", root("gone")),
      id("project", root("project-a")),
    ]);
    const projectA = result.projects[1];
    expect(projectA?.kind).toBe("repository");
    expect(projectA?.reachability).toBe("present");
    expect(projectA?.enclosesCwd).toBe(true);
    expect(projectA?.discoveredBy).toEqual(["breadcrumb", "marker-walk", "cwd"]);
    expect(
      projectA?.members.map((member) => [member.role, member.name, member.reachability]),
    ).toEqual([
      ["repository", null, "present"],
      ["worktree", "dead", "orphan"],
      ["worktree", "project-a-wt", "present"],
    ]);
    expect(projectA?.nestedMarkers).toEqual([
      {
        relativePath: "apps/web/CLAUDE.md",
        marker: "CLAUDE.md",
        entity: id("context-file", root("project-a/apps/web/CLAUDE.md")),
      },
    ]);
    const appsWeb = crumb(
      (item) => item.kind === "projects-entry" && item.raw === root("project-a/apps/web"),
    );
    expect(appsWeb.project).toBe(id("project", root("project-a")));
    expect(appsWeb.relativePathInProject).toBe("apps/web");
    const worktree = crumb(
      (item) => item.kind === "projects-entry" && item.raw === root("project-a-wt"),
    );
    expect(worktree.project).toBe(id("project", root("project-a")));
    expect(worktree.relativePathInProject).toBe("../project-a-wt");
    expect(projectA?.perHarness["claude-code"]?.trusted).toBe(true);
    expect(projectA?.perHarness["claude-code"]?.effectiveSettings["enabledMcpjsonServers"]).toEqual(
      ["server-http"],
    );
  });

  it("keeps the gone directory as an orphan Project, drops the volume key outside the Root and keeps the home key stray", () => {
    const gone = result.projects[0];
    expect(gone?.kind).toBe("unknown");
    expect(gone?.reachability).toBe("orphan");
    expect(gone?.breadcrumbs).toHaveLength(2);
    // Ticket 06 rule 7: the Root narrows the scan; `/Volumes/Backup/old` is under no Root.
    expect(result.breadcrumbs.some((item) => item.raw === "/Volumes/Backup/old")).toBe(false);
    expect(
      result.breadcrumbs.every((item) => item.project !== null || item.strayReason !== null),
    ).toBe(true);
    const homeKey = crumb((item) => item.kind === "projects-entry" && item.raw === tree.home);
    expect(homeKey.project).toBeNull();
    expect(homeKey.strayReason).toBe("bare-directory");
    const homeSlugCrumb = crumb(
      (item) => item.kind === "slug-directory" && item.raw === homeSlug(),
    );
    expect(homeSlugCrumb.resolution).toBe("slug-by-key");
    expect(homeSlugCrumb.strayReason).toBe("bare-directory");
    expect(result.harnesses[0]?.userScope.stray).toEqual([homeKey.id, homeSlugCrumb.id]);
    expect(result.projects.some((project) => project.path === tree.home)).toBe(false);
    expect(result.projects.some((project) => project.path.endsWith("/moved"))).toBe(false);
    expect(result.breadcrumbs.some((item) => item.kind === "session-cwd")).toBe(false);
    expect(result.harnesses[0]?.breadcrumbSources.map((source) => source.kind)).toEqual([
      "projects-entry",
      "slug-directory",
    ]);
    const worktreeSlug = crumb(
      (item) => item.kind === "slug-directory" && item.raw === tree.slug(root("project-a-wt")),
    );
    expect(worktreeSlug.project).toBe(id("project", root("project-a")));
    expect(worktreeSlug.state).toEqual([
      id("harness-cache", slug("project-a-wt", `${SESSION_WT}.jsonl`)),
    ]);
    const userFile = entity("context-file", home(".claude/CLAUDE.md"));
    expect(userFile.gitStatus).toBe("outside-repo");
    expect(userFile.shared).toBeNull();
  });

  it("builds session units per ticket 08 and preselects only the aged, sole-member one", () => {
    const sessionA = entity("harness-cache", slug("project-a", `${SESSION_A}.jsonl`));
    const sessionB = entity("harness-cache", slug("project-a-apps-web", `${SESSION_B}.jsonl`));
    if (sessionA.kind !== "harness-cache" || sessionB.kind !== "harness-cache")
      throw new Error("kind");
    expect(sessionA.locator).toEqual({
      type: "paths",
      paths: [
        slug("project-a", `${SESSION_A}.jsonl`),
        slug("project-a", SESSION_A),
        home(`.claude/tasks/${SESSION_A}`),
      ],
    });
    expect(sessionA.metrics.ageDays).toBe(0);
    expect(sessionA.retention).toEqual({
      days: 20,
      bytes: null,
      count: null,
      source: "cleanupPeriodDays",
    });
    expect(sessionA.liveGuard).toEqual({ kind: "pid", alive: false });
    // A session is always a `paths` unit anchored at its transcript (ticket 07), even alone.
    expect(sessionB.locator).toEqual({
      type: "paths",
      paths: [slug("project-a-apps-web", `${SESSION_B}.jsonl`)],
    });
    expect(sessionB.label).toBe(`session ${SESSION_B.slice(0, 8)} · 2026-07-12`);
    expect(sessionB.metrics.ageDays).toBe(45);
    expect(sessionB.rule).toBe("swept");
    const cacheFinding = result.findings.find(
      (finding) =>
        finding.id === `finding:harness-cache:${id("project", root("project-a"))}:transcript`,
    );
    expect(cacheFinding?.targets.map((target) => [target.id, target.preselect])).toEqual([
      [sessionB.id, true],
      [id("harness-cache", slug("project-a-wt", `${SESSION_WT}.jsonl`)), false],
      [sessionA.id, false],
    ]);
    expect(cacheFinding?.action).toEqual({ kind: "clean", preselect: true, locator: null });
    const backups = result.findings.find(
      (finding) => finding.id === "finding:harness-cache:harness:claude-code:config-backup",
    );
    expect(backups?.targets[0]?.preselect).toBe(false);
    const snapshots = result.findings.find(
      (finding) => finding.id === "finding:harness-cache:harness:claude-code:shell-snapshot",
    );
    expect(snapshots?.targets[0]?.preselect).toBe(true);
    const history = entity("harness-cache", home(".claude/history.jsonl"));
    if (history.kind !== "harness-cache") throw new Error("kind");
    expect(history.rule).toBe("kept");
    expect(history.userContent).toBe(true);
    expect(result.findings.some((finding) => finding.id.endsWith(":log"))).toBe(false);
  });

  it("gives every context file, memory file, skill and agent its loading verdict", () => {
    expect(loadedBy("context-file", home(".claude/CLAUDE.md"))).toMatchObject({
      project: null,
      mode: "full",
      order: 0,
      countsTowardHeadline: true,
    });
    expect(loadedBy("context-file", root("project-a/CLAUDE.md"))).toMatchObject({
      mode: "full",
      order: 0,
      countsTowardHeadline: true,
    });
    expect(loadedBy("context-file", root("project-a/.claude/rules/rule-a.md"))).toMatchObject({
      mode: "on-demand",
      order: null,
      countsTowardHeadline: false,
    });
    expect(
      loadedBy("context-file", root("project-a/.claude/rules/nested/rule-b.md")),
    ).toMatchObject({ mode: "full", countsTowardHeadline: true });
    expect(loadedBy("context-file", root("project-a/CLAUDE.local.md"))).toMatchObject({
      mode: "full",
      importsResolved: 1,
      countsTowardHeadline: true,
    });
    expect(loadedBy("context-file", root("project-a/docs/notes.md"))).toMatchObject({
      mode: "full",
      countsTowardHeadline: true,
    });
    expect(loadedBy("context-file", root("project-a/apps/web/CLAUDE.md"))).toMatchObject({
      mode: "on-demand",
      countsTowardHeadline: false,
    });
    expect(loadedBy("context-file", root("project-a-wt/CLAUDE.md"))).toMatchObject({
      mode: "full",
      countsTowardHeadline: false,
    });
    expect(loadedBy("memory-file", slug("project-a", "memory/MEMORY.md"))).toMatchObject({
      mode: "full",
      countsTowardHeadline: true,
    });
    expect(loadedBy("memory-file", slug("project-a", "memory/topic-a.md"))).toMatchObject({
      mode: "on-demand",
      countsTowardHeadline: false,
    });
    expect(
      loadedBy("memory-file", root("project-a/.claude/agent-memory/reviewer/MEMORY.md")),
    ).toMatchObject({ mode: "on-demand", countsTowardHeadline: false });
    expect(loadedBy("skill", root("project-a/.claude/commands/x.md"))).toMatchObject({
      mode: "description-only",
      effectiveName: "/x",
      disableModelInvocation: false,
      countsTowardHeadline: true,
    });
    // D39: an agent definition is spawned on demand; its description never enters the Headline.
    expect(
      loadedBy("agent-definition", root("project-a/.claude/agents/reviewer.md")),
    ).toMatchObject({ mode: "on-demand", order: null, countsTowardHeadline: false });
    const imports = result.edges.find((edge) => edge.kind === "imports");
    expect(imports).toMatchObject({
      from: id("context-file", root("project-a/CLAUDE.local.md")),
      to: id("context-file", root("project-a/docs/notes.md")),
      hop: 1,
      external: false,
    });
    const sessionLoad = result.projects[1]?.perHarness["claude-code"]?.sessionLoad;
    expect(sessionLoad?.items.map((item) => item.entity)).toEqual([
      id("context-file", root("project-a/CLAUDE.md")),
      id("context-file", root("project-a/.claude/rules/nested/rule-b.md")),
      id("context-file", root("project-a/CLAUDE.local.md")),
      id("context-file", root("project-a/docs/notes.md")),
      id("memory-file", slug("project-a", "memory/MEMORY.md")),
      id("skill", root("project-a/.claude/commands/x.md")),
    ]);
  });

  it("links the memory index to the fact its list item names", () => {
    const indexId = id("memory-file", slug("project-a", "memory/MEMORY.md"));
    const lists = result.edges.find((edge) => edge.kind === "lists" && edge.from === indexId);
    expect(lists).toMatchObject({
      to: id("memory-file", slug("project-a", "memory/topic-a.md")),
      confidence: "certain",
    });
    expect(lists?.evidence[0]).toEqual({
      kind: "index-line",
      detail: "line 3: topic-a.md",
    });
  });

  it("computes the exact never-read signal from the Project's transcripts", () => {
    const index = entity("memory-file", slug("project-a", "memory/MEMORY.md"));
    const topicA = entity("memory-file", slug("project-a", "memory/topic-a.md"));
    const homeIndex = entity(
      "memory-file",
      home(".claude/projects", homeSlug(), "memory/MEMORY.md"),
    );
    if (
      index.kind !== "memory-file" ||
      topicA.kind !== "memory-file" ||
      homeIndex.kind !== "memory-file"
    )
      throw new Error("kind");
    expect(index.readSignal).toEqual({
      source: "transcript-tool-use",
      exact: true,
      bashParsed: false,
    });
    expect(index.reads).toEqual({
      count: 1,
      first: "2023-11-14T22:13:20.000Z",
      last: "2023-11-14T22:13:20.000Z",
    });
    expect(index.loadedPortion).toMatchObject({ lines: 3, bytes: 432, confidence: "certain" });
    expect(topicA.neverRead).toBe(true);
    expect(topicA.frontmatter).toEqual({
      name: "<redacted>",
      description: "<redacted>",
      metadata: "<redacted>",
    });
    expect(homeIndex.owner).toBe("global");
    expect(homeIndex.project).toBeNull();
  });

  it("models MCP entries at three scopes with approval, shadowing and endpoint duplicates", () => {
    const broken = entity("mcp-server", `${root("project-a/.mcp.json")}#mcpServers/server-broken`);
    const sse = entity("mcp-server", `${root("project-a/.mcp.json")}#mcpServers/server-sse`);
    const http = entity("mcp-server", `${root("project-a/.mcp.json")}#mcpServers/server-http`);
    const userStdio = entity("mcp-server", `${home(".claude.json")}#mcpServers/server-stdio`);
    if (
      broken.kind !== "mcp-server" ||
      sse.kind !== "mcp-server" ||
      http.kind !== "mcp-server" ||
      userStdio.kind !== "mcp-server"
    )
      throw new Error("kind");
    expect(broken.invalid).toBe("url without type");
    expect(broken.transport).toBe("unknown");
    expect(sse.approval).toBe("rejected");
    expect(http.approval).toBe("approved");
    expect(http.headerKeys).toEqual(["Authorization"]);
    expect(http.usesInterpolation).toBe(true);
    expect(http.secretKeys).toEqual([]);
    expect(http.removal).toEqual({ method: "backup-edit" });
    expect(userStdio.removal).toEqual({
      method: "delegate",
      command: "claude mcp remove server-stdio -s user",
    });
    const localHttp = entity(
      "mcp-server",
      `${home(".claude.json")}#projects/${root("project-a")}/mcpServers/server-http`,
    );
    expect(localHttp.removal).toEqual({
      method: "delegate",
      command: `cd "${root("project-a")}" && claude mcp remove server-http -s local`,
    });
    const goneHttp = entity(
      "mcp-server",
      `${home(".claude.json")}#projects/${root("gone")}/mcpServers/server-http`,
    );
    expect(goneHttp.removal).toEqual({ method: "none" });
    expect(
      loadedBy("mcp-server", `${root("project-a/.mcp.json")}#mcpServers/server-broken`).mode,
    ).toBe("never");
    expect(
      loadedBy("mcp-server", `${root("project-a/.mcp.json")}#mcpServers/server-http`).mode,
    ).toBe("shadowed");
    const localStdio = id(
      "mcp-server",
      `${home(".claude.json")}#projects/${root("project-a")}/mcpServers/server-stdio`,
    );
    expect(
      result.edges.some(
        (edge) => edge.kind === "shadows" && edge.from === localStdio && edge.to === userStdio.id,
      ),
    ).toBe(true);
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "duplicates" &&
          edge.same === "endpoint" &&
          edge.from === userStdio.id &&
          edge.to === localStdio,
      ),
    ).toBe(true);
    // The worktree's CLAUDE.md is git's checkout of the repository's file, not a distinct copy.
    expect(result.edges.some((edge) => edge.kind === "duplicates" && edge.same === "content")).toBe(
      false,
    );
    expect(loadedBy("context-file", root("project-a-wt/CLAUDE.md")).countsTowardHeadline).toBe(
      false,
    );
  });

  it("files the audit findings and the headline for the Project enclosing cwd", () => {
    expect(result.findings.map((finding) => finding.category)).toEqual([
      "duplicate",
      "duplicate",
      "harness-cache",
      "harness-cache",
      "harness-cache",
      "harness-cache",
      "orphan",
      "shadow-memory",
      "shadow-memory",
    ]);
    // The stray home unit describes no Project: user-scope state, not shadow memory.
    expect(
      result.findings
        .filter((finding) => finding.category === "shadow-memory")
        .every((finding) => finding.container?.startsWith("project:") === true),
    ).toBe(true);
    const orphan = result.findings.find((finding) => finding.category === "orphan");
    expect(orphan?.container).toBe(id("project", root("gone")));
    expect(orphan?.targets.map((target) => target.role)).toEqual([
      "breadcrumb",
      "breadcrumb",
      "state",
      "state",
    ]);
    expect(
      orphan?.evidence.some((item) =>
        item.detail?.includes("33333333-3333-4333-8333-333333333333"),
      ),
    ).toBe(true);
    expect(orphan?.severity).toBe("medium");
    const headline = result.headline;
    expect(headline.focus).toEqual({ project: id("project", root("project-a")), reason: "cwd" });
    const claude = headline.perHarness[0];
    expect(claude?.baseline.mid).toBeGreaterThan(0);
    expect(claude?.project.mid).toBeGreaterThan(0);
    expect(claude?.baseline.mid).toBeLessThan(claude?.total.mid ?? 0);
    expect(claude?.pctOfContext).toBeNull();
    const settings = entity("settings-file", home(".claude.json"));
    expect(settings.sensitive).toBe(true);
    expect(settings.protection).toBe("never");
  });

  it("matches the audit snapshot", async () => {
    const stable = normaliseSnapshot(result, tree);
    stable.scan.durationMs = 0;
    await expect(stableTimes(formattedJson(stable) + "\n")).toMatchFileSnapshot(
      "./__snapshots__/breadcrumbs.audit.json",
    );
  });
});
