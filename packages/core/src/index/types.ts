/**
 * Index v0 — the unified, harness-agnostic contract shared by the CLI and the app
 * (ADR-0002, ADR-0007). Transcribed from ticket 07's frozen TypeScript sketch, comments
 * included, with its 2026-08-26 amendments (ticket 08): `HarnessCache.retention.count`,
 * the `sqlite` locator for OpenCode sessions, `protection: "undocumented"` (moldig cannot
 * say what the item is) as distinct from `rule: "undocumented"` (the harness documents no
 * sweep for a known cacheKind), and `capabilities.sweepDocumented`.
 *
 * Nothing here is renamed, reordered or "cleaned up": the sketch is the contract.
 */

// ---------- root ----------
export interface Index {
  schemaVersion: 0;
  generatedAt: string; // ISO 8601 UTC
  moldig: { version: string };
  scan: {
    home: string;
    roots: string[];
    cwd: string;
    platform: "darwin" | "linux" | "win32";
    caseFold: boolean; // identity folds case (darwin / win32)
    env: Record<string, string>; // only the overrides honoured (CLAUDE_CONFIG_DIR, CODEX_HOME, …)
    git: { available: boolean; version: string | null };
    durationMs: number;
  };
  tokenizer: {
    name: "gpt-tokenizer";
    version: string;
    encoding: "o200k_base";
    fallbackUsed: boolean; // bytes/4 used somewhere (see warnings)
    multipliers: Record<ModelFamily, TokenRange>; // consumers apply them to o200k counts
  };
  harnesses: Harness[];
  projects: Project[];
  breadcrumbs: Breadcrumb[];
  entities: Entity[]; // flat, `kind` discriminator
  edges: Edge[];
  warnings: Warning[];
  totals: {
    entities: number;
    files: number;
    bytes: number;
    harnessCacheBytes: number;
    memoryBytes: number;
    tokens: number;
  }; // inventory; no session pays it
}
export interface AuditIndex extends Index {
  findings: Finding[];
  headline: Headline;
}

export type HarnessId =
  | "claude-code"
  | "codex"
  | "cursor"
  | "gemini-cli"
  | "copilot"
  | "opencode"
  | (string & {}); // open: community adapters
export type Surface = "cli" | "ide" | "desktop" | "vscode" | (string & {});
export type ModelFamily = "openai" | "google" | "anthropic-46" | "anthropic-47plus" | (string & {});
export type Scope = "system" | "user" | "project" | "local";
export type Confidence = "certain" | "high" | "medium" | "low";
export type Reachability = "present" | "orphan" | "unreachable";
export interface TokenRange {
  low: number;
  mid: number;
  high: number;
}
export interface SessionLoad {
  // ordered; every item is justified by a loaded-by edge
  items: { entity: string; edge: string; order: number; tokens: number }[]; // tokens = edge.tokensLoaded (o200k, capped)
  tokens: number;
}

// ---------- harness ----------
export interface Harness {
  id: string; // "harness:claude-code"
  harness: HarnessId;
  displayName: string;
  surfaces: Surface[]; // one Harness per product family (copilot = CLI + VS Code, codex = CLI + desktop, cursor = IDE + cursor-agent)
  presence: "installed" | "config-only" | "absent";
  version: string | null; // only when the harness writes it to disk (Claude Code); binaries are never run
  effectiveModel: string | null;
  modelFamily: ModelFamily | null; // derived; null → multiplier 1
  contextWindowTokens: number | null; // null without a shipped model catalogue
  capabilities: {
    memoryLocation: "file" | "server-side" | "none";
    memoryReadSignal: "exact" | "unchecked" | "not-applicable";
    contextFileNames: string[]; // effective (Gemini context.fileName honoured)
    sweepDocumented: boolean; // Claude Code and Gemini CLI ≥ 0.10 (research 10); false elsewhere
  };
  caps: {
    // documented loading caps the UI quotes; null = undocumented
    memoryIndexLines: number | null;
    memoryIndexBytes: number | null;
    chainMaxBytes: number | null;
    skillDescriptionChars: number | null;
    importDepth: number | null;
  };
  effectiveSettings: Record<string, unknown>; // system + user layers, secrets redacted (cleanupPeriodDays, autoMemoryEnabled, …)
  breadcrumbSources: { kind: BreadcrumbKind; path: string; readInV1: boolean }[];
  userScope: {
    paths: {
      path: string;
      role: "config" | "data" | "cache" | "state" | "app-support";
      source: "default" | "env";
      envVar: string | null;
    }[];
    stray: string[]; // breadcrumb ids
    baseline: SessionLoad; // paid in every session of this harness, whatever the Project
  };
}

