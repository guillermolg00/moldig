/**
 * THROWAWAY PROTOTYPE — ticket 13 (ego-graph screen), folded into ticket 09.
 *
 * A small fake AuditIndex for the graph screen's own tests (not the shell's fake):
 * one skill in the centre, every legend edge kind around it, three hop-2 nodes behind
 * the Claude Code harness, and four edges of the hidden kinds. Ids follow ticket 07
 * (`<kind>:<folded canonical locator>`, `edge:<kind>:<from>:<to>[:<tool>]`); paths use
 * the fixture placeholders `<HOME>` / `<ROOT>`.
 */
import type {
  AgentDefinition,
  AuditIndex,
  Confidence,
  ContextFile,
  DuplicatesEdge,
  Edge,
  Entity,
  EntityBase,
  EntityKind,
  Harness,
  HarnessId,
  LoadedByEdge,
  McpServer,
  MemoryFile,
  Metrics,
  NamesEdge,
  NamesToolEdge,
  OriginatesFromEdge,
  Placement,
  Plugin,
  Project,
  SettingsFile,
  Skill,
} from "@moldig/core";

export const HOME = "<HOME>";
export const ROOT = "<ROOT>";

export const IDS = {
  focus: `skill:${HOME}/.agents/skills/agent-browser`,
  projectClaudeMd: `context-file:${ROOT}/vlue/claude.md`,
  userClaudeMd: `context-file:${HOME}/.claude/claude.md`,
  agentsMd: `context-file:${ROOT}/vlue/agents.md`,
  posthog: `mcp-server:${ROOT}/vlue/.mcp.json#mcpservers/posthog`,
  memory: `memory-file:${HOME}/.claude/projects/__ROOT__-vlue/memory/memory.md`,
  fact: `memory-file:${HOME}/.claude/projects/__ROOT__-vlue/memory/vlue-api.md`,
  lock: `settings-file:${HOME}/.agents/.skill-lock.json`,
  copy: `skill:${ROOT}/vlue/.claude/skills/agent-browser`,
  dangling: `skill:${HOME}/.claude/skills/old-skill`,
  plugin: `plugin:${HOME}/.claude/plugins/cache/frontend-design@anthropic/1.2.0`,
  reviewer: `agent-definition:${ROOT}/vlue/.claude/agents/reviewer.md`,
  claudeCode: "harness:claude-code",
  cursor: "harness:cursor",
  vlue: `project:${ROOT}/vlue`,
} as const;

// ---------- builders (exported so tests can grow their own indexes) ----------

export function metrics(over: Partial<Metrics> = {}): Metrics {
  return {
    bytes: 1024,
    files: 1,
    lines: 40,
    mtime: "2026-08-01T10:00:00Z",
    ageDays: 25,
    tokens: { o200k: 250, method: "o200k_base" },
    lastUsed: null,
    ...over,
  };
}

function base(kind: EntityKind, id: string, path: string, over: Partial<EntityBase>): EntityBase {
  return {
    id,
    kind,
    harness: "claude-code",
    producer: null,
    project: IDS.vlue,
    scope: "project",
    ownership: "human",
    shared: true,
    gitStatus: "tracked",
    path,
    relativePath: null,
    locator: { type: "file", path },
    format: "md",
    label: path.split("/").pop() ?? path,
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: metrics(),
    ...over,
  };
}

export function contextFile(id: string, path: string, over: Partial<EntityBase> = {}): ContextFile {
  return {
    ...base("context-file", id, path, over),
    kind: "context-file",
    form: "context",
    fileName: path.split("/").pop() ?? path,
    frontmatter: {},
    importCount: 0,
    containsMemorySection: false,
  };
}

export function placement(path: string, over: Partial<Placement> = {}): Placement {
  return {
    path,
    harness: null,
    surface: null,
    scope: "user",
    project: null,
    gitStatus: "outside-repo",
    shared: null,
    isSymlink: false,
    linkTarget: null,
    dangling: false,
    ...over,
  };
}

export function skill(
  id: string,
  path: string,
  over: Partial<EntityBase> = {},
  placements: Placement[] = [placement(path)],
): Skill {
  const name = path.split("/").pop() ?? path;
  return {
    ...base("skill", id, path, { locator: { type: "dir", path }, format: "dir", ...over }),
    kind: "skill",
    form: "skill-dir",
    name,
    dirName: name,
    frontmatterName: name,
    layout: "canonical",
    placements,
    frontmatter: { name, description: `${name} skill` },
    sidecars: [],
    contentHash: [{ algo: "git-tree-sha1", value: "3f786850e387550fdab836ed7e6dc881de23001b" }],
    origin: null,
    drift: "none",
  };
}

