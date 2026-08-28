/**
 * The actions engine's contract: a Selection becomes a Plan (`plan.ts`) and a Plan becomes a
 * run manifest (`apply.ts`). Everything that touches the filesystem, a process or the network
 * arrives as an injected executor, so `@moldig/core` stays pure and terminal-free (ADR-0003,
 * D103) and every rule below is testable without moving a byte.
 *
 * Index v0 is frozen (ADR-0007): nothing here changes it. The manifest shape is D115's, the
 * badges are their own union (D114), delegates carry argv + cwd and no shell ever runs (D87).
 */
import type { EntityKind, Flag, HarnessId, Locator } from "../index/types.js";

/** CONTEXT.md Action. Selections are grouped by action; each group is confirmed as a whole. */
export type Action = "clean" | "delete" | "update" | "open";

/** Confirmation order (14 §3): Clean → Delete → Update → Open. Open is never executed. */
export const ACTION_ORDER: readonly Action[] = ["clean", "delete", "update", "open"];

/** The title each group prints (CONTEXT.md's words, never "purge"/"remove"/"upgrade"). */
export const ACTION_TITLES: Readonly<Record<Action, string>> = {
  clean: "Clean",
  delete: "Delete",
  update: "Update",
  open: "Open",
};

/**
 * One selected target: an Entity id, or a locator-only target named by a Finding or an explicit
 * orphan-Project selection (a lock entry, memory unit or harness store record).
 */
export type UpdateBatchTarget =
  | {
      readonly kind: "vercel-skills";
      readonly key: string;
      readonly label: string;
      readonly lock: Locator;
      readonly scope: "global" | "project";
      readonly names: readonly string[];
    }
  | {
      readonly kind: "docker-image";
      readonly key: string;
      readonly label: string;
      readonly locator: Locator;
      readonly image: string;
      /** Trusted Docker command name and verified global options, preserved without a shell. */
      readonly argvPrefix: readonly string[];
      /** The run target's platform, when one was explicit; carried into the image pull. */
      readonly platform: string | null;
    };

export interface SelectionTarget {
  action: Action;
  /** Entity id; omitted for a locator-only target. */
  id?: string;
  /** Locator of a target with no entity; omitted when `id` is given. */
  locator?: Locator;
  /** One placement path of a Skill ("remove for <harness>"); omitted = the whole Skill. */
  placement?: string;
  /** Row label for a locator-only target. */
  label?: string;
  /** Richer identity for a grouped Project-state target; defaults preserve the v1 shapes. */
  kind?: "lock-entry" | "memory-unit" | "project-state";
  harness?: HarnessId | null;
  project?: string | null;
  /** Known aggregate bytes for a locator-only target. */
  bytes?: number;
  /** One pre-aggregated, core-recognised Update invocation. */
  updateBatch?: UpdateBatchTarget;
  /** The Finding that proposed the row, when it came from one. */
  finding?: string;
}
export type Selection = readonly SelectionTarget[];

/** How a volume was classified (08 §3.2). `home` and `local` are the only two that can move. */
export type VolumeClass = "home" | "local" | "dropped-mount" | "network" | "read-only" | "unknown";

/** What the host says about the volume a path sits on; injected so refusal is testable. */
export interface Device {
  dev: number;
  kind: "local" | "dropped-mount" | "network" | "read-only" | "unknown";
}

/** CONTEXT.md Disposition: where a removed item goes, decided before anything moves. */
export type DispositionKind = "trash" | "backup-edit" | "delegate" | "update" | "open" | "refused";

export interface Disposition {
  kind: DispositionKind;
  /** The literal preview string (08 §4): `→ Trash`, `→ backup + edit`, `refused: …`. */
  display: string;
  /** The human-readable command (`removal.command`, or the Installer's), never executed. */
  command: string | null;
  /** What actually runs: argv + working directory, no shell, ever (D87). */
  argv: string[] | null;
  cwd: string | null;
  /** The harness offers no recovery (08 §3): only `opencode session delete` in v1. */
  permanent: boolean;
  /** `false` for a command moldig shows and never runs (`git -C <dir> pull`, 14 §2). */
  runnable: boolean;
  /** Why the row is refused, or what a delegate is preceded by; null otherwise. */
  reason: string | null;
}

