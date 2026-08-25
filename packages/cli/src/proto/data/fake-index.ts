// THROWAWAY PROTOTYPE (ticket 09) — a rich fake AuditIndex, typed against index v0.
//
// Every id and path is obviously fake (`<HOME>` / `<ROOT>` as in fixture snapshots). The
// shape follows ticket 07's example; the rows exist to exercise every screen: three present
// Projects (one enclosing cwd, one most expensive), two gone, one unreachable, user scope of
// two harnesses, loaded-by verdicts of every mode, placements (shared, dangling, plugin),
// MCP servers (delegate + permanent, invalid, shadowed), memory units with never-read facts,
// cache groups with preselected / live / refused / user-content units, and findings in all
// eight categories.
import type {
  AgentDefinition,
  AuditIndex,
  Breadcrumb,
  ContextFile,
  Edge,
  Entity,
  Finding,
  HarnessCache,
  HarnessId,
  Headline,
  LoadedByEdge,
  McpServer,
  MemoryFile,
  Metrics,
  Placement,
  Plugin,
  Project,
  Scope,
  SettingsFile,
  Skill,
  TokenRange,
} from "@moldig/core";

export const HOME = "<HOME>";
export const ROOT = "<ROOT>";

const CLAUDE = "harness:claude-code";
const CODEX = "harness:codex";

const P_VLUE = `project:${ROOT}/vlue`;
const P_TRAVIA = `project:${ROOT}/travia`;
const P_NUMA = `project:${ROOT}/numa365`;
const P_GONE = `project:${ROOT}/gone`;
const P_OLD = `project:${ROOT}/old-experiment`;
const P_UNREACHABLE = "project:/Volumes/Backup/old";

const PLUGIN_DIR = `${HOME}/.claude/plugins/cache/acme/tools/1.2.0`;
const NAS = "/Volumes/NAS/claude-mirror";

// ---------- helpers ----------
const day = (n: number): string => new Date(Date.UTC(2026, 7, 26) - n * 86_400_000).toISOString();

function metrics(
  bytes: number,
  o: {
    files?: number | null;
    lines?: number | null;
    ageDays?: number | null;
    tokens?: number | null;
  },
): Metrics {
  const ageDays = o.ageDays ?? 5;
  return {
    bytes,
    files: o.files ?? 1,
    lines: o.lines ?? null,
    mtime: day(ageDays),
    ageDays,
    tokens:
      o.tokens === null || o.tokens === undefined
        ? null
        : { o200k: o.tokens, method: "o200k_base" },
    lastUsed: null,
  };
}

interface FileArgs {
  id: string;
  path: string;
  label: string;
  harness: HarnessId | null;
  project: string | null;
  scope: Scope;
  shared?: boolean | null;
  relativePath?: string | null;
  bytes: number;
  lines?: number;
  tokens?: number | null;
  ageDays?: number;
}

function contextFile(
  a: FileArgs & { fileName: string; form?: ContextFile["form"]; importCount?: number },
): ContextFile {
  const shared = a.shared ?? null;
  return {
    id: a.id,
    kind: "context-file",
    harness: a.harness,
    producer: null,
    project: a.project,
    scope: a.scope,
    ownership: "human",
    shared,
    gitStatus: a.project === null ? "outside-repo" : shared ? "tracked" : "untracked",
    path: a.path,
    relativePath: a.relativePath ?? null,
    locator: { type: "file", path: a.path },
    format: "md",
    label: a.label,
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: metrics(a.bytes, {
      lines: a.lines ?? null,
      tokens: a.tokens ?? null,
      ageDays: a.ageDays ?? 5,
    }),
    form: a.form ?? "context",
    fileName: a.fileName,
    frontmatter: {},
    importCount: a.importCount ?? 0,
    containsMemorySection: false,
  };
}

function placement(
  path: string,
  o: {
    harness?: HarnessId | null;
    scope: Scope;
    project?: string | null;
    shared?: boolean | null;
    link?: string | null;
    dangling?: boolean;
  },
): Placement {
  const shared = o.shared ?? null;
  return {
    path,
    harness: o.harness ?? null,
    surface: o.harness ? "cli" : null,
    scope: o.scope,
    project: o.project ?? null,
    gitStatus: o.project ? (shared ? "tracked" : "untracked") : "outside-repo",
    shared,
    isSymlink: o.link !== undefined && o.link !== null,
    linkTarget: o.link ?? null,
    dangling: o.dangling ?? false,
  };
}

function skill(
  a: FileArgs & {
    name: string;
    layout: Skill["layout"];
    form?: Skill["form"];
    placements: Placement[];
    origin?: Skill["origin"];
    drift?: Skill["drift"];
    description: string;
    removal?: Skill["removal"];
  },
): Skill {
  const shared = a.shared ?? null;
  return {
    id: a.id,
    kind: "skill",
    harness: a.harness,
    producer: null,
    project: a.project,
    scope: a.scope,
    ownership: "human",
    shared,
    gitStatus: a.project === null ? "outside-repo" : shared ? "tracked" : "untracked",
    path: a.path,
    relativePath: a.relativePath ?? null,
    locator:
      a.form === "command-file" ? { type: "file", path: a.path } : { type: "dir", path: a.path },
    format: a.form === "command-file" ? "md" : "dir",
    label: a.label,
    sensitive: false,
    protection: a.layout === "plugin" ? "none" : "none",
    removal: a.removal ?? { method: "trash" },
    metrics: metrics(a.bytes, {
      files: 3,
      lines: a.lines ?? null,
      tokens: a.tokens ?? null,
      ageDays: a.ageDays ?? 30,
    }),
    form: a.form ?? "skill-dir",
    name: a.name,
    dirName: a.name,
    frontmatterName: a.name,
    layout: a.layout,
    placements: a.placements,
    frontmatter: { name: a.name, description: a.description },
    sidecars: [],
    contentHash: [{ algo: "git-tree-sha1", value: "3f786850e387550fdab836ed7e6dc881de23001b" }],
    origin: a.origin ?? null,
    drift: a.drift ?? "unknown",
  };
}

function mcpServer(
  a: FileArgs & {
    file: string;
    keyPath: string[];
    format: "json" | "toml";
    transport: McpServer["transport"];
    url?: string | null;
    command?: string | null;
    secretKeys?: string[];
    envKeys?: string[];
    invalid?: string | null;
    removal: McpServer["removal"];
  },
): McpServer {
  const shared = a.shared ?? null;
  return {
    id: a.id,
    kind: "mcp-server",
    harness: a.harness,
    producer: null,
    project: a.project,
    scope: a.scope,
    ownership: "human",
    shared,
    gitStatus: a.project === null ? "outside-repo" : shared ? "tracked" : "untracked",
    path: a.path,
    relativePath: a.relativePath ?? null,
    locator: { type: "entry", file: a.file, format: a.format, keyPath: a.keyPath },
    format: a.format,
    label: a.label,
    sensitive: (a.secretKeys?.length ?? 0) > 0,
    protection: "none",
    removal: a.removal,
    metrics: metrics(a.bytes, { files: null, tokens: null, ageDays: a.ageDays ?? 7 }),
    name: a.label,
    transport: a.transport,
    command: a.command ?? null,
    args: [],
    url: a.url ?? null,
    envKeys: a.envKeys ?? [],
    headerKeys: a.secretKeys ?? [],
    secretKeys: a.secretKeys ?? [],
    hasOauth: false,
    usesInterpolation: false,
    enabled: null,
    approval: a.invalid ? "unknown" : "approved",
    invalid: a.invalid ?? null,
    endpointKey: a.url ?? a.command ?? a.label,
    rawKeys: ["type", a.url ? "url" : "command"],
  };
}

function memoryFile(
  a: FileArgs & {
    role: MemoryFile["role"];
    unit: string;
    owner?: MemoryFile["owner"];
    reads?: number | null;
    neverRead?: boolean | null;
    loadedTokens?: number;
    removal?: MemoryFile["removal"];
  },
): MemoryFile {
  const signal = a.reads === null;
  const reads = a.reads ?? null;
  return {
    id: a.id,
    kind: "memory-file",
    harness: a.harness,
    producer: null,
    project: a.project,
    scope: a.scope,
    ownership: "harness",
    shared: null,
    gitStatus: "outside-repo",
    path: a.path,
    relativePath: null,
    locator: { type: "file", path: a.path },
    format: "md",
    label: a.label,
    sensitive: false,
    protection: "none",
    removal: a.removal ?? { method: "trash" },
    metrics: metrics(a.bytes, {
      lines: a.lines ?? null,
      tokens: a.tokens ?? null,
      ageDays: a.ageDays ?? 3,
    }),
    role: a.role,
    unit: a.unit,
    owner: a.owner ?? "project",
    frontmatter: {},
    loadedPortion:
      a.loadedTokens === undefined
        ? null
        : { lines: 200, bytes: 25_600, tokens: a.loadedTokens, confidence: "certain" },
    reads: reads === null ? null : { count: reads, first: day(40), last: day(2) },
    writes: signal ? null : { count: 2, last: day(a.ageDays ?? 3) },
    neverRead: signal ? null : (a.neverRead ?? false),
    readSignal: signal
      ? { source: "none", exact: false, bashParsed: false }
      : { source: "transcript-tool-use", exact: true, bashParsed: true },
  };
}

function agentDefinition(
  a: FileArgs & { name: string; frontmatter?: Record<string, unknown> },
): AgentDefinition {
  const shared = a.shared ?? null;
  return {
    id: a.id,
    kind: "agent-definition",
    harness: a.harness,
    producer: null,
    project: a.project,
    scope: a.scope,
    ownership: "human",
    shared,
    gitStatus: a.project === null ? "outside-repo" : shared ? "tracked" : "untracked",
    path: a.path,
    relativePath: a.relativePath ?? null,
    locator: { type: "file", path: a.path },
    format: "md",
    label: a.label,
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: metrics(a.bytes, {
      lines: a.lines ?? null,
      tokens: a.tokens ?? null,
      ageDays: a.ageDays ?? 12,
    }),
    name: a.name,
    form: "markdown",
    frontmatter: a.frontmatter ?? {},
    hooks: [],
  };
}