export function mcpServer(
  id: string,
  file: string,
  name: string,
  over: Partial<EntityBase> = {},
): McpServer {
  return {
    ...base("mcp-server", id, file, {
      locator: { type: "entry", file, format: "json", keyPath: ["mcpServers", name] },
      format: "json",
      label: name,
      sensitive: true,
      removal: { method: "backup-edit" },
      metrics: metrics({ files: null, lines: null, tokens: null }),
      ...over,
    }),
    kind: "mcp-server",
    name,
    transport: "http",
    command: null,
    args: [],
    url: `https://mcp.${name}.com/mcp`,
    envKeys: [],
    headerKeys: [],
    secretKeys: [],
    hasOauth: false,
    usesInterpolation: false,
    enabled: null,
    approval: "approved",
    invalid: null,
    endpointKey: `http:mcp.${name}.com/mcp`,
    rawKeys: ["type", "url"],
  };
}

export function memoryFile(
  id: string,
  path: string,
  role: MemoryFile["role"],
  over: Partial<EntityBase> = {},
): MemoryFile {
  const unit = path.slice(0, path.lastIndexOf("/"));
  return {
    ...base("memory-file", id, path, {
      scope: "user",
      ownership: "harness",
      shared: null,
      gitStatus: "outside-repo",
      ...over,
    }),
    kind: "memory-file",
    role,
    unit,
    owner: "project",
    frontmatter: {},
    loadedPortion:
      role === "index" ? { lines: 40, bytes: 1024, tokens: 250, confidence: "certain" } : null,
    reads: null,
    writes: null,
    neverRead: null,
    readSignal: { source: "not-computed", exact: false, bashParsed: false },
  };
}

export function settingsFile(
  id: string,
  path: string,
  role: SettingsFile["role"],
  over: Partial<EntityBase> = {},
): SettingsFile {
  return {
    ...base("settings-file", id, path, {
      format: "json",
      metrics: metrics({ tokens: null }),
      ...over,
    }),
    kind: "settings-file",
    role,
    topLevelKeys: ["skills"],
    entries: 1,
    hooks: [],
  };
}

export function plugin(
  id: string,
  path: string,
  pluginId: string,
  over: Partial<EntityBase> = {},
): Plugin {
  return {
    ...base("plugin", id, path, {
      locator: { type: "dir", path },
      format: "dir",
      label: pluginId,
      scope: "user",
      project: null,
      shared: null,
      gitStatus: "outside-repo",
      ...over,
    }),
    kind: "plugin",
    pluginId,
    version: "1.2.0",
    marketplace: pluginId.split("@")[1] ?? null,
    installs: [{ scope: "user", project: null, enabled: true }],
    origin: null,
    hooks: [],
  };
}

export function agentDefinition(
  id: string,
  path: string,
  over: Partial<EntityBase> = {},
): AgentDefinition {
  const name = (path.split("/").pop() ?? path).replace(/\.md$/, "");
  return {
    ...base("agent-definition", id, path, { label: name, ...over }),
    kind: "agent-definition",
    name,
    form: "markdown",
    frontmatter: { skills: ["agent-browser"] },
    hooks: [],
  };
}

export function harness(id: HarnessId, displayName: string): Harness {
  return {
    id: `harness:${id}`,
    harness: id,
    displayName,
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
      memoryIndexLines: null,
      memoryIndexBytes: null,
      chainMaxBytes: null,
      skillDescriptionChars: null,
      importDepth: null,
    },
    effectiveSettings: {},
    breadcrumbSources: [],
    userScope: { paths: [], stray: [], baseline: { items: [], tokens: 0 } },
  };
}

export function project(id: string, path: string, over: Partial<Project> = {}): Project {
  return {
    id,
    path,
    displayName: path.split("/").pop() ?? path,
    kind: "repository",
    reachability: "present",
    unreachableReason: null,
    enclosesCwd: false,
    discoveredBy: ["breadcrumb"],
    parent: null,
    members: [{ path, role: "repository", name: null, gitdir: null, reachability: "present" }],
    breadcrumbs: [],
    nestedMarkers: [],
    perHarness: {},
    ...over,
  };
}

export function names(from: string, to: string, confidence: Confidence = "high"): NamesEdge {
  return {
    id: `edge:names:${from}:${to}`,
    kind: "names",
    from,
    to,
    confidence,
    evidence: [{ kind: "body-mention" }],
  };
}

export function namesTool(
  from: string,
  to: string | null,
  tool: string,
  confidence: Confidence = "high",
): NamesToolEdge {
  return {
    id: `edge:names-tool:${from}:${to ?? ""}:${tool}`,
    kind: "names-tool",
    from,
    to,
    tool,
    confidence,
    evidence: [{ kind: "body-mention", detail: `use the ${tool} MCP` }],
  };
}