// ---------- project ----------
export interface Project {
  id: string; // "project:<folded realpath>" (the recorded path when the directory is gone)
  path: string;
  displayName: string; // basename; the UI adds the parent on collision
  kind: "repository" | "detached-worktree" | "plain-directory" | "unknown"; // unknown = directory gone; an intact linked worktree is a member of its repository
  reachability: Reachability;
  unreachableReason: "mount-root" | "stat-timeout" | null;
  enclosesCwd: boolean;
  discoveredBy: ("breadcrumb" | "marker-walk" | "cwd")[];
  parent: string | null; // enclosing Project (nested repository)
  members: {
    path: string;
    role: "repository" | "worktree";
    name: string | null;
    gitdir: string | null;
    reachability: Reachability;
  }[];
  breadcrumbs: string[]; // ids into breadcrumbs[]
  nestedMarkers: { relativePath: string; marker: string; entity: string | null }[];
  perHarness: Partial<
    Record<
      HarnessId,
      {
        trusted: boolean | null;
        effectiveSettings: Record<string, unknown>; // project + local layers (enabledPlugins, claudeMdExcludes, enabledMcpjsonServers, project_doc_max_bytes, …)
        sessionLoad: SessionLoad; // what a session started here adds on top of userScope.baseline
      }
    >
  >;
}

export type BreadcrumbKind =
  | "projects-entry"
  | "trust-entry"
  | "workspace-record"
  | "session-cwd"
  | "slug-directory"
  | "worktree-directory"
  | "project-row"
  | "legacy-project-record";
export interface Breadcrumb {
  id: string; // "breadcrumb:<harness>:<folded locator>"
  harness: HarnessId;
  kind: BreadcrumbKind;
  raw: string; // exactly as recorded: path, file:// URI, TOML key, slug
  recordedForm: "path" | "file-uri" | "slug" | "window-id" | "tmp";
  path: string | null; // decoded / resolved
  resolution:
    | "direct"
    | "slug-by-key"
    | "slug-by-transcript-cwd"
    | "slug-by-existence"
    | "unresolved";
  project: string | null; // the Project it folded into; null = stray
  strayReason: "bare-directory" | "unresolved-slug" | null;
  relativePathInProject: string | null; // subdirectory or worktree it actually pointed at
  reachability: Reachability;
  locator: Locator;
  occurrences: { count: number; first: string | null; last: string | null };
  refs: { lastSessionId?: string; workspaceStorageId?: string; projectId?: string };
  state: string[]; // entity ids of the harness-owned state behind it
}

// ---------- locator ----------
export type EntryFormat = "json" | "jsonc" | "toml" | "yaml" | "frontmatter";
export type Locator =
  | { type: "file"; path: string }
  | { type: "dir"; path: string }
  | { type: "paths"; paths: string[] } // multi-directory unit (a Claude session)
  | { type: "entry"; file: string; format: EntryFormat; keyPath: string[] } // raw key segments, no escaping
  | { type: "array-value"; file: string; format: EntryFormat; keyPath: string[]; value: string }
  | { type: "sqlite"; file: string; table: string; keyColumn: string; keyValue: string }; // amendment (ticket 08): an OpenCode session lives in a row, read through node:sqlite read-only

// ---------- entity base ----------
export type EntityKind =
  | "context-file"
  | "skill"
  | "mcp-server"
  | "memory-file"
  | "agent-definition"
  | "harness-cache"
  | "plugin"
  | "settings-file";
export type Format =
  | "md"
  | "mdc"
  | "txt"
  | "toml"
  | "json"
  | "jsonc"
  | "yaml"
  | "starlark"
  | "js"
  | "jsonl"
  | "jsonl.zst"
  | "sqlite"
  | "pb"
  | "dir"
  | "other";