function cache(
  a: Omit<FileArgs, "harness" | "scope"> & {
    harness: HarnessId;
    cacheKind: string;
    unit: HarnessCache["unit"];
    rule: HarnessCache["rule"];
    retention?: HarnessCache["retention"];
    liveGuard?: HarnessCache["liveGuard"];
    userContent?: boolean;
    files?: number;
    session?: string | null;
    paths?: string[];
    protection?: HarnessCache["protection"];
    removal?: HarnessCache["removal"];
    format?: HarnessCache["format"];
    sensitive?: boolean;
  },
): HarnessCache {
  const ageDays = a.ageDays ?? 5;
  const retention = a.retention ?? {
    days: 20,
    bytes: null,
    count: null,
    source: "cleanupPeriodDays",
  };
  return {
    id: a.id,
    kind: "harness-cache",
    harness: a.harness,
    producer: null,
    project: a.project,
    scope: "user",
    ownership: "harness",
    shared: null,
    gitStatus: "outside-repo",
    path: a.path,
    relativePath: null,
    locator: a.paths
      ? { type: "paths", paths: a.paths }
      : { type: a.unit === "file" ? "file" : "dir", path: a.path },
    format: a.format ?? (a.unit === "file" ? "jsonl" : "dir"),
    label: a.label,
    sensitive: a.sensitive ?? true,
    protection: a.protection ?? "none",
    removal: a.removal ?? { method: "trash" },
    metrics: metrics(a.bytes, { files: a.files ?? 1, tokens: null, ageDays }),
    cacheKind: a.cacheKind,
    unit: a.unit,
    surface: "cli",
    session: a.session ?? null,
    slug: null,
    rule: a.rule,
    retention,
    liveGuard: a.liveGuard === undefined ? { kind: "recent-activity", alive: false } : a.liveGuard,
    userContent: a.userContent ?? false,
    members: {
      files: a.files ?? 1,
      bytes: a.bytes,
      oldest: day(ageDays + 1),
      newest: day(ageDays),
    },
  };
}

function settingsFile(
  a: FileArgs & {
    role: SettingsFile["role"];
    format?: SettingsFile["format"];
    entries?: number | null;
    protection?: SettingsFile["protection"];
    sensitive?: boolean;
  },
): SettingsFile {
  const shared = a.shared ?? null;
  return {
    id: a.id,
    kind: "settings-file",
    harness: a.harness,
    producer: null,
    project: a.project,
    scope: a.scope,
    ownership: "human",
    shared,
    gitStatus: a.project === null ? "outside-repo" : shared ? "tracked" : "untracked",
    path: a.path,
    relativePath: a.relativePath ?? null,
    locator: { type: "file", path: a.path },
    format: a.format ?? "json",
    label: a.label,
    sensitive: a.sensitive ?? false,
    protection: a.protection ?? "never",
    removal: { method: "none" },
    metrics: metrics(a.bytes, { tokens: null, ageDays: a.ageDays ?? 2 }),
    role: a.role,
    topLevelKeys: [],
    entries: a.entries ?? null,
    hooks: [],
  };
}

function loadedBy(
  from: string,
  harness: string,
  o: {
    project: string | null;
    mode: LoadedByEdge["mode"];
    reason: string;
    tokens: number | null;
    order?: number | null;
    effectiveName?: string | null;
    placement?: string | null;
    counts?: boolean;
  },
): LoadedByEdge {
  return {
    id: `edge:loaded-by:${from}:${harness}${o.project ? `:${o.project}` : ""}`,
    kind: "loaded-by",
    from,
    to: harness,
    confidence: "certain",
    evidence: [{ kind: "loading-rule", detail: o.reason }],
    project: o.project,
    mode: o.mode,
    reason: o.reason,
    placement: o.placement ?? null,
    effectiveName: o.effectiveName ?? null,
    order: o.order ?? null,
    charsLoaded: o.tokens === null ? null : o.tokens * 4,
    importsResolved: null,
    tokensLoaded: o.tokens,
    disableModelInvocation: null,
    countsTowardHeadline: o.counts ?? o.tokens !== null,
  };
}

function scale(tokens: number, m: TokenRange): TokenRange {
  return {
    low: Math.round(tokens * m.low),
    mid: Math.round(tokens * m.mid),
    high: Math.round(tokens * m.high),
  };
}

function sum(r: TokenRange, s: TokenRange): TokenRange {
  return { low: r.low + s.low, mid: r.mid + s.mid, high: r.high + s.high };
}

// ---------- ids ----------
const CF_USER_CLAUDE = `context-file:${HOME}/.claude/claude.md`;
const CF_USER_AGENTS = `context-file:${HOME}/.codex/agents.md`;
const CF_VLUE_CLAUDE = `context-file:${ROOT}/vlue/claude.md`;
const CF_VLUE_LOCAL = `context-file:${ROOT}/vlue/claude.local.md`;
const CF_VLUE_NOTES = `context-file:${ROOT}/vlue/docs/notes.md`;
const CF_VLUE_RULE = `context-file:${ROOT}/vlue/.claude/rules/api.md`;
const CF_VLUE_AGENTS = `context-file:${ROOT}/vlue/agents.md`;
const CF_TRAVIA_CLAUDE = `context-file:${ROOT}/travia/claude.md`;
const CF_NUMA_CLAUDE = `context-file:${ROOT}/numa365/claude.md`;

const SK_BROWSER = `skill:${HOME}/.agents/skills/agent-browser`;
const SK_DEPLOY = `skill:${ROOT}/vlue/.claude/skills/deploy`;
const SK_LINT = `skill:${PLUGIN_DIR}/skills/lint`;
const SK_BROWSER_COPY = `skill:${ROOT}/travia/.claude/skills/agent-browser`;
const SK_REVIEW = `skill:${ROOT}/vlue/.claude/commands/review.md`;

const MCP_POSTHOG_PROJECT = `mcp-server:${ROOT}/vlue/.mcp.json#mcpservers/posthog`;
const MCP_POSTHOG_USER = `mcp-server:${HOME}/.claude.json#mcpservers/posthog`;
const MCP_LEGACY = `mcp-server:${ROOT}/vlue/.mcp.json#mcpservers/legacy`;
const MCP_LINEAR_CODEX = `mcp-server:${HOME}/.codex/config.toml#mcp_servers/linear`;
const MCP_ACME = `mcp-server:${PLUGIN_DIR}/.mcp.json#mcpservers/acme`;

const MEM_VLUE_UNIT = `${HOME}/.claude/projects/__ROOT__-vlue/memory`;
const MEM_VLUE_INDEX = `memory-file:${MEM_VLUE_UNIT}/memory.md`;
const MEM_VLUE_AUTH = `memory-file:${MEM_VLUE_UNIT}/auth-flow.md`;
const MEM_VLUE_MIGRATION = `memory-file:${MEM_VLUE_UNIT}/old-migration.md`;
const MEM_VLUE_DEPLOY = `memory-file:${MEM_VLUE_UNIT}/deploy-notes.md`;
const MEM_VLUE_STACK = `memory-file:${MEM_VLUE_UNIT}/stack.md`;
const MEM_TRAVIA_UNIT = `${HOME}/.claude/projects/__ROOT__-travia/memory`;
const MEM_TRAVIA_INDEX = `memory-file:${MEM_TRAVIA_UNIT}/memory.md`;
const MEM_TRAVIA_PRICING = `memory-file:${MEM_TRAVIA_UNIT}/pricing-rules.md`;
const MEM_TRAVIA_CI = `memory-file:${MEM_TRAVIA_UNIT}/ci-flakes.md`;
const MEM_CODEX_UNIT = `${HOME}/.codex/memories`;
const MEM_CODEX_SUMMARY = `memory-file:${MEM_CODEX_UNIT}/memory_summary.md`;

const AG_REVIEWER = `agent-definition:${ROOT}/vlue/.claude/agents/reviewer.md`;
const AG_PLANNER = `agent-definition:${ROOT}/vlue/.claude/agents/planner.md`;
const AG_ACME_BOT = `agent-definition:${PLUGIN_DIR}/agents/acme-bot.md`;

const PL_TOOLS = `plugin:${PLUGIN_DIR}`;

const SESSION = (n: number): string =>
  `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-00000000000${n}`;
const vlueSlug = `${HOME}/.claude/projects/__ROOT__-vlue`;
const HC_S1 = `harness-cache:${vlueSlug}/${SESSION(1)}.jsonl`;
const HC_S2 = `harness-cache:${vlueSlug}/${SESSION(2)}.jsonl`;
const HC_S3 = `harness-cache:${vlueSlug}/${SESSION(3)}.jsonl`;
const HC_S4 = `harness-cache:${NAS}/projects/__ROOT__-vlue/${SESSION(4)}.jsonl`;
const HC_S5 = `harness-cache:${vlueSlug}/${SESSION(5)}.jsonl`;
const HC_T1 = `harness-cache:${HOME}/.claude/projects/__ROOT__-travia/${SESSION(6)}.jsonl`;
const HC_T2 = `harness-cache:${HOME}/.claude/projects/__ROOT__-travia/${SESSION(7)}.jsonl`;
const HC_N1 = `harness-cache:${HOME}/.claude/projects/__ROOT__-numa365/${SESSION(8)}.jsonl`;
const HC_G1 = `harness-cache:${HOME}/.claude/projects/__ROOT__-gone/${SESSION(9)}.jsonl`;
const HC_SNAP_A = `harness-cache:${HOME}/.claude/shell-snapshots/snapshot-a.sh`;
const HC_SNAP_B = `harness-cache:${HOME}/.claude/shell-snapshots/snapshot-b.sh`;
const HC_BACKUP = `harness-cache:${HOME}/.claude/backups/.claude.json.backup.1700000000000`;
const HC_HISTORY = `harness-cache:${HOME}/.claude/history.jsonl`;
const HC_PLUGIN_110 = `harness-cache:${HOME}/.claude/plugins/cache/acme/tools/1.1.0`;
const HC_PLUGIN_100 = `harness-cache:${HOME}/.claude/plugins/cache/acme/tools/1.0.0`;
const HC_IDE = `harness-cache:${HOME}/.claude/ide`;
const HC_ROLLOUT_1 = `harness-cache:${HOME}/.codex/sessions/2026/06/10/rollout-2026-06-10t09-00-00-aaaa.jsonl`;
const HC_ROLLOUT_2 = `harness-cache:${HOME}/.codex/sessions/2026/08/21/rollout-2026-08-21t18-30-00-bbbb.jsonl`;
const HC_CODEX_HISTORY = `harness-cache:${HOME}/.codex/history.jsonl`;
const HC_CODEX_TMP = `harness-cache:${HOME}/.codex/.tmp`;
const HC_CODEX_DB = `harness-cache:${HOME}/.codex/state_5.sqlite`;