export function loadedBy(
  from: string,
  to: string,
  mode: LoadedByEdge["mode"],
  over: Partial<LoadedByEdge> = {},
): LoadedByEdge {
  return {
    id: `edge:loaded-by:${from}:${to}`,
    kind: "loaded-by",
    from,
    to,
    confidence: "certain",
    evidence: [{ kind: "loading-rule" }],
    project: null,
    mode,
    reason: "user scope",
    placement: null,
    effectiveName: null,
    order: null,
    charsLoaded: null,
    importsResolved: null,
    tokensLoaded: null,
    disableModelInvocation: null,
    countsTowardHeadline: mode === "full" || mode === "description-only",
    ...over,
  };
}

export function duplicates(
  from: string,
  to: string,
  same: DuplicatesEdge["same"],
  confidence: Confidence = "high",
): DuplicatesEdge {
  return {
    id: `edge:duplicates:${from}:${to}`,
    kind: "duplicates",
    from,
    to,
    same,
    confidence,
    evidence: [{ kind: "content-hash" }],
  };
}

export function originatesFrom(from: string, to: string): OriginatesFromEdge {
  return {
    id: `edge:originates-from:${from}:${to}`,
    kind: "originates-from",
    from,
    to,
    confidence: "certain",
    evidence: [{ kind: "lock-entry" }],
  };
}

export interface IndexParts {
  harnesses?: Harness[];
  projects?: Project[];
  entities?: Entity[];
  edges?: Edge[];
}

export function makeIndex(parts: IndexParts = {}): AuditIndex {
  const one = { low: 1, mid: 1, high: 1 };
  const entities = parts.entities ?? [];
  return {
    schemaVersion: 0,
    generatedAt: "2026-08-26T00:00:00Z",
    moldig: { version: "0.0.0" },
    scan: {
      home: HOME,
      roots: [ROOT],
      cwd: `${ROOT}/vlue`,
      platform: "darwin",
      caseFold: true,
      env: {},
      git: { available: true, version: "2.50.1" },
      durationMs: 1,
    },
    tokenizer: {
      name: "gpt-tokenizer",
      version: "4.0.0",
      encoding: "o200k_base",
      fallbackUsed: false,
      multipliers: { openai: one, google: one, "anthropic-46": one, "anthropic-47plus": one },
    },
    harnesses: parts.harnesses ?? [],
    projects: parts.projects ?? [],
    breadcrumbs: [],
    entities,
    edges: parts.edges ?? [],
    warnings: [],
    totals: {
      entities: entities.length,
      files: entities.length,
      bytes: entities.reduce((sum, e) => sum + e.metrics.bytes, 0),
      harnessCacheBytes: 0,
      memoryBytes: 0,
      tokens: 0,
    },
    findings: [],
    headline: {
      scope: "user-controllable",
      focus: { project: null, reason: "none" },
      perHarness: [],
    },
  };
}

// ---------- the fixture ----------