/** Run-manifest badges are their own union (D114), never index v0's six-value `Flag`. */
export type Badge =
  | "permanent"
  | "never-read"
  | "locally-modified"
  | "dangling"
  | "kept"
  | "size-only"
  | "invalid"
  | "secret";

export interface PlanTarget {
  /** Stable key of the target: its Entity id, or a string derived from its Locator. */
  key: string;
  id: string | null;
  locator: Locator;
  label: string;
  kind: EntityKind | "lock-entry" | "memory-unit" | "project-state" | "update-batch";
  harness: HarnessId | null;
  project: string | null;
}

/** A recoverable copy taken before anything is edited, moved or delegated (08 §3). */
export interface PlanBackup {
  path: string;
  to: string;
  /** A directory copy (a locally modified Skill before an Update, 14 §2). */
  recursive: boolean;
  /** A live SQLite database needs its online-backup API rather than a byte copy. */
  sqlite?: boolean;
}

/** Recoverable edits: every source file/database is backed up before one of these runs. */
export type PlanEdit =
  | { kind: "json-entry"; file: string; format: "json" | "jsonc"; keyPath: string[] }
  | {
      kind: "json-array-value";
      file: string;
      format: "json" | "jsonc";
      keyPath: string[];
      value: string;
    }
  | { kind: "toml-table"; file: string; keyPath: string[] }
  | { kind: "sqlite-rows"; file: string; table: string; keyColumn: string; keyValue: string }
  | { kind: "memory-index"; file: string; fact: string };

export interface PlanRow {
  key: string;
  action: Action;
  target: PlanTarget;
  disposition: Disposition;
  /** Every path the trash moves, in order: placement links first, then the real directory (D94). */
  paths: string[];
  backups: PlanBackup[];
  edits: PlanEdit[];
  bytes: number;
  /** Tokens per session this row frees, per harness id (08 §4). */
  tokensPerSession: Record<string, number>;
  flags: Flag[];
  badges: Badge[];
  /** How the row's paths were classified; null when the row moves nothing. */
  volume: VolumeClass | null;
  finding: string | null;
}

export interface PlanGroup {
  action: Action;
  title: string;
  rows: PlanRow[];
  count: number;
  bytes: number;
  tokensPerSession: Record<string, number>;
  /** How many rows are Shared (git-tracked, collaborators may rely on them). */
  shared: number;
  /** The lines the preview prints under the group header (08 §4). */
  warnings: string[];
  extraConfirmation: { required: boolean; reason: string | null };
}

export interface Plan {
  runId: string;
  startedAt: string;
  dataDir: string;
  backupDir: string;
  manifestPath: string;
  command: string;
  moldig: { version: string };
  groups: PlanGroup[];
}

/** Everything `plan()` needs from the host; `deviceOf` is the only probe, and it is injected. */
export interface PlanEnv {
  home: string;
  platform: "darwin" | "linux" | "win32";
  /** `$XDG_DATA_HOME/moldig`, `%LOCALAPPDATA%\moldig` — never inside a repository (08 §3). */
  dataDir: string;
  now: Date;
  moldig: { version: string };
  /** The command line the manifest records (`clean --yes --harness claude-code`). */
  command: string;
  deviceOf: (path: string) => Device;
}

export type RowStatus = "planned" | "moved" | "edited" | "delegated" | "refused" | "failed";

export interface ManifestTarget extends PlanTarget {
  paths: string[];
  bytes: number;
  backupPaths: string[];
  flags: Flag[];
  badges: Badge[];
}