const SF_CLAUDE_SETTINGS = `settings-file:${HOME}/.claude/settings.json`;
const SF_CLAUDE_JSON = `settings-file:${HOME}/.claude.json`;
const SF_VLUE_LOCAL = `settings-file:${ROOT}/vlue/.claude/settings.local.json`;
const SF_VLUE_MCP = `settings-file:${ROOT}/vlue/.mcp.json`;
const SF_SKILL_LOCK = `settings-file:${HOME}/.agents/.skill-lock.json`;
const SF_PLUGINS = `settings-file:${HOME}/.claude/plugins/installed_plugins.json`;
const SF_CODEX_CONFIG = `settings-file:${HOME}/.codex/config.toml`;

const BC_VLUE = `breadcrumb:claude-code:${HOME}/.claude.json#projects/${ROOT}/vlue`;
const BC_TRAVIA = `breadcrumb:claude-code:${HOME}/.claude.json#projects/${ROOT}/travia`;
const BC_NUMA = `breadcrumb:claude-code:${HOME}/.claude.json#projects/${ROOT}/numa365`;
const BC_GONE = `breadcrumb:claude-code:${HOME}/.claude.json#projects/${ROOT}/gone`;
const BC_OLD = `breadcrumb:codex:${HOME}/.codex/state_5.sqlite#threads/${ROOT}/old-experiment`;
const BC_UNREACHABLE = `breadcrumb:claude-code:${HOME}/.claude.json#projects//volumes/backup/old`;
const BC_HOME = `breadcrumb:claude-code:${HOME}/.claude.json#projects/${HOME}`;

// ---------- entities ----------
const browserOrigin: Skill["origin"] = {
  installer: "vercel-skills",
  sourceType: "github",
  source: "vercel-labs/agent-browser",
  sourceUrl: "https://github.com/vercel-labs/agent-browser",
  ref: "main",
  skillPath: "skills/agent-browser",
  recordedHash: { algo: "git-tree-sha1", value: "3f786850e387550fdab836ed7e6dc881de23001b" },
  installedAt: day(44),
  updatedAt: null,
  lock: {
    type: "entry",
    file: `${HOME}/.agents/.skill-lock.json`,
    format: "json",
    keyPath: ["skills", "agent-browser"],
  },
};