/** Hop 1 from the focus skill: 8 neighbours (one per legend kind at least); hop 2: 3 more. */
export function graphFixture(): AuditIndex {
  const focusPath = `${HOME}/.agents/skills/agent-browser`;
  const entities: Entity[] = [
    skill(
      IDS.focus,
      focusPath,
      { harness: null, project: null, scope: "user", shared: null, gitStatus: "outside-repo" },
      [
        placement(focusPath),
        placement(`${HOME}/.claude/skills/agent-browser`, {
          harness: "claude-code",
          surface: "cli",
          isSymlink: true,
          linkTarget: "../../.agents/skills/agent-browser",
        }),
      ],
    ),
    contextFile(IDS.projectClaudeMd, `${ROOT}/vlue/CLAUDE.md`, { relativePath: "CLAUDE.md" }),
    contextFile(IDS.userClaudeMd, `${HOME}/.claude/CLAUDE.md`, {
      project: null,
      scope: "user",
      shared: null,
      gitStatus: "outside-repo",
      label: "~/.claude/CLAUDE.md",
    }),
    contextFile(IDS.agentsMd, `${ROOT}/vlue/AGENTS.md`, { relativePath: "AGENTS.md" }),
    mcpServer(IDS.posthog, `${ROOT}/vlue/.mcp.json`, "posthog"),
    memoryFile(IDS.memory, `${HOME}/.claude/projects/__ROOT__-vlue/memory/MEMORY.md`, "index"),
    memoryFile(IDS.fact, `${HOME}/.claude/projects/__ROOT__-vlue/memory/vlue-api.md`, "fact"),
    settingsFile(IDS.lock, `${HOME}/.agents/.skill-lock.json`, "skill-lock", {
      harness: null,
      project: null,
      scope: "user",
      shared: null,
      gitStatus: "outside-repo",
    }),
    skill(
      IDS.copy,
      `${ROOT}/vlue/.claude/skills/agent-browser`,
      { relativePath: ".claude/skills/agent-browser" },
      [
        placement(`${ROOT}/vlue/.claude/skills/agent-browser`, {
          harness: "claude-code",
          surface: "cli",
          scope: "project",
          project: IDS.vlue,
          gitStatus: "tracked",
          shared: true,
        }),
      ],
    ),
    skill(
      IDS.dangling,
      `${HOME}/.claude/skills/old-skill`,
      { project: null, scope: "user", shared: null, gitStatus: "outside-repo" },
      [
        placement(`${HOME}/.claude/skills/old-skill`, {
          harness: "claude-code",
          surface: "cli",
          isSymlink: true,
          linkTarget: "../../.agents/skills/old-skill",
          dangling: true,
        }),
      ],
    ),
    plugin(
      IDS.plugin,
      `${HOME}/.claude/plugins/cache/frontend-design@anthropic/1.2.0`,
      "frontend-design@anthropic",
      { protection: "live" },
    ),
    agentDefinition(IDS.reviewer, `${ROOT}/vlue/.claude/agents/reviewer.md`, {
      relativePath: ".claude/agents/reviewer.md",
    }),
  ];

  const edges: Edge[] = [
    // hop 1 around the focus — every legend kind
    names(IDS.projectClaudeMd, IDS.focus, "high"),
    names(IDS.userClaudeMd, IDS.focus, "medium"),
    namesTool(IDS.focus, IDS.posthog, "posthog", "high"),
    namesTool(IDS.focus, null, "linear", "low"),
    loadedBy(IDS.focus, IDS.claudeCode, "description-only", {
      reason: "user skill",
      placement: `${HOME}/.claude/skills/agent-browser`,
      effectiveName: "/agent-browser",
      charsLoaded: 168,
      tokensLoaded: 42,
    }),
    loadedBy(IDS.focus, IDS.cursor, "never", {
      project: IDS.vlue,
      reason: "not linked from .cursor/skills",
    }),
    duplicates(IDS.focus, IDS.copy, "content", "medium"),
    originatesFrom(IDS.focus, IDS.lock),
    // between hop-1 nodes (no new node)
    namesTool(IDS.projectClaudeMd, IDS.posthog, "posthog", "high"),
    loadedBy(IDS.projectClaudeMd, IDS.claudeCode, "full", {
      project: IDS.vlue,
      reason: "ancestor of cwd",
      order: 0,
      tokensLoaded: 2310,
    }),
    // hop 2 behind the Claude Code harness
    loadedBy(IDS.memory, IDS.claudeCode, "full", {
      project: IDS.vlue,
      reason: "auto-memory index",
      order: 1,
      tokensLoaded: 250,
    }),
    loadedBy(IDS.plugin, IDS.claudeCode, "full", { reason: "enabled plugin" }),
    loadedBy(IDS.dangling, IDS.claudeCode, "never", { reason: "link target missing" }),
    // hidden kinds — counted in the footer, never drawn
    {
      id: `edge:imports:${IDS.projectClaudeMd}:${IDS.agentsMd}`,
      kind: "imports",
      from: IDS.projectClaudeMd,
      to: IDS.agentsMd,
      confidence: "certain",
      evidence: [{ kind: "import-statement", detail: "@AGENTS.md" }],
      hop: 1,
      external: false,
      syntax: "at-import",
    },
    {
      id: `edge:shadows:${IDS.copy}:${IDS.focus}`,
      kind: "shadows",
      from: IDS.copy,
      to: IDS.focus,
      confidence: "high",
      evidence: [{ kind: "precedence-rule" }],
      rule: "project > user",
    },
    {
      id: `edge:references:${IDS.reviewer}:${IDS.focus}`,
      kind: "references",
      from: IDS.reviewer,
      to: IDS.focus,
      confidence: "certain",
      evidence: [{ kind: "frontmatter", detail: "skills: [agent-browser]" }],
      via: "frontmatter-skills",
    },
    {
      id: `edge:lists:${IDS.memory}:${IDS.fact}`,
      kind: "lists",
      from: IDS.memory,
      to: IDS.fact,
      confidence: "certain",
      evidence: [{ kind: "index-line" }],
    },
  ];

  return makeIndex({
    harnesses: [harness("claude-code", "Claude Code"), harness("cursor", "Cursor")],
    projects: [project(IDS.vlue, `${ROOT}/vlue`, { enclosesCwd: true })],
    entities,
    edges,
  });
}