export interface ManifestRow {
  target: ManifestTarget;
  finding: string | null;
  disposition: Disposition;
  tokensPerSession: Record<string, number>;
  result: { status: RowStatus; reason: string | null; at: string | null; exitCode: number | null };
}

export interface ManifestGroupSummary {
  rows: number;
  bytes: number;
  tokensPerSession: Record<string, number>;
  shared: number;
  moved: number;
  edited: number;
  delegated: number;
  refused: number;
  failed: number;
  planned: number;
}

export interface ManifestGroup {
  action: Action;
  confirmation: {
    extraRequired: boolean;
    extraReason: string | null;
    answer: ConfirmAnswer | null;
  };
  status: "planned" | "ran" | "skipped";
  summary: ManifestGroupSummary;
  /** Row keys, in the order the group ran them. */
  rows: string[];
}

/** D115: one run-manifest shape, the richer one. `run` carries D91's fields. */
export interface RunManifest {
  schemaVersion: 0;
  run: {
    id: string;
    startedAt: string;
    finishedAt: string | null;
    moldig: { version: string };
    command: string;
    dataDir: string;
  };
  mode: "dry-run" | "run";
  manifestPath: string;
  backupDir: string;
  selection: { key: string; action: Action }[];
  /** The Open group is never here (08 §5.3): it touches no disk. */
  groups: ManifestGroup[];
  rows: ManifestRow[];
}

export interface TrashResult {
  /** Paths that are gone after the call. */
  moved: string[];
  /** Paths still in place: the call did not move them. */
  left: string[];
  error: string | null;
}
export interface SpawnResult {
  exitCode: number | null;
  stderr: string;
}
export interface StatResult {
  exists: boolean;
  bytes: number;
  /** Stable lstat fingerprint for the path at this instant; null only when it does not exist. */
  identity: string | null;
}

/** Every side effect `apply()` can have. `packages/cli` implements them (D88, D103). */
export interface Executors {
  /** Moves every path in one call and re-checks them; never copies across devices (08 §3). */
  trash: (paths: string[]) => Promise<TrashResult>;
  /** Byte-for-byte copy of a file or directory into the run's backup directory. */
  backup: (path: string, to: string, expectedIdentity?: string | null) => Promise<void>;
  /** Consistent online backup of a SQLite database, including committed WAL state. */
  backupSqlite?: (path: string, to: string, expectedIdentity?: string | null) => Promise<void>;
  /** Delete every row whose key column equals the exact breadcrumb value. */
  deleteSqliteRows?: (
    file: string,
    table: string,
    keyColumn: string,
    keyValue: string,
    expectedIdentity?: string | null,
  ) => Promise<number>;
  /** Atomic write: a temp file in the same directory, then a rename (08 §2). */
  writeFile: (path: string, text: string, expectedIdentity?: string | null) => Promise<void>;
  /** Runs a delegate: argv + working directory, never a shell (D87). */
  spawn: (command: { argv: string[]; cwd: string | null }) => Promise<SpawnResult>;
  readFile: (path: string) => Promise<string | null>;
  stat: (path: string) => Promise<StatResult | null>;
  now: () => Date;
}

export type ConfirmAnswer = "run" | "skip" | "skip-rest";
/** The TUI answers from keys; the non-interactive path answers `run` for every group (08 §7). */
export type Confirm = (group: PlanGroup, stage: "ask" | "extra") => Promise<ConfirmAnswer>;

/** One executor boundary: emitted before a row starts and after it settles. */
export interface ApplyProgress {
  action: Action;
  completed: number;
  total: number;
  label: string;
  status: RowStatus | null;
}

export interface ApplyOptions {
  confirm?: Confirm;
  /** `dry-run` runs no executor and leaves every row `planned` (D4, D115). */
  mode?: "run" | "dry-run";
  /** Synchronous observation hook; it never decides or blocks the run. */
  onProgress?: (event: ApplyProgress) => void;
}