const entities: Entity[] = [
  // context files
  contextFile({
    id: CF_USER_CLAUDE,
    path: `${HOME}/.claude/CLAUDE.md`,
    label: "~/.claude/CLAUDE.md",
    harness: "claude-code",
    project: null,
    scope: "user",
    bytes: 4700,
    lines: 96,
    tokens: 1180,
    ageDays: 24,
    fileName: "CLAUDE.md",
  }),
  contextFile({
    id: CF_USER_AGENTS,
    path: `${HOME}/.codex/AGENTS.md`,
    label: "~/.codex/AGENTS.md",
    harness: "codex",
    project: null,
    scope: "user",
    bytes: 3600,
    lines: 70,
    tokens: 900,
    ageDays: 40,
    fileName: "AGENTS.md",
  }),
  contextFile({
    id: CF_VLUE_CLAUDE,
    path: `${ROOT}/vlue/CLAUDE.md`,
    label: "CLAUDE.md",
    harness: "claude-code",
    project: P_VLUE,
    scope: "project",
    shared: true,
    relativePath: "CLAUDE.md",
    bytes: 9300,
    lines: 210,
    tokens: 2310,
    ageDays: 5,
    fileName: "CLAUDE.md",
    importCount: 0,
  }),
  contextFile({
    id: CF_VLUE_LOCAL,
    path: `${ROOT}/vlue/CLAUDE.local.md`,
    label: "CLAUDE.local.md",
    harness: "claude-code",
    project: P_VLUE,
    scope: "local",
    shared: false,
    relativePath: "CLAUDE.local.md",
    bytes: 1600,
    lines: 30,
    tokens: 400,
    ageDays: 9,
    fileName: "CLAUDE.local.md",
    form: "local",
    importCount: 1,
  }),
  contextFile({
    id: CF_VLUE_NOTES,
    path: `${ROOT}/vlue/docs/notes.md`,
    label: "docs/notes.md",
    harness: "claude-code",
    project: P_VLUE,
    scope: "project",
    shared: true,
    relativePath: "docs/notes.md",
    bytes: 1400,
    lines: 28,
    tokens: 350,
    ageDays: 60,
    fileName: "notes.md",
    form: "instructions",
  }),
  contextFile({
    id: CF_VLUE_RULE,
    path: `${ROOT}/vlue/.claude/rules/api.md`,
    label: ".claude/rules/api.md",
    harness: "claude-code",
    project: P_VLUE,
    scope: "project",
    shared: true,
    relativePath: ".claude/rules/api.md",
    bytes: 2500,
    lines: 55,
    tokens: 620,
    ageDays: 15,
    fileName: "api.md",
    form: "rule",
  }),
  contextFile({
    id: CF_VLUE_AGENTS,
    path: `${ROOT}/vlue/AGENTS.md`,
    label: "AGENTS.md",
    harness: "codex",
    project: P_VLUE,
    scope: "project",
    shared: true,
    relativePath: "AGENTS.md",
    bytes: 16_400,
    lines: 320,
    tokens: 4100,
    ageDays: 3,
    fileName: "AGENTS.md",
  }),
  contextFile({
    id: CF_TRAVIA_CLAUDE,
    path: `${ROOT}/travia/CLAUDE.md`,
    label: "CLAUDE.md",
    harness: "claude-code",
    project: P_TRAVIA,
    scope: "project",
    shared: true,
    relativePath: "CLAUDE.md",
    bytes: 73_600,
    lines: 1480,
    tokens: 18_400,
    ageDays: 2,
    fileName: "CLAUDE.md",
  }),
  contextFile({
    id: CF_NUMA_CLAUDE,
    path: `${ROOT}/numa365/CLAUDE.md`,
    label: "CLAUDE.md",
    harness: "claude-code",
    project: P_NUMA,
    scope: "project",
    shared: true,
    relativePath: "CLAUDE.md",
    bytes: 3600,
    lines: 80,
    tokens: 900,
    ageDays: 90,
    fileName: "CLAUDE.md",
  }),

  // skills
  skill({
    id: SK_BROWSER,
    path: `${HOME}/.agents/skills/agent-browser`,
    label: "agent-browser",
    harness: null,
    project: null,
    scope: "user",
    bytes: 15_600,
    lines: 380,
    tokens: 3900,
    ageDays: 44,
    name: "agent-browser",
    layout: "canonical",
    description: "Drive a browser from the terminal.",
    origin: browserOrigin,
    drift: "none",
    removal: { method: "delegate", command: "npx skills remove agent-browser" },
    placements: [
      placement(`${HOME}/.agents/skills/agent-browser`, { scope: "user" }),
      placement(`${HOME}/.claude/skills/agent-browser`, {
        harness: "claude-code",
        scope: "user",
        link: "../../.agents/skills/agent-browser",
      }),
      placement(`${HOME}/.codex/skills/agent-browser`, {
        harness: "codex",
        scope: "user",
        link: "../../.agents/skills/agent-browser",
      }),
      placement(`${ROOT}/vlue/.claude/skills/agent-browser`, {
        harness: "claude-code",
        scope: "project",
        project: P_VLUE,
        shared: true,
        link: `${HOME}/.agents/skills/agent-browser`,
      }),
    ],
  }),
  skill({
    id: SK_DEPLOY,
    path: `${ROOT}/vlue/.claude/skills/deploy`,
    label: "deploy",
    harness: "claude-code",
    project: P_VLUE,
    scope: "project",
    shared: true,
    relativePath: ".claude/skills/deploy",
    bytes: 0,
    tokens: null,
    ageDays: 120,
    name: "deploy",
    layout: "canonical",
    description: "(link target missing)",
    drift: "unknown",
    placements: [
      placement(`${ROOT}/vlue/.claude/skills/deploy`, {
        harness: "claude-code",
        scope: "project",
        project: P_VLUE,
        shared: true,
        link: "../../../../.agents/skills/deploy",
        dangling: true,
      }),
    ],
  }),
  skill({
    id: SK_LINT,
    path: `${PLUGIN_DIR}/skills/lint`,
    label: "lint",
    harness: "claude-code",
    project: null,
    scope: "user",
    bytes: 6200,
    lines: 140,
    tokens: 1500,
    ageDays: 10,
    name: "lint",
    layout: "plugin",
    description: "Run the acme linters and explain every finding.",
    removal: { method: "none" },
    placements: [placement(`${PLUGIN_DIR}/skills/lint`, { harness: "claude-code", scope: "user" })],
  }),
  skill({
    id: SK_BROWSER_COPY,
    path: `${ROOT}/travia/.claude/skills/agent-browser`,
    label: "agent-browser",
    harness: "claude-code",
    project: P_TRAVIA,
    scope: "project",
    shared: true,
    relativePath: ".claude/skills/agent-browser",
    bytes: 16_900,
    lines: 410,
    tokens: 4200,
    ageDays: 20,
    name: "agent-browser",
    layout: "copy",
    description: "Drive a browser from the terminal (travia tweaks).",
    origin: {
      ...browserOrigin,
      lock: {
        type: "entry",
        file: `${ROOT}/travia/.agents/.skill-lock.json`,
        format: "json",
        keyPath: ["skills", "agent-browser"],
      },
    },
    drift: "local-modified",
    placements: [
      placement(`${ROOT}/travia/.claude/skills/agent-browser`, {
        harness: "claude-code",
        scope: "project",
        project: P_TRAVIA,
        shared: true,
      }),
    ],
  }),
  skill({
    id: SK_REVIEW,
    path: `${ROOT}/vlue/.claude/commands/review.md`,
    label: "review",
    harness: "claude-code",
    project: P_VLUE,
    scope: "project",
    shared: false,
    relativePath: ".claude/commands/review.md",
    bytes: 900,
    lines: 22,
    tokens: 220,
    ageDays: 8,
    name: "review",
    layout: "canonical",
    form: "command-file",
    description: "Review the diff against CONTEXT.md.",
    drift: "unknown",
    placements: [
      placement(`${ROOT}/vlue/.claude/commands/review.md`, {
        harness: "claude-code",
        scope: "project",
        project: P_VLUE,
        shared: false,
      }),
    ],
  }),

  // MCP servers
  mcpServer({
    id: MCP_POSTHOG_PROJECT,
    path: `${ROOT}/vlue/.mcp.json`,
    label: "posthog",
    harness: "claude-code",
    project: P_VLUE,
    scope: "project",
    shared: true,
    relativePath: ".mcp.json",
    bytes: 210,
    file: `${ROOT}/vlue/.mcp.json`,
    keyPath: ["mcpServers", "posthog"],
    format: "json",
    transport: "http",
    url: "https://mcp.posthog.com/mcp",
    secretKeys: ["Authorization"],
    removal: { method: "backup-edit" },
  }),
  mcpServer({
    id: MCP_POSTHOG_USER,
    path: `${HOME}/.claude.json`,
    label: "posthog",
    harness: "claude-code",
    project: null,
    scope: "user",
    bytes: 190,
    file: `${HOME}/.claude.json`,
    keyPath: ["mcpServers", "posthog"],
    format: "json",
    transport: "http",
    url: "https://mcp.posthog.com/mcp",
    ageDays: 120,
    removal: { method: "backup-edit" },
  }),
  mcpServer({
    id: MCP_LEGACY,
    path: `${ROOT}/vlue/.mcp.json`,
    label: "legacy",
    harness: "claude-code",
    project: P_VLUE,
    scope: "project",
    shared: true,
    relativePath: ".mcp.json",
    bytes: 80,
    file: `${ROOT}/vlue/.mcp.json`,
    keyPath: ["mcpServers", "legacy"],
    format: "json",
    transport: "unknown",
    url: "http://localhost:9000/sse",
    invalid: "url without type",
    removal: { method: "backup-edit" },
  }),
  mcpServer({
    id: MCP_LINEAR_CODEX,
    path: `${HOME}/.codex/config.toml`,
    label: "linear",
    harness: "codex",
    project: null,
    scope: "user",
    bytes: 260,
    file: `${HOME}/.codex/config.toml`,
    keyPath: ["mcp_servers", "linear"],
    format: "toml",
    transport: "stdio",
    command: "npx",
    envKeys: ["LINEAR_API_KEY"],
    secretKeys: ["LINEAR_API_KEY"],
    ageDays: 200,
    removal: { method: "delegate", command: "codex mcp remove linear" },
  }),
  mcpServer({
    id: MCP_ACME,
    path: `${PLUGIN_DIR}/.mcp.json`,
    label: "acme",
    harness: "claude-code",
    project: null,
    scope: "user",
    bytes: 150,
    file: `${PLUGIN_DIR}/.mcp.json`,
    keyPath: ["mcpServers", "acme"],
    format: "json",
    transport: "stdio",
    command: "acme-mcp",
    removal: { method: "none" },
  }),

  // memory
  memoryFile({
    id: MEM_VLUE_INDEX,
    path: `${MEM_VLUE_UNIT}/MEMORY.md`,
    label: "MEMORY.md",
    harness: "claude-code",
    project: P_VLUE,
    scope: "user",
    bytes: 27_000,
    lines: 260,
    tokens: 6500,
    ageDays: 1,
    role: "index",
    unit: MEM_VLUE_UNIT,
    reads: 4,
    loadedTokens: 6100,
  }),
  memoryFile({
    id: MEM_VLUE_AUTH,
    path: `${MEM_VLUE_UNIT}/auth-flow.md`,
    label: "auth-flow.md",
    harness: "claude-code",
    project: P_VLUE,
    scope: "user",
    bytes: 4800,
    lines: 90,
    tokens: 1200,
    ageDays: 12,
    role: "fact",
    unit: MEM_VLUE_UNIT,
    reads: 3,
  }),
  memoryFile({
    id: MEM_VLUE_MIGRATION,
    path: `${MEM_VLUE_UNIT}/old-migration.md`,
    label: "old-migration.md",
    harness: "claude-code",
    project: P_VLUE,
    scope: "user",
    bytes: 8400,
    lines: 160,
    tokens: 2100,
    ageDays: 60,
    role: "fact",
    unit: MEM_VLUE_UNIT,
    reads: 0,
    neverRead: true,
  }),
  memoryFile({
    id: MEM_VLUE_DEPLOY,
    path: `${MEM_VLUE_UNIT}/deploy-notes.md`,
    label: "deploy-notes.md",
    harness: "claude-code",
    project: P_VLUE,
    scope: "user",
    bytes: 3200,
    lines: 60,
    tokens: 800,
    ageDays: 30,
    role: "fact",
    unit: MEM_VLUE_UNIT,
    reads: 0,
    neverRead: true,
  }),
  memoryFile({
    id: MEM_VLUE_STACK,
    path: `${MEM_VLUE_UNIT}/stack.md`,
    label: "stack.md",
    harness: "claude-code",
    project: P_VLUE,
    scope: "user",
    bytes: 2400,
    lines: 40,
    tokens: 600,
    ageDays: 4,
    role: "fact",
    unit: MEM_VLUE_UNIT,
    reads: 12,
  }),
  memoryFile({
    id: MEM_TRAVIA_INDEX,
    path: `${MEM_TRAVIA_UNIT}/MEMORY.md`,
    label: "MEMORY.md",
    harness: "claude-code",
    project: P_TRAVIA,
    scope: "user",
    bytes: 12_000,
    lines: 120,
    tokens: 3000,
    ageDays: 6,
    role: "index",
    unit: MEM_TRAVIA_UNIT,
    reads: 2,
    loadedTokens: 3000,
  }),
  memoryFile({
    id: MEM_TRAVIA_PRICING,
    path: `${MEM_TRAVIA_UNIT}/pricing-rules.md`,
    label: "pricing-rules.md",
    harness: "claude-code",
    project: P_TRAVIA,
    scope: "user",
    bytes: 6000,
    lines: 110,
    tokens: 1500,
    ageDays: 45,
    role: "fact",
    unit: MEM_TRAVIA_UNIT,
    reads: 0,
    neverRead: true,
  }),
  memoryFile({
    id: MEM_TRAVIA_CI,
    path: `${MEM_TRAVIA_UNIT}/ci-flakes.md`,
    label: "ci-flakes.md",
    harness: "claude-code",
    project: P_TRAVIA,
    scope: "user",
    bytes: 1800,
    lines: 30,
    tokens: 450,
    ageDays: 6,
    role: "fact",
    unit: MEM_TRAVIA_UNIT,
    reads: 5,
  }),
  memoryFile({
    id: MEM_CODEX_SUMMARY,
    path: `${MEM_CODEX_UNIT}/memory_summary.md`,
    label: "memory_summary.md",
    harness: "codex",
    project: null,
    scope: "user",
    bytes: 5200,
    lines: 70,
    tokens: 1300,
    ageDays: 2,
    role: "other",
    unit: MEM_CODEX_UNIT,
    owner: "global",
    reads: null,
    removal: { method: "none" },
  }),

  // agent definitions
  agentDefinition({
    id: AG_REVIEWER,
    path: `${ROOT}/vlue/.claude/agents/reviewer.md`,
    label: "reviewer",
    harness: "claude-code",
    project: P_VLUE,
    scope: "project",
    shared: true,
    relativePath: ".claude/agents/reviewer.md",
    bytes: 1100,
    lines: 30,
    tokens: 280,
    name: "reviewer",
    frontmatter: { memory: "project", tools: ["Read", "Grep"] },
  }),
  agentDefinition({
    id: AG_PLANNER,
    path: `${ROOT}/vlue/.claude/agents/planner.md`,
    label: "planner",
    harness: "claude-code",
    project: P_VLUE,
    scope: "project",
    shared: false,
    relativePath: ".claude/agents/planner.md",
    bytes: 900,
    lines: 24,
    tokens: 230,
    name: "planner",
    frontmatter: { mcpServers: ["jira"] },
  }),
  agentDefinition({
    id: AG_ACME_BOT,
    path: `${PLUGIN_DIR}/agents/acme-bot.md`,
    label: "acme-bot",
    harness: "claude-code",
    project: null,
    scope: "user",
    bytes: 700,
    lines: 18,
    tokens: 180,
    name: "acme-bot",
  }),

  // plugin
  {
    id: PL_TOOLS,
    kind: "plugin",
    harness: "claude-code",
    producer: null,
    project: null,
    scope: "user",
    ownership: "human",
    shared: null,
    gitStatus: "outside-repo",
    path: PLUGIN_DIR,
    relativePath: null,
    locator: { type: "dir", path: PLUGIN_DIR },
    format: "dir",
    label: "tools@acme 1.2.0",
    sensitive: false,
    protection: "none",
    removal: { method: "delegate", command: "claude plugin uninstall tools@acme" },
    metrics: metrics(2_400_000, { files: 48, tokens: null, ageDays: 10 }),
    pluginId: "tools@acme",
    version: "1.2.0",
    marketplace: "acme",
    installs: [{ scope: "user", project: null, enabled: true }],
    origin: {
      installer: "claude-plugin",
      sourceType: "marketplace",
      source: "acme/tools",
      sourceUrl: "https://github.com/acme/claude-plugins",
      ref: "9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
      skillPath: null,
      recordedHash: null,
      installedAt: day(10),
      updatedAt: day(10),
      lock: {
        type: "entry",
        file: `${HOME}/.claude/plugins/installed_plugins.json`,
        format: "json",
        keyPath: ["plugins", "tools@acme"],
      },
    },
    hooks: [{ event: "PreToolUse", type: "command", command: "acme-guard", matcher: "Bash" }],
  } satisfies Plugin,

  // harness cache — Claude Code, Project vlue (transcript sessions)
  cache({
    id: HC_S1,
    path: `${vlueSlug}/${SESSION(1)}.jsonl`,
    label: "session 11111111 · 2026-07-12",
    harness: "claude-code",
    project: P_VLUE,
    bytes: 184_320,
    files: 7,
    ageDays: 45,
    cacheKind: "transcript",
    unit: "session",
    rule: "swept",
    session: SESSION(1),
    liveGuard: { kind: "pid", alive: false },
    paths: [
      `${vlueSlug}/${SESSION(1)}.jsonl`,
      `${vlueSlug}/${SESSION(1)}`,
      `${HOME}/.claude/file-history/${SESSION(1)}`,
      `${HOME}/.claude/tasks/${SESSION(1)}`,
    ],
  }),
  cache({
    id: HC_S2,
    path: `${vlueSlug}/${SESSION(2)}.jsonl`,
    label: "session 22222222 · 2026-08-23",
    harness: "claude-code",
    project: P_VLUE,
    bytes: 98_304,
    files: 3,
    ageDays: 3,
    cacheKind: "transcript",
    unit: "session",
    rule: "swept",
    session: SESSION(2),
    liveGuard: { kind: "pid", alive: false },
  }),
  cache({
    id: HC_S3,
    path: `${vlueSlug}/${SESSION(3)}.jsonl`,
    label: "session 33333333 · 2026-08-26",
    harness: "claude-code",
    project: P_VLUE,
    bytes: 12_288,
    files: 2,
    ageDays: 0,
    cacheKind: "transcript",
    unit: "session",
    rule: "swept",
    session: SESSION(3),
    liveGuard: { kind: "pid", alive: true },
    protection: "live",
  }),
  cache({
    id: HC_S4,
    path: `${NAS}/projects/__ROOT__-vlue/${SESSION(4)}.jsonl`,
    label: "session 44444444 · 2026-06-27 (CLAUDE_CONFIG_DIR on NAS)",
    harness: "claude-code",
    project: P_VLUE,
    bytes: 2_411_724,
    files: 9,
    ageDays: 60,
    cacheKind: "transcript",
    unit: "session",
    rule: "swept",
    session: SESSION(4),
    liveGuard: { kind: "pid", alive: false },
  }),
  cache({
    id: HC_S5,
    path: `${vlueSlug}/${SESSION(5)}.jsonl`,
    label: "session 55555555 · 2026-07-07 (uploads)",
    harness: "claude-code",
    project: P_VLUE,
    bytes: 655_360,
    files: 11,
    ageDays: 50,
    cacheKind: "transcript",
    unit: "session",
    rule: "swept",
    session: SESSION(5),
    liveGuard: { kind: "pid", alive: false },
    userContent: true,
  }),
  cache({
    id: HC_T1,
    path: `${HOME}/.claude/projects/__ROOT__-travia/${SESSION(6)}.jsonl`,
    label: "session 66666666 · 2026-06-17",
    harness: "claude-code",
    project: P_TRAVIA,
    bytes: 3_250_585,
    files: 14,
    ageDays: 70,
    cacheKind: "transcript",
    unit: "session",
    rule: "swept",
    session: SESSION(6),
    liveGuard: { kind: "pid", alive: false },
  }),
  cache({
    id: HC_T2,
    path: `${HOME}/.claude/projects/__ROOT__-travia/${SESSION(7)}.jsonl`,
    label: "session 77777777 · 2026-08-06",
    harness: "claude-code",
    project: P_TRAVIA,
    bytes: 409_600,
    files: 5,
    ageDays: 20,
    cacheKind: "transcript",
    unit: "session",
    rule: "swept",
    session: SESSION(7),
    liveGuard: { kind: "pid", alive: false },
  }),
  cache({
    id: HC_N1,
    path: `${HOME}/.claude/projects/__ROOT__-numa365/${SESSION(8)}.jsonl`,
    label: "session 88888888 · 2026-08-16",
    harness: "claude-code",
    project: P_NUMA,
    bytes: 40_960,
    files: 2,
    ageDays: 10,
    cacheKind: "transcript",
    unit: "session",
    rule: "swept",
    session: SESSION(8),
    liveGuard: { kind: "pid", alive: false },
  }),
  cache({
    id: HC_G1,
    path: `${HOME}/.claude/projects/__ROOT__-gone/${SESSION(9)}.jsonl`,
    label: "session 99999999 · 2026-04-28",
    harness: "claude-code",
    project: P_GONE,
    bytes: 921_600,
    files: 6,
    ageDays: 120,
    cacheKind: "transcript",
    unit: "session",
    rule: "swept",
    session: SESSION(9),
    liveGuard: { kind: "pid", alive: false },
  }),

  // harness cache — Claude Code, user scope
  cache({
    id: HC_SNAP_A,
    path: `${HOME}/.claude/shell-snapshots/snapshot-a.sh`,
    label: "snapshot-a.sh",
    harness: "claude-code",
    project: null,
    bytes: 276_480,
    ageDays: 45,
    cacheKind: "shell-snapshot",
    unit: "file",
    rule: "swept",
    sensitive: false,
    format: "other",
  }),
  cache({
    id: HC_SNAP_B,
    path: `${HOME}/.claude/shell-snapshots/snapshot-b.sh`,
    label: "snapshot-b.sh",
    harness: "claude-code",
    project: null,
    bytes: 270_336,
    ageDays: 46,
    cacheKind: "shell-snapshot",
    unit: "file",
    rule: "swept",
    sensitive: false,
    format: "other",
  }),
  cache({
    id: HC_BACKUP,
    path: `${HOME}/.claude/backups/.claude.json.backup.1700000000000`,
    label: ".claude.json.backup.1700000000000",
    harness: "claude-code",
    project: null,
    bytes: 61_440,
    ageDays: 5,
    cacheKind: "config-backup",
    unit: "file",
    rule: "swept",
    retention: { days: null, bytes: null, count: 5, source: "claude-directory" },
    liveGuard: null,
    format: "json",
  }),
  cache({
    id: HC_HISTORY,
    path: `${HOME}/.claude/history.jsonl`,
    label: "history.jsonl (every prompt typed)",
    harness: "claude-code",
    project: null,
    bytes: 1_468_006,
    ageDays: 0,
    cacheKind: "debug-log",
    unit: "file",
    rule: "kept",
    retention: { days: null, bytes: null, count: null, source: null },
    liveGuard: null,
    userContent: true,
  }),
  cache({
    id: HC_PLUGIN_110,
    path: `${HOME}/.claude/plugins/cache/acme/tools/1.1.0`,
    label: "tools@acme 1.1.0 (not installed)",
    harness: "claude-code",
    project: null,
    bytes: 4_404_019,
    files: 46,
    ageDays: 40,
    cacheKind: "plugin-cache-version",
    unit: "version",
    rule: "undocumented",
    retention: { days: null, bytes: null, count: null, source: null },
    liveGuard: { kind: "in-use-marker", alive: false },
    sensitive: false,
  }),
  cache({
    id: HC_PLUGIN_100,
    path: `${HOME}/.claude/plugins/cache/acme/tools/1.0.0`,
    label: "tools@acme 1.0.0 (in use by pid 4242)",
    harness: "claude-code",
    project: null,
    bytes: 4_100_000,
    files: 44,
    ageDays: 80,
    cacheKind: "plugin-cache-version",
    unit: "version",
    rule: "undocumented",
    retention: { days: null, bytes: null, count: null, source: null },
    liveGuard: { kind: "in-use-marker", alive: true },
    protection: "live",
    sensitive: false,
  }),
  cache({
    id: HC_IDE,
    path: `${HOME}/.claude/ide`,
    label: "ide/",
    harness: "claude-code",
    project: null,
    bytes: 3_145_728,
    files: 12,
    ageDays: 1,
    cacheKind: "undocumented",
    unit: "dir",
    rule: "undocumented",
    retention: { days: null, bytes: null, count: null, source: null },
    liveGuard: null,
    protection: "undocumented",
    removal: { method: "none" },
    sensitive: false,
  }),

  // harness cache — Codex, user scope
  cache({
    id: HC_ROLLOUT_1,
    path: `${HOME}/.codex/sessions/2026/06/10/rollout-2026-06-10T09-00-00-aaaa.jsonl`,
    label: "rollout 2026-06-10 aaaa",
    harness: "codex",
    project: P_OLD,
    bytes: 1_153_433,
    ageDays: 77,
    cacheKind: "transcript",
    unit: "session",
    rule: "kept",
    retention: { days: null, bytes: null, count: null, source: null },
  }),
  cache({
    id: HC_ROLLOUT_2,
    path: `${HOME}/.codex/sessions/2026/08/21/rollout-2026-08-21T18-30-00-bbbb.jsonl`,
    label: "rollout 2026-08-21 bbbb",
    harness: "codex",
    project: P_VLUE,
    bytes: 204_800,
    ageDays: 5,
    cacheKind: "transcript",
    unit: "session",
    rule: "kept",
    retention: { days: null, bytes: null, count: null, source: null },
  }),
  cache({
    id: HC_CODEX_HISTORY,
    path: `${HOME}/.codex/history.jsonl`,
    label: "history.jsonl (every prompt typed)",
    harness: "codex",
    project: null,
    bytes: 524_288,
    ageDays: 1,
    cacheKind: "debug-log",
    unit: "file",
    rule: "kept",
    retention: { days: null, bytes: 5_000_000, count: null, source: "history.max_bytes" },
    liveGuard: null,
    userContent: true,
  }),
  cache({
    id: HC_CODEX_TMP,
    path: `${HOME}/.codex/.tmp`,
    label: ".tmp/",
    harness: "codex",
    project: null,
    bytes: 220_200_960,
    files: 310,
    ageDays: 1,
    cacheKind: "undocumented",
    unit: "dir",
    rule: "undocumented",
    retention: { days: null, bytes: null, count: null, source: null },
    liveGuard: null,
    protection: "undocumented",
    removal: { method: "none" },
    sensitive: false,
  }),
  cache({
    id: HC_CODEX_DB,
    path: `${HOME}/.codex/state_5.sqlite`,
    label: "state_5.sqlite",
    harness: "codex",
    project: null,
    bytes: 8_388_608,
    ageDays: 0,
    cacheKind: "database",
    unit: "database",
    rule: "kept",
    retention: { days: null, bytes: null, count: null, source: null },
    liveGuard: null,
    protection: "never",
    removal: { method: "none" },
    format: "sqlite",
  }),

  // settings files (hidden by default)
  settingsFile({
    id: SF_CLAUDE_SETTINGS,
    path: `${HOME}/.claude/settings.json`,
    label: "~/.claude/settings.json",
    harness: "claude-code",
    project: null,
    scope: "user",
    bytes: 2100,
    role: "settings",
  }),
  settingsFile({
    id: SF_CLAUDE_JSON,
    path: `${HOME}/.claude.json`,
    label: "~/.claude.json",
    harness: "claude-code",
    project: null,
    scope: "user",
    bytes: 48_000,
    role: "state",
    entries: 2,
    sensitive: true,
  }),
  settingsFile({
    id: SF_VLUE_LOCAL,
    path: `${ROOT}/vlue/.claude/settings.local.json`,
    label: ".claude/settings.local.json",
    harness: "claude-code",
    project: P_VLUE,
    scope: "local",
    shared: false,
    relativePath: ".claude/settings.local.json",
    bytes: 400,
    role: "settings",
  }),
  settingsFile({
    id: SF_VLUE_MCP,
    path: `${ROOT}/vlue/.mcp.json`,
    label: ".mcp.json",
    harness: "claude-code",
    project: P_VLUE,
    scope: "project",
    shared: true,
    relativePath: ".mcp.json",
    bytes: 620,
    role: "mcp-config",
    entries: 2,
  }),
  settingsFile({
    id: SF_SKILL_LOCK,
    path: `${HOME}/.agents/.skill-lock.json`,
    label: "~/.agents/.skill-lock.json",
    harness: null,
    project: null,
    scope: "user",
    bytes: 900,
    role: "skill-lock",
    entries: 1,
  }),
  settingsFile({
    id: SF_PLUGINS,
    path: `${HOME}/.claude/plugins/installed_plugins.json`,
    label: "installed_plugins.json",
    harness: "claude-code",
    project: null,
    scope: "user",
    bytes: 700,
    role: "plugin-registry",
    entries: 1,
  }),
  settingsFile({
    id: SF_CODEX_CONFIG,
    path: `${HOME}/.codex/config.toml`,
    label: "~/.codex/config.toml",
    harness: "codex",
    project: null,
    scope: "user",
    bytes: 1800,
    role: "settings",
    format: "toml",
    entries: 1,
  }),
];