export type GitStatus = "tracked" | "untracked" | "ignored" | "outside-repo";
export interface EntityBase {
  id: string; // "<kind>:<folded canonical locator>"
  kind: EntityKind;
  harness: HarnessId | null; // null = a store several harnesses share (.agents/skills, skills-lock.json)
  producer: { harness: HarnessId | "other-app"; surface: Surface } | null; // who wrote it, when not the harness's own CLI
  project: string | null;
  scope: Scope;
  ownership: "human" | "harness";
  shared: boolean | null; // gitStatus = tracked and scope ∈ {project, local}; null = no repo / git not run
  gitStatus: GitStatus | null;
  path: string; // on-disk casing; realpath for skills
  relativePath: string | null; // to the Project when project != null
  locator: Locator;
  format: Format;
  label: string; // what the row shows
  sensitive: boolean; // may hold secrets or conversation text
  protection: "none" | "never" | "live" | "undocumented"; // amendment (ticket 08): `undocumented` = moldig cannot say what this item is (size-only row, no action); distinct from HarnessCache.rule "undocumented"
  removal: { method: "trash" | "backup-edit" | "delegate" | "none"; command?: string };
  metrics: Metrics;
}
export interface Metrics {
  bytes: number;
  files: number | null;
  lines: number | null;
  mtime: string | null;
  ageDays: number | null;
  tokens: { o200k: number; method: "o200k_base" | "bytes/4" } | null; // null for harness-cache (never decoded) and config entries
  lastUsed: string | null; // when the harness records usage (skillUsage, agentLastUsed)
}

// ---------- kinds ----------
export interface ContextFile extends EntityBase {
  kind: "context-file";
  form: "context" | "local" | "rule" | "instructions";
  fileName: string; // CLAUDE.md, AGENTS.md, ultracite.mdc, copilot-instructions.md …
  frontmatter: Record<string, unknown>; // paths / globs / alwaysApply / applyTo / inclusion — projected by consumers
  importCount: number; // `imports` edges carry the graph
  containsMemorySection: boolean; // legacy "## Gemini Added Memories"
}
export interface Placement {
  // one path a harness reaches a skill through
  path: string;
  harness: HarnessId | null;
  surface: Surface | null;
  scope: Scope;
  project: string | null;
  gitStatus: GitStatus | null;
  shared: boolean | null;
  isSymlink: boolean;
  linkTarget: string | null; // link text verbatim
  dangling: boolean;
}
export interface Skill extends EntityBase {
  kind: "skill";
  form: "skill-dir" | "command-file";
  name: string; // frontmatter name ?? dirName
  dirName: string;
  frontmatterName: string | null;
  layout: "canonical" | "copy" | "plugin" | "synced" | "bundled";
  placements: Placement[]; // Q1 — the row reads "agent-browser · 6 harnesses"
  frontmatter: Record<string, unknown>; // description lives here, once
  sidecars: string[]; // agents/openai.yaml, .claude-plugin/plugin.json
  contentHash: { algo: "sha256-folder" | "git-tree-sha1"; value: string }[]; // git-tree-sha1 in pure JS whenever a lock records a 40-hex value
  origin: Origin | null;
  drift: "unknown" | "none" | "local-modified" | "copies-differ"; // unknown on win32 (mode-bits-unavailable)
}
export interface Origin {
  // attribute; the originates-from edge points at the lock entry
  // amendment (D42): `git-clone` — a `.git` inside the skill directory, the installer ticket 14 §2 recognises
  installer:
    | "vercel-skills"
    | "claude-plugin"
    | "codex-plugin"
    | "gemini-extension"
    | "git-clone"
    | "unknown";
  sourceType:
    | "github"
    | "git"
    | "well-known"
    | "mintlify"
    | "huggingface"
    | "npm"
    | "local"
    | "node_modules"
    | "marketplace"
    | "unknown";
  source: string;
  sourceUrl: string | null;
  ref: string | null;
  skillPath: string | null;
  recordedHash: { algo: "git-tree-sha1" | "sha256-folder" | "unknown"; value: string } | null;
  installedAt: string | null;
  updatedAt: string | null;
  lock: Locator; // entry inside .skill-lock.json / skills-lock.json / installed_plugins.json
}
export interface McpServer extends EntityBase {
  kind: "mcp-server";
  name: string;
  transport: "stdio" | "http" | "sse" | "ws" | "remote" | "unknown";
  command: string | null;
  args: string[];
  url: string | null; // secret-looking args redacted; url without query string or userinfo
  envKeys: string[];
  headerKeys: string[];
  secretKeys: string[];
  hasOauth: boolean;
  usesInterpolation: boolean;
  enabled: boolean | null;
  approval: "approved" | "rejected" | "pending" | "not-applicable" | "unknown";
  invalid: string | null; // "url without type", …
  endpointKey: string; // normalised command+args or url, for duplicates
  rawKeys: string[]; // key names of the native entry — never values
}
export interface MemoryFile extends EntityBase {
  kind: "memory-file";
  role: "index" | "fact" | "other";
  unit: string; // the memory directory
  owner: "project" | "global" | `agent:${string}`;
  frontmatter: Record<string, unknown>;
  loadedPortion: { lines: number; bytes: number; tokens: number; confidence: "certain" } | null; // index files: min(200 lines, 25 KB)
  reads: { count: number; first: string | null; last: string | null } | null;
  writes: { count: number; last: string | null } | null;
  neverRead: boolean | null; // null = no signal for this harness or not computed
  readSignal: {
    source: "transcript-tool-use" | "none" | "not-computed";
    exact: boolean;
    bashParsed: boolean;
  };
}
export interface AgentDefinition extends EntityBase {
  kind: "agent-definition";
  name: string;
  form: "markdown" | "json" | "toml-table";
  frontmatter: Record<string, unknown>; // tools, model, memory, skills, mcpServers …
  hooks: HookDecl[];
}
export interface HarnessCache extends EntityBase {
  // one entity per sweep unit — never per file, never per group
  kind: "harness-cache";
  cacheKind: string; // closed list per adapter: transcript, subagent-transcript, tool-result, file-history, shell-snapshot,
  // session-env, task-list, paste-cache, config-backup, debug-log, plan, plugin-cache-version,
  // marketplace-clone, marketplace-backup, database, checkpoint, mcp-cache, worktree, log, undocumented
  unit: "session" | "version" | "clone" | "file" | "dir" | "database"; // an OpenCode session is a `session` unit with a sqlite locator (ticket 08)
  surface: Surface | null; // which surface of the harness wrote the unit
  session: string | null;
  slug: string | null;
  rule: "swept" | "kept" | "exempt" | "undocumented"; // what the harness documents for this cacheKind (`undocumented` = no documented sweep for a known cacheKind: tickable, never preselected)
  retention: {
    days: number | null;
    bytes: number | null;
    count: number | null;
    source: string | null;
  }; // count: Gemini maxCount, Cursor worktreeMaxCount (ticket 08)
  liveGuard: {
    kind: "pid" | "in-use-marker" | "install-path" | "recent-activity";
    alive: boolean;
  } | null; // null = could not check → never preselect
  userContent: boolean; // plans, pasted files → ask
  members: { files: number; bytes: number; oldest: string | null; newest: string | null }; // the unit's age = newest
}
export interface Plugin extends EntityBase {
  // identity = the real install directory
  kind: "plugin";
  pluginId: string; // "<plugin>@<marketplace>"; "<extension>" for Gemini
  version: string | null;
  marketplace: string | null;
  installs: { scope: Scope; project: string | null; enabled: boolean | null }[];
  origin: Origin | null; // installer claude-plugin | gemini-extension; ref = gitCommitSha; updatedAt = lastUpdated; lock = the registry entry
  hooks: HookDecl[];
}
export interface SettingsFile extends EntityBase {
  kind: "settings-file";
  role:
    | "settings"
    | "state"
    | "mcp-config"
    | "skill-lock"
    | "plugin-registry"
    | "hooks"
    | "policy"
    | "manifest"
    | "credentials";
  topLevelKeys: string[]; // [] for credentials (stat only, protection never)
  entries: number | null; // lock entries, plugin entries, MCP entries
  hooks: HookDecl[];
}
export interface HookDecl {
  event: string;
  type: string;
  command: string | null;
  matcher: string | null;
}
export type Entity =
  | ContextFile
  | Skill
  | McpServer
  | MemoryFile
  | AgentDefinition
  | HarnessCache
  | Plugin
  | SettingsFile;

