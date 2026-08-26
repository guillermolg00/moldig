/**
 * The detector rules of §7 that no committed fixture can produce: a lock whose recorded tree
 * hash disagrees with the folder (drift), a git-tracked entry holding a literal secret and a
 * configuration nothing reads (exposure), and the two orders. Everything a real tree can show is
 * asserted over one in `detectors.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type {
  ContextFile,
  DuplicatesEdge,
  Edge,
  Entity,
  Finding,
  Harness,
  HarnessCache,
  Index,
  LoadedByEdge,
  McpServer,
  MemoryFile,
  Metrics,
  Project,
  Skill,
} from "../index/types.js";
import { MULTIPLIERS } from "../tokens/tokenizer.js";
import { audit, compareForDisplay, compareSerialised, isPreselected } from "./audit.js";

const NOW = "2026-08-26T12:00:00.000Z";

function metrics(overrides: Partial<Metrics> = {}): Metrics {
  return {
    bytes: 100,
    files: 1,
    lines: 10,
    mtime: NOW,
    ageDays: 1,
    tokens: { o200k: 25, method: "o200k_base" },
    lastUsed: null,
    ...overrides,
  };
}

function base(id: string, overrides: Partial<Entity> = {}): Omit<Entity, "kind"> {
  return {
    id,
    harness: "claude-code",
    producer: null,
    project: null,
    scope: "user",
    ownership: "human",
    shared: null,
    gitStatus: "outside-repo",
    path: `/x/${id}`,
    relativePath: null,
    locator: { type: "file", path: `/x/${id}` },
    format: "md",
    label: id,
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: metrics(),
    ...overrides,
  };
}

function contextFile(id: string, overrides: Partial<ContextFile> = {}): ContextFile {
  return {
    ...base(id),
    kind: "context-file",
    form: "context",
    fileName: "CLAUDE.md",
    frontmatter: {},
    importCount: 0,
    containsMemorySection: false,
    ...overrides,
  };
}

function skill(id: string, overrides: Partial<Skill> = {}): Skill {
  return {
    ...base(id),
    kind: "skill",
    format: "dir",
    form: "skill-dir",
    name: id.replace(/^skill:/, ""),
    dirName: id.replace(/^skill:/, ""),
    frontmatterName: null,
    layout: "canonical",
    placements: [],
    frontmatter: {},
    sidecars: [],
    contentHash: [{ algo: "git-tree-sha1", value: "a".repeat(40) }],
    origin: null,
    drift: "unknown",
    ...overrides,
  };
}

function mcpServer(id: string, overrides: Partial<McpServer> = {}): McpServer {
  return {
    ...base(id),
    kind: "mcp-server",
    format: "json",
    sensitive: true,
    locator: { type: "entry", file: "/x/.mcp.json", format: "json", keyPath: ["mcpServers", "s"] },
    path: "/x/.mcp.json",
    name: "posthog",
    transport: "http",
    command: null,
    args: [],
    url: "https://mcp.example.com/mcp",
    envKeys: [],
    headerKeys: [],
    secretKeys: [],
    hasOauth: false,
    usesInterpolation: false,
    enabled: null,
    approval: "approved",
    invalid: null,
    endpointKey: "http:mcp.example.com/mcp",
    rawKeys: [],
    ...overrides,
  };
}

function cacheUnit(id: string, overrides: Partial<HarnessCache> = {}): HarnessCache {
  return {
    ...base(id),
    kind: "harness-cache",
    ownership: "harness",
    format: "jsonl",
    sensitive: true,
    metrics: metrics({ tokens: null, ageDays: 45 }),
    cacheKind: "transcript",
    unit: "session",
    surface: "cli",
    session: null,
    slug: null,
    rule: "swept",
    retention: { days: 20, bytes: null, count: null, source: "cleanupPeriodDays" },
    liveGuard: { kind: "pid", alive: false },
    userContent: false,
    members: { files: 1, bytes: 100, oldest: null, newest: null },
    ...overrides,
  };
}

function memoryFile(id: string, overrides: Partial<MemoryFile> = {}): MemoryFile {
  return {
    ...base(id),
    kind: "memory-file",
    ownership: "harness",
    role: "index",
    unit: "/x/memory",
    owner: "project",
    frontmatter: {},
    loadedPortion: null,
    reads: null,
    writes: null,
    neverRead: null,
    readSignal: { source: "none", exact: false, bashParsed: false },
    ...overrides,
  };
}

function harness(overrides: Partial<Harness> = {}): Harness {
  return {
    id: "harness:claude-code",
    harness: "claude-code",
    displayName: "Claude Code",
    surfaces: ["cli"],
    presence: "installed",
    version: null,
    effectiveModel: null,
    modelFamily: null,
    contextWindowTokens: null,
    capabilities: {
      memoryLocation: "file",
      memoryReadSignal: "exact",
      contextFileNames: ["CLAUDE.md"],
      sweepDocumented: true,
    },
    caps: {
      memoryIndexLines: 200,
      memoryIndexBytes: 25_600,
      chainMaxBytes: null,
      skillDescriptionChars: null,
      importDepth: 4,
    },
    effectiveSettings: {},
    breadcrumbSources: [],
    userScope: { paths: [], stray: [], baseline: { items: [], tokens: 100 } },
    ...overrides,
  };
}

function project(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    path: `/x/${id}`,
    displayName: id.replace(/^project:/, ""),
    kind: "repository",
    reachability: "present",
    unreachableReason: null,
    enclosesCwd: false,
    discoveredBy: ["breadcrumb"],
    parent: null,
    members: [],
    breadcrumbs: [],
    nestedMarkers: [],
    perHarness: {},
    ...overrides,
  };
}

function index(overrides: Partial<Index> = {}): Index {
  return {
    schemaVersion: 0,
    generatedAt: NOW,
    moldig: { version: "0.0.0" },
    scan: {
      home: "/x/home",
      roots: [],
      cwd: "/x",
      platform: "darwin",
      caseFold: true,
      env: {},
      git: { available: false, version: null },
      durationMs: 0,
    },
    tokenizer: {
      name: "gpt-tokenizer",
      version: "4.0.0",
      encoding: "o200k_base",
      fallbackUsed: false,
      multipliers: MULTIPLIERS,
    },
    harnesses: [harness()],
    projects: [],
    breadcrumbs: [],
    entities: [],
    edges: [],
    warnings: [],
    totals: {
      entities: 0,
      files: 0,
      bytes: 0,
      harnessCacheBytes: 0,
      memoryBytes: 0,
      tokens: 0,
    },
    ...overrides,
  };
}

function duplicatesEdge(from: string, to: string, same: DuplicatesEdge["same"]): Edge {
  return {
    id: `edge:duplicates:${from}:${to}`,
    kind: "duplicates",
    from,
    to,
    same,
    confidence: same === "content" ? "certain" : "medium",
    evidence: [],
  };
}

function of(findings: Finding[], category: string): Finding[] {
  return findings.filter((finding) => finding.category === category);
}

describe("isPreselected (ticket 08)", () => {
  it("preselects a swept unit older than its retention with a clear live guard", () => {
    expect(isPreselected(cacheUnit("harness-cache:/x"))).toBe(true);
  });
  it("never preselects within retention, without a guard, alive, kept, undocumented or user content", () => {
    expect(isPreselected(cacheUnit("a", { metrics: metrics({ tokens: null, ageDays: 20 }) }))).toBe(
      false,
    );
    expect(isPreselected(cacheUnit("a", { liveGuard: null }))).toBe(false);
    expect(isPreselected(cacheUnit("a", { liveGuard: { kind: "pid", alive: true } }))).toBe(false);
    expect(isPreselected(cacheUnit("a", { rule: "kept" }))).toBe(false);
    expect(isPreselected(cacheUnit("a", { rule: "undocumented" }))).toBe(false);
    expect(isPreselected(cacheUnit("a", { userContent: true }))).toBe(false);
    expect(
      isPreselected(
        cacheUnit("a", {
          retention: { days: null, bytes: null, count: 5, source: "claude-directory" },
        }),
      ),
    ).toBe(false);
  });
});

describe("bloat (§7.4, D7, D81)", () => {
  const file = contextFile("context-file:/x/claude.md", { metrics: metrics({ bytes: 40_000 }) });
  const loaded = (tokens: number): LoadedByEdge => ({
    id: "edge:loaded-by:a",
    kind: "loaded-by",
    from: file.id,
    to: "harness:claude-code",
    confidence: "certain",
    evidence: [],
    project: null,
    mode: "full",
    reason: "user scope",
    placement: null,
    effectiveName: null,
    order: 0,
    charsLoaded: null,
    importsResolved: null,
    tokensLoaded: tokens,
    disableModelInvocation: null,
    countsTowardHeadline: true,
  });

  it("files nothing below 2,000 loaded tokens and medium at the threshold", async () => {
    const under = await audit(index({ entities: [file], edges: [loaded(1999)] }));
    expect(of(under.findings, "bloat")).toHaveLength(0);
    const at = await audit(index({ entities: [file], edges: [loaded(2000)] }));
    expect(of(at.findings, "bloat")[0]?.severity).toBe("medium");
  });

  it("raises to high at 8,000, never proposes a destructive action and never preselects", async () => {
    const result = await audit(index({ entities: [file], edges: [loaded(8000)] }));
    const finding = of(result.findings, "bloat")[0];
    expect(finding?.severity).toBe("high");
    expect(finding?.action).toEqual({
      kind: "open",
      preselect: false,
      locator: { type: "file", path: "/x/context-file:/x/claude.md" },
    });
    expect(finding?.message).toBe(
      "context-file:/x/claude.md costs 8000 tokens in every Claude Code session",
    );
    expect(finding?.impact).toEqual({ bytes: 40_000, tokens: 8000, files: 1 });
  });

  it("takes the maximum tokensLoaded across readers, not the first or the sum", async () => {
    const second: LoadedByEdge = { ...loaded(3000), id: "edge:loaded-by:b" };
    const result = await audit(index({ entities: [file], edges: [loaded(2100), second] }));
    expect(of(result.findings, "bloat")[0]?.impact.tokens).toBe(3000);
  });

  it("ignores an on-demand reader: a skill body costs a session nothing until it is used", async () => {
    const onDemand: LoadedByEdge = { ...loaded(9000), mode: "on-demand" };
    const result = await audit(index({ entities: [file], edges: [onDemand] }));
    expect(of(result.findings, "bloat")).toHaveLength(0);
  });

  it("drops to medium confidence when the count fell back to bytes/4", async () => {
    const estimated = contextFile("context-file:/x/e.md", {
      metrics: metrics({ bytes: 40_000, tokens: { o200k: 10_000, method: "bytes/4" } }),
    });
    const edge: LoadedByEdge = { ...loaded(2500), from: estimated.id };
    const result = await audit(index({ entities: [estimated], edges: [edge] }));
    expect(of(result.findings, "bloat")[0]?.confidence).toBe("medium");
  });

  it("files a memory index beyond the harness cap whatever the count, naming the truncated portion", async () => {
    const memory = memoryFile("memory-file:/x/memory/memory.md", {
      project: "project:/x/p",
      metrics: metrics({
        bytes: 27_000,
        lines: 260,
        tokens: { o200k: 6500, method: "o200k_base" },
      }),
      loadedPortion: { lines: 200, bytes: 25_600, tokens: 100, confidence: "certain" },
    });
    const result = await audit(
      index({ entities: [memory], projects: [project("project:/x/p")], edges: [] }),
    );
    const finding = of(result.findings, "bloat")[0];
    expect(finding?.message).toContain("60 lines / 1400 bytes never reach a session");
    expect(finding?.severity).toBe("medium");
    expect(finding?.flags).toContain("memory");
    expect(finding?.action.kind).toBe("open");
  });
});

describe("drift (§7.6, D9, D80, D44)", () => {
  const lock = {
    installer: "vercel-skills" as const,
    sourceType: "github" as const,
    source: "acme/skills",
    sourceUrl: null,
    ref: null,
    skillPath: null,
    recordedHash: { algo: "git-tree-sha1" as const, value: "b".repeat(40) },
    installedAt: null,
    updatedAt: null,
    lock: {
      type: "entry" as const,
      file: "/x/home/.agents/.skill-lock.json",
      format: "json" as const,
      keyPath: ["skills", "skill-a"],
    },
  };

  it("files nothing for drift: unknown", async () => {
    const result = await audit(index({ entities: [skill("skill:/x/a", { origin: lock })] }));
    expect(of(result.findings, "drift")).toHaveLength(0);
  });

  it("names the installer and the lock file, and delegates Update to it", async () => {
    const edited = skill("skill:/x/a", {
      name: "agent-browser",
      origin: lock,
      drift: "local-modified",
    });
    const result = await audit(index({ entities: [edited] }));
    const finding = of(result.findings, "drift")[0];
    expect(finding?.severity).toBe("medium");
    expect(finding?.message).toBe(
      "agent-browser was edited after vercel-skills installed it (.skill-lock.json)",
    );
    expect(finding?.evidence[0]).toEqual({
      kind: "content-hash",
      detail: `git-tree-sha1 ${"a".repeat(12)} ≠ lock ${"b".repeat(12)}`,
    });
    expect(finding?.action).toEqual({
      kind: "update",
      preselect: false,
      locator: { type: "dir", path: "/x/skill:/x/a" },
    });
  });

  it("falls back to open when no installer owns the copy", async () => {
    const edited = skill("skill:/x/a", {
      origin: { ...lock, installer: "git-clone" },
      drift: "local-modified",
    });
    const result = await audit(index({ entities: [edited] }));
    expect(of(result.findings, "drift")[0]?.action.kind).toBe("open");
  });

  it("names both conditions in one finding when a copy is edited and the copies differ", async () => {
    const left = skill("skill:/x/a", {
      name: "agent-browser",
      origin: lock,
      drift: "local-modified",
      scope: "project",
      project: "project:/x/p",
    });
    const right = skill("skill:/x/b", {
      contentHash: [{ algo: "git-tree-sha1", value: "c".repeat(40) }],
      scope: "user",
    });
    const result = await audit(
      index({
        entities: [left, right],
        projects: [project("project:/x/p", { displayName: "p" })],
        edges: [duplicatesEdge(left.id, right.id, "origin")],
      }),
    );
    const finding = of(result.findings, "drift")[0];
    expect(finding?.message).toBe(
      "agent-browser was edited after vercel-skills installed it (.skill-lock.json), and agent-browser at project scope of p differs from the copy at user scope",
    );
    expect(finding?.targets.map((target) => target.role)).toEqual(["subject", "counterpart"]);
    // D80: one drift finding, plus its own duplicate finding — never one merged row.
    expect(of(result.findings, "duplicate")).toHaveLength(1);
  });

  it("takes the shared flag from a placement when the store lies outside any repository (D143)", async () => {
    const edited = skill("skill:/x/a", {
      origin: lock,
      drift: "local-modified",
      shared: null,
      placements: [
        {
          path: "/x/p/.claude/skills/a",
          harness: "claude-code",
          surface: "cli",
          scope: "project",
          project: "project:/x/p",
          gitStatus: "tracked",
          shared: true,
          isSymlink: true,
          linkTarget: "/x/skill:/x/a",
          dangling: false,
        },
      ],
    });
    const result = await audit(index({ entities: [edited] }));
    expect(of(result.findings, "drift")[0]?.flags).toContain("shared");
  });
});

describe("exposure (§7.9, D10, D83, D112)", () => {
  const secret = "sk-live-0123456789abcdef";
  const tracked = mcpServer("mcp-server:/x/p/.mcp.json#mcpServers/posthog", {
    project: "project:/x/p",
    scope: "project",
    shared: true,
    gitStatus: "tracked",
    headerKeys: ["Authorization"],
    secretKeys: ["Authorization"],
    locator: {
      type: "entry",
      file: "/x/p/.mcp.json",
      format: "json",
      keyPath: ["mcpServers", "posthog"],
    },
    path: "/x/p/.mcp.json",
  });

  it("is high and secret-exposed when the entry is git-tracked, and never carries the value", async () => {
    const result = await audit(index({ entities: [tracked], projects: [project("project:/x/p")] }));
    const finding = of(result.findings, "exposure")[0];
    expect(finding?.severity).toBe("high");
    expect(finding?.flags).toEqual(["shared", "sensitive", "secret-exposed"]);
    expect(finding?.message).toBe(
      "posthog carries an Authorization header in a git-tracked .mcp.json",
    );
    expect(finding?.evidence).toEqual([
      { kind: "secret-key", detail: "headers.Authorization" },
      { kind: "git-status", detail: "tracked" },
    ]);
    expect(JSON.stringify(finding)).not.toContain(secret);
    expect(finding?.action.kind).toBe("open");
  });

  it("is medium and sensitive — never secret-exposed — when the harness is not installed", async () => {
    const result = await audit(
      index({
        harnesses: [harness({ presence: "absent" })],
        entities: [mcpServer("mcp-server:/x/a", { envKeys: ["API_KEY"], secretKeys: ["API_KEY"] })],
      }),
    );
    const finding = of(result.findings, "exposure")[0];
    expect(finding?.severity).toBe("medium");
    expect(finding?.flags).toEqual(["sensitive"]);
    expect(finding?.flags).not.toContain("secret-exposed");
    expect(finding?.message).toBe(
      "posthog carries a literal API_KEY in .mcp.json, which Claude Code is not installed for",
    );
    expect(finding?.evidence).toEqual([
      { kind: "secret-key", detail: "env.API_KEY" },
      { kind: "loading-rule", detail: "presence: absent" },
    ]);
  });

  it("is medium when the entry is disabled", async () => {
    const result = await audit(
      index({
        entities: [
          mcpServer("mcp-server:/x/a", {
            envKeys: ["API_KEY"],
            secretKeys: ["API_KEY"],
            enabled: false,
          }),
        ],
      }),
    );
    expect(of(result.findings, "exposure")[0]?.message).toContain("which Claude Code has disabled");
  });

  it("is medium when a reader never loads the file", async () => {
    const entry = mcpServer("mcp-server:/x/a", { envKeys: ["TOKEN"], secretKeys: ["TOKEN"] });
    const never: LoadedByEdge = {
      id: "edge:loaded-by:a",
      kind: "loaded-by",
      from: entry.id,
      to: "harness:claude-code",
      confidence: "certain",
      evidence: [],
      project: null,
      mode: "never",
      reason: "~/.claude/.mcp.json is not a configuration layer",
      placement: null,
      effectiveName: null,
      order: null,
      charsLoaded: null,
      importsResolved: null,
      tokensLoaded: null,
      disableModelInvocation: null,
      countsTowardHeadline: false,
    };
    const result = await audit(index({ entities: [entry], edges: [never] }));
    const finding = of(result.findings, "exposure")[0];
    expect(finding?.severity).toBe("medium");
    expect(finding?.message).toContain("which Claude Code does not read");
    expect(finding?.evidence[1]?.detail).toBe("~/.claude/.mcp.json is not a configuration layer");
  });

  it("files nothing for a private, loaded, user-scope configuration", async () => {
    const result = await audit(
      index({
        entities: [mcpServer("mcp-server:/x/a", { envKeys: ["TOKEN"], secretKeys: ["TOKEN"] })],
      }),
    );
    expect(of(result.findings, "exposure")).toHaveLength(0);
  });

  it("files nothing when every value is interpolated: secretKeys stays empty", async () => {
    const result = await audit(
      index({
        entities: [
          mcpServer("mcp-server:/x/a", {
            shared: true,
            headerKeys: ["Authorization"],
            secretKeys: [],
            usesInterpolation: true,
          }),
        ],
      }),
    );
    expect(of(result.findings, "exposure")).toHaveLength(0);
  });
});

describe("duplicate (§7.3, D79, D133)", () => {
  it("files one finding per component, the lowest id as subject", async () => {
    const a = skill("skill:/x/a", { label: "agent-browser", scope: "user" });
    const b = skill("skill:/x/b", { label: "agent-browser", scope: "project" });
    const c = skill("skill:/x/c", { label: "agent-browser", scope: "local" });
    const result = await audit(
      index({
        entities: [a, b, c],
        edges: [duplicatesEdge(a.id, b.id, "content"), duplicatesEdge(b.id, c.id, "content")],
      }),
    );
    const findings = of(result.findings, "duplicate");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.targets.map((target) => target.id)).toEqual([a.id, b.id, c.id]);
    expect(findings[0]?.confidence).toBe("certain");
    expect(findings[0]?.message).toBe(
      "agent-browser has the same content as agent-browser, agent-browser",
    );
    expect(findings[0]?.impact.bytes).toBe(200);
    expect(findings[0]?.action.kind).toBe("open");
  });

  it("keeps the MCP endpoint finding and the edge's confidence split (D133)", async () => {
    const a = mcpServer("mcp-server:/x/a", { label: "posthog", endpointKey: "stdio:npx posthog" });
    const b = mcpServer("mcp-server:/x/b", { label: "posthog", endpointKey: "stdio:npx posthog" });
    const result = await audit(
      index({ entities: [a, b], edges: [duplicatesEdge(a.id, b.id, "endpoint")] }),
    );
    const finding = of(result.findings, "duplicate")[0];
    expect(finding?.confidence).toBe("medium");
    expect(finding?.message).toBe(
      "MCP server posthog is configured 2 times with the same endpoint (user scope)",
    );
    expect(finding?.evidence).toEqual([{ kind: "endpoint", detail: "stdio:npx posthog" }]);
  });

  it("never files one for context files, whose duplicates edges stay (D79)", async () => {
    const a = contextFile("context-file:/x/a.md");
    const b = contextFile("context-file:/x/b.md");
    const result = await audit(
      index({ entities: [a, b], edges: [duplicatesEdge(a.id, b.id, "content")] }),
    );
    expect(of(result.findings, "duplicate")).toHaveLength(0);
    expect(result.edges.filter((edge) => edge.kind === "duplicates")).toHaveLength(1);
  });

  it("splits confidence by the kind of sameness for skills", async () => {
    const byName = async (same: DuplicatesEdge["same"]): Promise<string | undefined> => {
      const a = skill("skill:/x/a");
      const b = skill("skill:/x/b");
      const result = await audit(
        index({ entities: [a, b], edges: [duplicatesEdge(a.id, b.id, same)] }),
      );
      return of(result.findings, "duplicate")[0]?.confidence;
    };
    expect(await byName("content")).toBe("certain");
    expect(await byName("origin")).toBe("high");
    expect(await byName("name")).toBe("medium");
  });
});

describe("orphan and shadow-memory rules the fixtures cannot show", () => {
  it("lists a gone Project's kept state with Delete, never in a clean group (D111)", async () => {
    const gone = project("project:/x/gone", { reachability: "orphan", kind: "unknown" });
    const kept = cacheUnit("harness-cache:/x/gone/history.jsonl", {
      project: gone.id,
      rule: "kept",
      cacheKind: "database",
    });
    const result = await audit(index({ projects: [gone], entities: [kept] }));
    const finding = of(result.findings, "orphan")[0];
    expect(finding?.action.kind).toBe("delete");
    expect(finding?.targets.map((target) => target.role)).toEqual(["state"]);
    // A kept unit never enters the harness-cache clean group either.
    expect(of(result.findings, "harness-cache")).toHaveLength(0);
  });

  it("cleans a gone Project's swept cache and memory (D111)", async () => {
    const gone = project("project:/x/gone", { reachability: "orphan", kind: "unknown" });
    const swept = cacheUnit("harness-cache:/x/gone/a.jsonl", { project: gone.id });
    const result = await audit(index({ projects: [gone], entities: [swept] }));
    const finding = of(result.findings, "orphan")[0];
    expect(finding?.action).toEqual({ kind: "clean", preselect: true, locator: null });
    expect(finding?.targets[0]?.preselect).toBe(true);
  });

  it("files an orphan for a tool name nothing resolves, low twice over (§7.5 rule 4)", async () => {
    const file = contextFile("context-file:/x/claude.md", { label: "CLAUDE.md" });
    const edge: Edge = {
      id: "edge:names-tool:a:posthog",
      kind: "names-tool",
      from: file.id,
      to: null,
      tool: "posthog",
      confidence: "medium",
      evidence: [{ kind: "body-mention", detail: "line 41: use the posthog MCP" }],
    };
    const result = await audit(index({ entities: [file], edges: [edge] }));
    const finding = of(result.findings, "orphan")[0];
    expect(finding?.id).toBe("finding:orphan:context-file:/x/claude.md:posthog");
    expect(finding?.severity).toBe("low");
    expect(finding?.confidence).toBe("low");
    expect(finding?.message).toBe(
      "CLAUDE.md names the MCP server posthog, which is configured for no harness",
    );
    expect(finding?.evidence).toEqual([
      { kind: "name-only", detail: "line 41: use the posthog MCP" },
    ]);
  });

  it("files the legacy memory section under shadow-memory, open and low (D84)", async () => {
    const file = contextFile("context-file:/x/gemini.md", {
      label: "GEMINI.md",
      harness: "gemini-cli",
      containsMemorySection: true,
    });
    const result = await audit(
      index({
        harnesses: [harness({ harness: "gemini-cli", displayName: "Gemini CLI" })],
        entities: [file],
      }),
    );
    const finding = of(result.findings, "shadow-memory")[0];
    expect(finding?.severity).toBe("low");
    expect(finding?.action.kind).toBe("open");
    expect(finding?.message).toContain("## Gemini Added Memories");
  });
});

describe("the headline (§7.10, D77, D86)", () => {
  it("lists only installed harnesses and leaves pctOfContext null without a context window", async () => {
    const result = await audit(
      index({
        harnesses: [
          harness(),
          harness({ id: "harness:codex", harness: "codex", presence: "config-only" }),
        ],
      }),
    );
    expect(result.headline.perHarness.map((row) => row.harness)).toEqual(["claude-code"]);
    expect(result.headline.perHarness[0]?.pctOfContext).toBeNull();
    expect(result.headline.focus).toEqual({ project: null, reason: "none" });
  });

  it("focuses the Project enclosing cwd, then the most expensive, never a gone one", async () => {
    const cwd = project("project:/x/cwd", { enclosesCwd: true });
    const rich = project("project:/x/rich", {
      perHarness: {
        "claude-code": {
          trusted: null,
          effectiveSettings: {},
          sessionLoad: { items: [], tokens: 9000 },
        },
      },
    });
    const gone = project("project:/x/gone", { reachability: "orphan", kind: "unknown" });
    expect((await audit(index({ projects: [gone, rich, cwd] }))).headline.focus).toEqual({
      project: cwd.id,
      reason: "cwd",
    });
    expect((await audit(index({ projects: [gone, rich] }))).headline.focus).toEqual({
      project: rich.id,
      reason: "most-expensive",
    });
    // An explicit focus that does not enclose cwd is labelled most-expensive.
    expect(
      (await audit(index({ projects: [rich, cwd] }), { focus: rich.id })).headline.focus,
    ).toEqual({ project: rich.id, reason: "most-expensive" });
    expect((await audit(index({ projects: [gone] }))).headline.focus).toEqual({
      project: null,
      reason: "none",
    });
  });

  it("applies the model family multipliers to both halves", async () => {
    const focused = project("project:/x/p", {
      enclosesCwd: true,
      perHarness: {
        "claude-code": {
          trusted: null,
          effectiveSettings: {},
          sessionLoad: { items: [], tokens: 1000 },
        },
      },
    });
    const result = await audit(
      index({
        harnesses: [harness({ modelFamily: "anthropic-47plus", contextWindowTokens: 200_000 })],
        projects: [focused],
      }),
    );
    const row = result.headline.perHarness[0];
    expect(row?.baseline).toEqual({ low: 130, mid: 150, high: 165 });
    expect(row?.project).toEqual({ low: 1300, mid: 1500, high: 1650 });
    expect(row?.total).toEqual({ low: 1430, mid: 1650, high: 1815 });
    expect(row?.pctOfContext).toBe(0.8);
  });
});

function findingRow(overrides: Partial<Finding>): Finding {
  return {
    id: "finding:x",
    category: "duplicate",
    severity: "low",
    container: null,
    targets: [{ id: "a", role: "subject" }],
    message: "",
    evidence: [],
    confidence: "certain",
    impact: { bytes: 0, tokens: null, files: 0 },
    flags: [],
    action: { kind: "open", preselect: false, locator: null },
    ...overrides,
  };
}

describe("the two orders (§7.1, D85)", () => {
  it("displays the glossary's category order, whatever the serialised order says", () => {
    const rows = [
      findingRow({ id: "1", category: "exposure" }),
      findingRow({ id: "2", category: "harness-cache" }),
      findingRow({ id: "3", category: "autogenerated" }),
      findingRow({ id: "4", category: "shadow-memory" }),
      findingRow({ id: "5", category: "drift" }),
      findingRow({ id: "6", category: "bloat" }),
      findingRow({ id: "7", category: "orphan" }),
      findingRow({ id: "8", category: "duplicate" }),
    ];
    expect(rows.toSorted(compareForDisplay).map((finding) => finding.category)).toEqual([
      "duplicate",
      "orphan",
      "bloat",
      "drift",
      "shadow-memory",
      "autogenerated",
      "harness-cache",
      "exposure",
    ]);
    // The serialised order is alphabetical on the category, and is not the display order.
    expect(rows.toSorted(compareSerialised).map((finding) => finding.category)).toEqual([
      "autogenerated",
      "bloat",
      "drift",
      "duplicate",
      "exposure",
      "harness-cache",
      "orphan",
      "shadow-memory",
    ]);
  });

  it("pins a flagged finding above a bigger unflagged one, then sorts by bytes descending", () => {
    const rows = [
      findingRow({ id: "small-plain", impact: { bytes: 1, tokens: null, files: 0 } }),
      findingRow({ id: "huge-plain", impact: { bytes: 9000, tokens: null, files: 0 } }),
      findingRow({
        id: "flagged",
        flags: ["shared"],
        impact: { bytes: 2, tokens: null, files: 0 },
      }),
      findingRow({
        id: "flagged-bigger",
        flags: ["memory"],
        impact: { bytes: 3, tokens: null, files: 0 },
      }),
    ];
    expect(rows.toSorted(compareForDisplay).map((finding) => finding.id)).toEqual([
      "flagged-bigger",
      "flagged",
      "huge-plain",
      "small-plain",
    ]);
  });

  it("breaks a full tie by the serialised order, so two runs render alike", () => {
    const a = findingRow({ id: "finding:duplicate:a", targets: [{ id: "a", role: "subject" }] });
    const b = findingRow({ id: "finding:duplicate:b", targets: [{ id: "b", role: "subject" }] });
    expect([b, a].toSorted(compareForDisplay).map((finding) => finding.id)).toEqual([a.id, b.id]);
    expect(compareSerialised(a, b)).toBeLessThan(0);
  });
});