// ---------- edges ----------
const edges: Edge[] = [
  // baseline (every session)
  loadedBy(CF_USER_CLAUDE, CLAUDE, {
    project: null,
    mode: "full",
    reason: "user scope",
    tokens: 1180,
    order: 0,
    placement: `${HOME}/.claude/CLAUDE.md`,
  }),
  loadedBy(SK_BROWSER, CLAUDE, {
    project: null,
    mode: "description-only",
    reason: "user skill",
    tokens: 42,
    order: 1,
    effectiveName: "/agent-browser",
    placement: `${HOME}/.claude/skills/agent-browser`,
  }),
  loadedBy(SK_LINT, CLAUDE, {
    project: null,
    mode: "description-only",
    reason: "plugin skill",
    tokens: 38,
    order: 2,
    effectiveName: "/tools:lint",
  }),
  loadedBy(AG_ACME_BOT, CLAUDE, {
    project: null,
    mode: "description-only",
    reason: "plugin agent",
    tokens: null,
    counts: false,
  }),
  loadedBy(PL_TOOLS, CLAUDE, {
    project: null,
    mode: "full",
    reason: "enabled in ~/.claude/settings.json",
    tokens: null,
    counts: false,
  }),
  loadedBy(MCP_ACME, CLAUDE, {
    project: null,
    mode: "full",
    reason: "plugin MCP server",
    tokens: null,
    counts: false,
  }),
  loadedBy(CF_USER_AGENTS, CODEX, {
    project: null,
    mode: "full",
    reason: "user scope",
    tokens: 900,
    order: 0,
  }),
  loadedBy(SK_BROWSER, CODEX, {
    project: null,
    mode: "description-only",
    reason: "user skill",
    tokens: 40,
    order: 1,
    effectiveName: "agent-browser",
    placement: `${HOME}/.codex/skills/agent-browser`,
  }),
  loadedBy(MCP_LINEAR_CODEX, CODEX, {
    project: null,
    mode: "full",
    reason: "mcp_servers in config.toml",
    tokens: null,
    counts: false,
  }),

  // Project vlue
  loadedBy(CF_VLUE_CLAUDE, CLAUDE, {
    project: P_VLUE,
    mode: "full",
    reason: "ancestor of cwd",
    tokens: 2310,
    order: 0,
    placement: `${ROOT}/vlue/CLAUDE.md`,
  }),
  loadedBy(CF_VLUE_LOCAL, CLAUDE, {
    project: P_VLUE,
    mode: "full",
    reason: "ancestor of cwd",
    tokens: 400,
    order: 1,
  }),
  loadedBy(CF_VLUE_NOTES, CLAUDE, {
    project: P_VLUE,
    mode: "full",
    reason: "@-import from CLAUDE.local.md",
    tokens: 350,
    order: 2,
  }),
  loadedBy(CF_VLUE_RULE, CLAUDE, {
    project: P_VLUE,
    mode: "on-demand",
    reason: "paths-scoped rule (src/api/**)",
    tokens: null,
  }),
  loadedBy(CF_VLUE_AGENTS, CLAUDE, {
    project: P_VLUE,
    mode: "never",
    reason: "file not read by the harness",
    tokens: null,
  }),
  loadedBy(CF_VLUE_AGENTS, CODEX, {
    project: P_VLUE,
    mode: "full",
    reason: "ancestor of cwd",
    tokens: 4100,
    order: 0,
  }),
  loadedBy(CF_VLUE_CLAUDE, CODEX, {
    project: P_VLUE,
    mode: "never",
    reason: "file not read by the harness",
    tokens: null,
  }),
  loadedBy(MEM_VLUE_INDEX, CLAUDE, {
    project: P_VLUE,
    mode: "full",
    reason: "auto-memory index, min(200 lines, 25 KB)",
    tokens: 6100,
    order: 3,
  }),
  loadedBy(MEM_VLUE_AUTH, CLAUDE, {
    project: P_VLUE,
    mode: "on-demand",
    reason: "fact file, read through the index",
    tokens: null,
  }),
  loadedBy(MEM_VLUE_MIGRATION, CLAUDE, {
    project: P_VLUE,
    mode: "on-demand",
    reason: "fact file, read through the index",
    tokens: null,
  }),
  loadedBy(MEM_VLUE_DEPLOY, CLAUDE, {
    project: P_VLUE,
    mode: "on-demand",
    reason: "fact file, read through the index",
    tokens: null,
  }),
  loadedBy(MEM_VLUE_STACK, CLAUDE, {
    project: P_VLUE,
    mode: "on-demand",
    reason: "fact file, read through the index",
    tokens: null,
  }),
  loadedBy(SK_REVIEW, CLAUDE, {
    project: P_VLUE,
    mode: "description-only",
    reason: "project command",
    tokens: 20,
    order: 4,
    effectiveName: "/review",
  }),
  loadedBy(SK_DEPLOY, CLAUDE, {
    project: P_VLUE,
    mode: "never",
    reason: "dangling link",
    tokens: null,
  }),
  loadedBy(AG_REVIEWER, CLAUDE, {
    project: P_VLUE,
    mode: "description-only",
    reason: "project agent",
    tokens: 60,
    order: 5,
  }),
  loadedBy(AG_PLANNER, CLAUDE, {
    project: P_VLUE,
    mode: "description-only",
    reason: "project agent",
    tokens: 20,
    order: 6,
  }),
  loadedBy(MCP_POSTHOG_PROJECT, CLAUDE, {
    project: P_VLUE,
    mode: "full",
    reason: "approved in enabledMcpjsonServers",
    tokens: null,
    counts: false,
  }),
  loadedBy(MCP_POSTHOG_USER, CLAUDE, {
    project: P_VLUE,
    mode: "shadowed",
    reason: "project .mcp.json wins over ~/.claude.json",
    tokens: null,
    counts: false,
  }),
  loadedBy(MCP_LEGACY, CLAUDE, {
    project: P_VLUE,
    mode: "disabled",
    reason: "url without type",
    tokens: null,
    counts: false,
  }),

  // Project travia
  loadedBy(CF_TRAVIA_CLAUDE, CLAUDE, {
    project: P_TRAVIA,
    mode: "full",
    reason: "ancestor of cwd",
    tokens: 18_400,
    order: 0,
  }),
  loadedBy(MEM_TRAVIA_INDEX, CLAUDE, {
    project: P_TRAVIA,
    mode: "full",
    reason: "auto-memory index, min(200 lines, 25 KB)",
    tokens: 3000,
    order: 1,
  }),
  loadedBy(SK_BROWSER_COPY, CLAUDE, {
    project: P_TRAVIA,
    mode: "description-only",
    reason: "project skill",
    tokens: 45,
    order: 2,
    effectiveName: "/agent-browser",
  }),
  // Project numa365
  loadedBy(CF_NUMA_CLAUDE, CLAUDE, {
    project: P_NUMA,
    mode: "full",
    reason: "ancestor of cwd",
    tokens: 900,
    order: 0,
  }),

  // structure
  {
    id: `edge:imports:${CF_VLUE_LOCAL}:${CF_VLUE_NOTES}`,
    kind: "imports",
    from: CF_VLUE_LOCAL,
    to: CF_VLUE_NOTES,
    confidence: "certain",
    evidence: [{ kind: "import-statement", detail: "@docs/notes.md" }],
    hop: 1,
    external: false,
    syntax: "at-import",
  },
  {
    id: `edge:names-tool:${CF_VLUE_CLAUDE}:${MCP_POSTHOG_PROJECT}:posthog`,
    kind: "names-tool",
    from: CF_VLUE_CLAUDE,
    to: MCP_POSTHOG_PROJECT,
    tool: "posthog",
    confidence: "high",
    evidence: [{ kind: "body-mention", detail: "line 41: use the posthog MCP" }],
  },
  {
    id: `edge:names-tool:${AG_PLANNER}::jira`,
    kind: "names-tool",
    from: AG_PLANNER,
    to: null,
    tool: "jira",
    confidence: "high",
    evidence: [{ kind: "frontmatter", detail: "mcpServers: [jira]" }],
  },
  {
    id: `edge:references:${AG_REVIEWER}:${MEM_VLUE_INDEX}`,
    kind: "references",
    from: AG_REVIEWER,
    to: MEM_VLUE_INDEX,
    confidence: "medium",
    evidence: [{ kind: "frontmatter", detail: "memory: project" }],
    via: "frontmatter-skills",
  },
  {
    id: `edge:shadows:${MCP_POSTHOG_PROJECT}:${MCP_POSTHOG_USER}`,
    kind: "shadows",
    from: MCP_POSTHOG_PROJECT,
    to: MCP_POSTHOG_USER,
    confidence: "certain",
    evidence: [{ kind: "precedence-rule", detail: "local > project > user" }],
    rule: "local > project > user",
  },
  {
    id: `edge:duplicates:${SK_BROWSER_COPY}:${SK_BROWSER}`,
    kind: "duplicates",
    from: SK_BROWSER_COPY,
    to: SK_BROWSER,
    confidence: "high",
    evidence: [{ kind: "lock-entry", detail: "same origin vercel-labs/agent-browser" }],
    same: "origin",
  },
  {
    id: `edge:originates-from:${SK_BROWSER}:${SF_SKILL_LOCK}`,
    kind: "originates-from",
    from: SK_BROWSER,
    to: SF_SKILL_LOCK,
    confidence: "certain",
    evidence: [{ kind: "lock-entry", locator: browserOrigin.lock }],
  },
  {
    id: `edge:originates-from:${PL_TOOLS}:${SF_PLUGINS}`,
    kind: "originates-from",
    from: PL_TOOLS,
    to: SF_PLUGINS,
    confidence: "certain",
    evidence: [{ kind: "manifest" }],
  },
  {
    id: `edge:provided-by:${SK_LINT}:${PL_TOOLS}`,
    kind: "provided-by",
    from: SK_LINT,
    to: PL_TOOLS,
    confidence: "certain",
    evidence: [{ kind: "manifest" }],
  },
  {
    id: `edge:provided-by:${AG_ACME_BOT}:${PL_TOOLS}`,
    kind: "provided-by",
    from: AG_ACME_BOT,
    to: PL_TOOLS,
    confidence: "certain",
    evidence: [{ kind: "manifest" }],
  },
  {
    id: `edge:provided-by:${MCP_ACME}:${PL_TOOLS}`,
    kind: "provided-by",
    from: MCP_ACME,
    to: PL_TOOLS,
    confidence: "certain",
    evidence: [{ kind: "manifest" }],
  },
  ...[MEM_VLUE_AUTH, MEM_VLUE_MIGRATION, MEM_VLUE_DEPLOY, MEM_VLUE_STACK].map((fact): Edge => ({
    id: `edge:lists:${MEM_VLUE_INDEX}:${fact}`,
    kind: "lists",
    from: MEM_VLUE_INDEX,
    to: fact,
    confidence: "certain",
    evidence: [{ kind: "index-line" }],
  })),
  ...[MEM_TRAVIA_PRICING, MEM_TRAVIA_CI].map((fact): Edge => ({
    id: `edge:lists:${MEM_TRAVIA_INDEX}:${fact}`,
    kind: "lists",
    from: MEM_TRAVIA_INDEX,
    to: fact,
    confidence: "certain",
    evidence: [{ kind: "index-line" }],
  })),
];