// ---------- edges ----------
export type EdgeKind =
  | "names"
  | "names-tool"
  | "references"
  | "loaded-by"
  | "duplicates"
  | "originates-from"
  | "shadows"
  | "imports"
  | "provided-by"
  | "lists";
export interface Evidence {
  kind: string;
  detail?: string;
  locator?: Locator;
}
// evidence kinds: symlink-target, lock-entry, content-hash, name-only, endpoint, frontmatter, body-mention, hook-command,
//                 precedence-rule, loading-rule, listing-rule, retention-rule, import-statement, manifest, index-line, git-status, secret-key
export interface EdgeBase {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string | null;
  confidence: Confidence;
  evidence: Evidence[];
} // id = "edge:<kind>:<from>:<to>[:<tool>]"
export interface NamesEdge extends EdgeBase {
  kind: "names";
  to: string;
} // body mention
export interface NamesToolEdge extends EdgeBase {
  kind: "names-tool";
  tool: string;
  to: string | null;
} // null: the named server is configured nowhere
export interface ReferencesEdge extends EdgeBase {
  kind: "references";
  to: string;
  via: "hook-command" | "frontmatter-skills" | "frontmatter-mcp" | "external-import";
}
export interface LoadedByEdge extends EdgeBase {
  // from: context-file | skill | memory-file | mcp-server | agent-definition | plugin → to: harness
  kind: "loaded-by";
  to: string;
  project: string | null; // Project the verdict holds for; null = every session (baseline)
  mode:
    | "full"
    | "description-only"
    | "on-demand"
    | "manual"
    | "never"
    | "disabled"
    | "shadowed"
    | "unknown";
  reason: string; // "ancestor of cwd", "paths-scoped rule", "alwaysApply:false", "beyond 32 KiB chain", "untrusted project", "file not read by the harness"
  placement: string | null; // the path the harness found it through
  effectiveName: string | null; // "/<plugin>:<name>", "/<subdir>:<name>"
  order: number | null; // position in the load chain
  charsLoaded: number | null; // after the harness's own stripping and caps
  importsResolved: number | null; // @-imports this reader actually resolved
  tokensLoaded: number | null; // o200k, capped — never more than the harness would send
  disableModelInvocation: boolean | null;
  countsTowardHeadline: boolean;
}
export interface DuplicatesEdge extends EdgeBase {
  kind: "duplicates";
  to: string;
  same: "content" | "origin" | "endpoint" | "name";
}
export interface OriginatesFromEdge extends EdgeBase {
  kind: "originates-from";
  to: string;
} // skill | plugin → settings-file; evidence = lock entry locator
export interface ShadowsEdge extends EdgeBase {
  kind: "shadows";
  to: string;
  rule: string;
} // "local > project > user"
export interface ImportsEdge extends EdgeBase {
  kind: "imports";
  to: string;
  hop: number;
  external: boolean;
  syntax: "at-import" | "include";
}
export interface ProvidedByEdge extends EdgeBase {
  kind: "provided-by";
  to: string;
} // bundled skill | agent | mcp-server → plugin
export interface ListsEdge extends EdgeBase {
  kind: "lists";
  to: string;
} // memory index → fact
export type Edge =
  | NamesEdge
  | NamesToolEdge
  | ReferencesEdge
  | LoadedByEdge
  | DuplicatesEdge
  | OriginatesFromEdge
  | ShadowsEdge
  | ImportsEdge
  | ProvidedByEdge
  | ListsEdge;

// ---------- findings / headline / warnings (audit only, except warnings) ----------
export type Category =
  | "duplicate"
  | "orphan"
  | "bloat"
  | "drift"
  | "shadow-memory"
  | "autogenerated"
  | "harness-cache"
  | "exposure";
export type Flag = "shared" | "sensitive" | "secret-exposed" | "memory" | "live" | "user-content";
export interface Finding {
  id: string;
  category: Category;
  severity: "low" | "medium" | "high"; // Q3: always present, rendered as a badge; not the sort key
  container: string | null; // Project id or Harness id it is filed under
  targets: {
    id?: string;
    locator?: Locator;
    role: "subject" | "counterpart" | "breadcrumb" | "state";
    preselect?: boolean;
  }[]; // locator-only for a lock entry whose dir is gone
  message: string;
  evidence: Evidence[];
  confidence: Confidence;
  impact: { bytes: number; tokens: number | null; files: number };
  flags: Flag[];
  action: {
    kind: "clean" | "delete" | "update" | "open" | "none";
    preselect: boolean;
    locator: Locator | null;
  };
}
export interface Headline {
  // Q4: the focused Project per harness; --json carries every (Project × harness) via sessionLoad
  scope: "user-controllable"; // never the system prompt, env info or tool schemas
  focus: { project: string | null; reason: "cwd" | "most-expensive" | "none" };
  perHarness: {
    harness: HarnessId;
    modelFamily: ModelFamily | null;
    contextWindowTokens: number | null;
    baseline: TokenRange; // userScope.baseline.tokens × multipliers
    project: TokenRange; // focused Project's sessionLoad.tokens × multipliers
    total: TokenRange;
    pctOfContext: number | null; // total.mid / contextWindowTokens, in percent
  }[];
}
export interface Warning {
  code:
    | "parse-error"
    | "stat-deadline"
    | "sqlite-unreadable"
    | "tokenizer-fallback"
    | "unsupported-shape"
    | "git-missing"
    | "read-signal-skipped";
  message: string;
  harness: HarnessId | null;
  path: string | null;
  effect: "skipped" | "partial" | "degraded";
}