// ---------- session loads / headline ----------
function sessionLoad(
  project: string | null,
  harness: string,
): { items: { entity: string; edge: string; order: number; tokens: number }[]; tokens: number } {
  const items = edges
    .filter(
      (e): e is LoadedByEdge =>
        e.kind === "loaded-by" &&
        e.to === harness &&
        e.project === project &&
        e.countsTowardHeadline &&
        e.tokensLoaded !== null,
    )
    .map((e) => ({ entity: e.from, edge: e.id, order: e.order ?? 0, tokens: e.tokensLoaded ?? 0 }))
    .toSorted((a, b) => a.order - b.order);
  return { items, tokens: items.reduce((acc, i) => acc + i.tokens, 0) };
}

const multipliers: Record<string, TokenRange> = {
  openai: { low: 1, mid: 1, high: 1 },
  google: { low: 1, mid: 1, high: 1 },
  "anthropic-46": { low: 1, mid: 1.15, high: 1.25 },
  "anthropic-47plus": { low: 1.3, mid: 1.5, high: 1.65 },
};

const ONE: TokenRange = { low: 1, mid: 1, high: 1 };

function headlineFor(
  harness: HarnessId,
  harnessId: string,
  family: string,
  context: number,
): Headline["perHarness"][number] {
  const m = multipliers[family] ?? ONE;
  const baseline = scale(sessionLoad(null, harnessId).tokens, m);
  const projectRange = scale(sessionLoad(P_VLUE, harnessId).tokens, m);
  const total = sum(baseline, projectRange);
  return {
    harness,
    modelFamily: family,
    contextWindowTokens: context,
    baseline,
    project: projectRange,
    total,
    pctOfContext: Math.round((total.mid / context) * 1000) / 10,
  };
}

// ---------- projects / breadcrumbs ----------
function makeProject(
  id: string,
  path: string,
  displayName: string,
  o: {
    reachability: Project["reachability"];
    enclosesCwd?: boolean;
    harnesses: string[];
    breadcrumbs: string[];
    kind?: Project["kind"];
    unreachableReason?: Project["unreachableReason"];
  },
): Project {
  const perHarness: Project["perHarness"] = {};
  for (const h of o.harnesses) {
    perHarness[h] = {
      trusted: true,
      effectiveSettings: {},
      sessionLoad: sessionLoad(id, `harness:${h}`),
    };
  }
  return {
    id,
    path,
    displayName,
    kind: o.kind ?? (o.reachability === "present" ? "repository" : "unknown"),
    reachability: o.reachability,
    unreachableReason: o.unreachableReason ?? null,
    enclosesCwd: o.enclosesCwd ?? false,
    discoveredBy: o.enclosesCwd ? ["breadcrumb", "cwd"] : ["breadcrumb"],
    parent: null,
    members: [{ path, role: "repository", name: null, gitdir: null, reachability: o.reachability }],
    breadcrumbs: o.breadcrumbs,
    nestedMarkers: [],
    perHarness,
  };
}

function breadcrumb(
  id: string,
  harness: HarnessId,
  raw: string,
  o: {
    project: string | null;
    reachability: Breadcrumb["reachability"];
    kind?: Breadcrumb["kind"];
    stray?: Breadcrumb["strayReason"];
    state?: string[];
  },
): Breadcrumb {
  return {
    id,
    harness,
    kind: o.kind ?? "projects-entry",
    raw,
    recordedForm: "path",
    path: raw,
    resolution: "direct",
    project: o.project,
    strayReason: o.stray ?? null,
    relativePathInProject: null,
    reachability: o.reachability,
    locator: {
      type: "entry",
      file: `${HOME}/.claude.json`,
      format: "json",
      keyPath: ["projects", raw],
    },
    occurrences: { count: 1, first: null, last: day(3) },
    refs: {},
    state: o.state ?? [],
  };
}

const projects: Project[] = [
  makeProject(P_VLUE, `${ROOT}/vlue`, "vlue", {
    reachability: "present",
    enclosesCwd: true,
    harnesses: ["claude-code", "codex"],
    breadcrumbs: [BC_VLUE],
  }),
  makeProject(P_TRAVIA, `${ROOT}/travia`, "travia", {
    reachability: "present",
    harnesses: ["claude-code"],
    breadcrumbs: [BC_TRAVIA],
  }),
  makeProject(P_NUMA, `${ROOT}/numa365`, "numa365", {
    reachability: "present",
    harnesses: ["claude-code"],
    breadcrumbs: [BC_NUMA],
  }),
  makeProject(P_GONE, `${ROOT}/gone`, "gone", {
    reachability: "orphan",
    harnesses: [],
    breadcrumbs: [BC_GONE],
  }),
  makeProject(P_OLD, `${ROOT}/old-experiment`, "old-experiment", {
    reachability: "orphan",
    harnesses: [],
    breadcrumbs: [BC_OLD],
  }),
  makeProject(P_UNREACHABLE, "/Volumes/Backup/old", "old", {
    reachability: "unreachable",
    harnesses: [],
    breadcrumbs: [BC_UNREACHABLE],
    unreachableReason: "mount-root",
  }),
];

const breadcrumbs: Breadcrumb[] = [
  breadcrumb(BC_VLUE, "claude-code", `${ROOT}/vlue`, {
    project: P_VLUE,
    reachability: "present",
    state: [HC_S1, HC_S2, HC_S3, HC_S5],
  }),
  breadcrumb(BC_TRAVIA, "claude-code", `${ROOT}/travia`, {
    project: P_TRAVIA,
    reachability: "present",
    state: [HC_T1, HC_T2],
  }),
  breadcrumb(BC_NUMA, "claude-code", `${ROOT}/numa365`, {
    project: P_NUMA,
    reachability: "present",
    state: [HC_N1],
  }),
  breadcrumb(BC_GONE, "claude-code", `${ROOT}/gone`, {
    project: P_GONE,
    reachability: "orphan",
    state: [HC_G1],
  }),
  breadcrumb(BC_OLD, "codex", `${ROOT}/old-experiment`, {
    project: P_OLD,
    reachability: "orphan",
    kind: "session-cwd",
    state: [HC_ROLLOUT_1],
  }),
  breadcrumb(BC_UNREACHABLE, "claude-code", "/Volumes/Backup/old", {
    project: P_UNREACHABLE,
    reachability: "unreachable",
  }),
  breadcrumb(BC_HOME, "claude-code", HOME, {
    project: null,
    reachability: "present",
    stray: "bare-directory",
  }),
];

// ---------- findings ----------
function finding(
  id: string,
  category: Finding["category"],
  severity: Finding["severity"],
  container: string | null,
  message: string,
  o: {
    targets: Finding["targets"];
    action: Finding["action"]["kind"];
    preselect?: boolean;
    flags?: Finding["flags"];
    bytes?: number;
    tokens?: number | null;
    files?: number;
    evidence?: string;
  },
): Finding {
  return {
    id,
    category,
    severity,
    container,
    targets: o.targets,
    message,
    evidence: [{ kind: "loading-rule", detail: o.evidence ?? message }],
    confidence: "high",
    impact: { bytes: o.bytes ?? 0, tokens: o.tokens ?? null, files: o.files ?? 1 },
    flags: o.flags ?? [],
    action: { kind: o.action, preselect: o.preselect ?? false, locator: null },
  };
}

const findings: Finding[] = [
  finding(
    "finding:duplicate:agent-browser",
    "duplicate",
    "medium",
    P_TRAVIA,
    "agent-browser is installed twice from the same origin; the travia copy differs",
    {
      targets: [
        { id: SK_BROWSER_COPY, role: "subject" },
        { id: SK_BROWSER, role: "counterpart" },
      ],
      action: "delete",
      flags: ["shared"],
      bytes: 16_900,
      tokens: 45,
      files: 3,
    },
  ),
  finding(
    "finding:orphan:deploy",
    "orphan",
    "high",
    P_VLUE,
    "deploy links to a directory that no longer exists",
    {
      targets: [{ id: SK_DEPLOY, role: "subject" }],
      action: "delete",
      flags: ["shared"],
      bytes: 0,
      files: 1,
      evidence: "symlink-target: ../../../../.agents/skills/deploy (ENOENT)",
    },
  ),
  finding(
    "finding:orphan:planner-jira",
    "orphan",
    "low",
    P_VLUE,
    "planner names the MCP server jira, which is configured nowhere",
    { targets: [{ id: AG_PLANNER, role: "subject" }], action: "open", bytes: 900, files: 1 },
  ),
  finding(
    "finding:orphan:gone",
    "orphan",
    "low",
    P_GONE,
    "<ROOT>/gone is gone; Claude Code still keeps a 900 KB session for it",
    {
      targets: [{ id: HC_G1, role: "state", preselect: true }],
      action: "clean",
      preselect: true,
      flags: ["sensitive"],
      bytes: 921_600,
      files: 6,
    },
  ),
  finding(
    "finding:orphan:old-experiment",
    "orphan",
    "low",
    P_OLD,
    "<ROOT>/old-experiment is gone; Codex keeps a rollout for it (kept state, Delete only)",
    {
      targets: [{ id: HC_ROLLOUT_1, role: "state" }],
      action: "delete",
      flags: ["sensitive"],
      bytes: 1_153_433,
      files: 1,
    },
  ),
  finding(
    "finding:bloat:travia-claude-md",
    "bloat",
    "high",
    P_TRAVIA,
    "CLAUDE.md costs 18.4k tokens in every travia session",
    {
      targets: [{ id: CF_TRAVIA_CLAUDE, role: "subject" }],
      action: "open",
      flags: ["shared"],
      bytes: 73_600,
      tokens: 18_400,
    },
  ),
  finding(
    "finding:bloat:vlue-memory-index",
    "bloat",
    "medium",
    P_VLUE,
    "MEMORY.md has 260 lines; Claude Code injects only the first 200 (6.1k tokens every session)",
    {
      targets: [{ id: MEM_VLUE_INDEX, role: "subject" }],
      action: "clean",
      flags: ["memory"],
      bytes: 27_000,
      tokens: 6100,
    },
  ),
  finding(
    "finding:drift:travia-agent-browser",
    "drift",
    "low",
    P_TRAVIA,
    "agent-browser was modified locally after install (origin vercel-labs/agent-browser@main)",
    {
      targets: [{ id: SK_BROWSER_COPY, role: "subject" }],
      action: "update",
      flags: ["shared"],
      bytes: 16_900,
      files: 3,
    },
  ),
  finding(
    "finding:shadow-memory:vlue",
    "shadow-memory",
    "medium",
    P_VLUE,
    "5 memory files about vlue live outside the repository; 2 were never read",
    {
      targets: [
        { id: MEM_VLUE_INDEX, role: "subject" },
        { id: MEM_VLUE_AUTH, role: "subject" },
        { id: MEM_VLUE_MIGRATION, role: "subject" },
        { id: MEM_VLUE_DEPLOY, role: "subject" },
        { id: MEM_VLUE_STACK, role: "subject" },
      ],
      action: "clean",
      flags: ["memory"],
      bytes: 45_800,
      tokens: 6100,
      files: 5,
    },
  ),
  finding(
    "finding:shadow-memory:travia",
    "shadow-memory",
    "low",
    P_TRAVIA,
    "3 memory files about travia live outside the repository; 1 was never read",
    {
      targets: [
        { id: MEM_TRAVIA_INDEX, role: "subject" },
        { id: MEM_TRAVIA_PRICING, role: "subject" },
        { id: MEM_TRAVIA_CI, role: "subject" },
      ],
      action: "clean",
      flags: ["memory"],
      bytes: 19_800,
      tokens: 3000,
      files: 3,
    },
  ),
  finding(
    "finding:autogenerated:numa365",
    "autogenerated",
    "low",
    P_NUMA,
    "CLAUDE.md still carries the /init template (no project-specific guidance)",
    {
      targets: [{ id: CF_NUMA_CLAUDE, role: "subject" }],
      action: "open",
      flags: ["shared"],
      bytes: 3600,
      tokens: 900,
    },
  ),
  finding(
    "finding:harness-cache:vlue:transcript",
    "harness-cache",
    "low",
    P_VLUE,
    "1 of 5 sessions is older than the 20-day retention Claude Code sweeps itself",
    {
      targets: [
        { id: HC_S1, role: "subject", preselect: true },
        { id: HC_S2, role: "subject", preselect: false },
        { id: HC_S3, role: "subject", preselect: false },
        { id: HC_S4, role: "subject", preselect: false },
        { id: HC_S5, role: "subject", preselect: false },
      ],
      action: "clean",
      preselect: true,
      flags: ["sensitive", "live", "user-content"],
      bytes: 3_361_996,
      files: 32,
      evidence: "cleanupPeriodDays = 20; newest member 45 days old",
    },
  ),
  finding(
    "finding:harness-cache:travia:transcript",
    "harness-cache",
    "low",
    P_TRAVIA,
    "1 of 2 sessions is older than the 20-day retention Claude Code sweeps itself",
    {
      targets: [
        { id: HC_T1, role: "subject", preselect: true },
        { id: HC_T2, role: "subject", preselect: false },
      ],
      action: "clean",
      preselect: true,
      flags: ["sensitive"],
      bytes: 3_660_185,
      files: 19,
    },
  ),
  finding(
    "finding:harness-cache:claude-code:shell-snapshot",
    "harness-cache",
    "low",
    CLAUDE,
    "2 shell snapshots are older than the 20-day retention Claude Code sweeps itself",
    {
      targets: [
        { id: HC_SNAP_A, role: "subject", preselect: true },
        { id: HC_SNAP_B, role: "subject", preselect: true },
      ],
      action: "clean",
      preselect: true,
      bytes: 546_816,
      files: 2,
    },
  ),
  finding(
    "finding:harness-cache:claude-code:plugin-cache-version",
    "harness-cache",
    "low",
    CLAUDE,
    "tools@acme 1.1.0 is cached but no longer installed (Claude Code documents no sweep for it)",
    {
      targets: [
        { id: HC_PLUGIN_110, role: "subject", preselect: false },
        { id: HC_PLUGIN_100, role: "subject", preselect: false },
      ],
      action: "clean",
      flags: ["live"],
      bytes: 8_504_019,
      files: 90,
    },
  ),
  finding(
    "finding:harness-cache:codex:transcript",
    "harness-cache",
    "low",
    CODEX,
    "Codex documents no sweep; 2 rollouts (1.3 MB) are kept state, Delete only",
    {
      targets: [
        { id: HC_ROLLOUT_1, role: "subject" },
        { id: HC_ROLLOUT_2, role: "subject" },
      ],
      action: "delete",
      flags: ["sensitive"],
      bytes: 1_358_233,
      files: 2,
    },
  ),
  finding(
    "finding:exposure:posthog",
    "exposure",
    "high",
    P_VLUE,
    "posthog carries an Authorization header in a git-tracked .mcp.json",
    {
      targets: [{ id: MCP_POSTHOG_PROJECT, role: "subject" }],
      action: "open",
      flags: ["shared", "secret-exposed"],
      bytes: 210,
      evidence: "secret-key: headers.Authorization; git-status: tracked",
    },
  ),
  finding(
    "finding:exposure:linear",
    "exposure",
    "medium",
    CODEX,
    "linear keeps LINEAR_API_KEY inline in ~/.codex/config.toml",
    {
      targets: [{ id: MCP_LINEAR_CODEX, role: "subject" }],
      action: "open",
      flags: ["secret-exposed"],
      bytes: 260,
    },
  ),
];

// ---------- the index ----------
const totalBytes = entities.reduce((acc, e) => acc + e.metrics.bytes, 0);

export const fakeIndex: AuditIndex = {
  schemaVersion: 0,
  generatedAt: "2026-08-26T10:00:00Z",
  moldig: { version: "0.0.0-proto" },
  scan: {
    home: HOME,
    roots: [ROOT],
    cwd: `${ROOT}/vlue`,
    platform: "darwin",
    caseFold: true,
    env: {},
    git: { available: true, version: "2.50.1" },
    durationMs: 640,
  },
  tokenizer: {
    name: "gpt-tokenizer",
    version: "4.0.0",
    encoding: "o200k_base",
    fallbackUsed: false,
    multipliers,
  },
  harnesses: [
    {
      id: CLAUDE,
      harness: "claude-code",
      displayName: "Claude Code",
      surfaces: ["cli"],
      presence: "installed",
      version: "2.1.245",
      effectiveModel: "claude-opus-4-7",
      modelFamily: "anthropic-47plus",
      contextWindowTokens: 200_000,
      capabilities: {
        memoryLocation: "file",
        memoryReadSignal: "exact",
        contextFileNames: ["CLAUDE.md", "CLAUDE.local.md"],
        sweepDocumented: true,
      },
      caps: {
        memoryIndexLines: 200,
        memoryIndexBytes: 25_600,
        chainMaxBytes: null,
        skillDescriptionChars: 1536,
        importDepth: 4,
      },
      effectiveSettings: { cleanupPeriodDays: 20, autoMemoryEnabled: true },
      breadcrumbSources: [
        { kind: "projects-entry", path: `${HOME}/.claude.json`, readInV1: true },
        { kind: "slug-directory", path: `${HOME}/.claude/projects`, readInV1: true },
      ],
      userScope: {
        paths: [{ path: `${HOME}/.claude`, role: "data", source: "default", envVar: null }],
        stray: [BC_HOME],
        baseline: sessionLoad(null, CLAUDE),
      },
    },
    {
      id: CODEX,
      harness: "codex",
      displayName: "Codex",
      surfaces: ["cli", "desktop"],
      presence: "installed",
      version: null,
      effectiveModel: "gpt-5-codex",
      modelFamily: "openai",
      contextWindowTokens: 272_000,
      capabilities: {
        memoryLocation: "file",
        memoryReadSignal: "not-applicable",
        contextFileNames: ["AGENTS.md"],
        sweepDocumented: false,
      },
      caps: {
        memoryIndexLines: null,
        memoryIndexBytes: null,
        chainMaxBytes: 32_768,
        skillDescriptionChars: null,
        importDepth: null,
      },
      effectiveSettings: {},
      breadcrumbSources: [
        { kind: "session-cwd", path: `${HOME}/.codex/state_5.sqlite`, readInV1: true },
      ],
      userScope: {
        paths: [{ path: `${HOME}/.codex`, role: "data", source: "default", envVar: "CODEX_HOME" }],
        stray: [],
        baseline: sessionLoad(null, CODEX),
      },
    },
  ],
  projects,
  breadcrumbs,
  entities,
  edges,
  warnings: [
    {
      code: "stat-deadline",
      message: "/Volumes/Backup/old could not be checked in time",
      harness: "claude-code",
      path: "/Volumes/Backup/old",
      effect: "skipped",
    },
  ],
  totals: {
    entities: entities.length,
    files: entities.reduce((acc, e) => acc + (e.metrics.files ?? 0), 0),
    bytes: totalBytes,
    harnessCacheBytes: entities
      .filter((e) => e.kind === "harness-cache")
      .reduce((acc, e) => acc + e.metrics.bytes, 0),
    memoryBytes: entities
      .filter((e) => e.kind === "memory-file")
      .reduce((acc, e) => acc + e.metrics.bytes, 0),
    tokens: entities.reduce((acc, e) => acc + (e.metrics.tokens?.o200k ?? 0), 0),
  },
  findings,
  headline: {
    scope: "user-controllable",
    focus: { project: P_VLUE, reason: "cwd" },
    perHarness: [
      headlineFor("claude-code", CLAUDE, "anthropic-47plus", 200_000),
      headlineFor("codex", CODEX, "openai", 272_000),
    ],
  },
};
