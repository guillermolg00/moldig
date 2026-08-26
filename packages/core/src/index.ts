/**
 * The moldig engine. Index v0 (ticket 07, ADR-0007) is the contract shared by the CLI and
 * the app; adapters, detectors and the graph land here on top of it.
 */

/** The harnesses moldig v1 knows how to scan (`HarnessId` stays open for community adapters). */
export const HARNESSES = [
  "claude-code",
  "codex",
  "cursor",
  "gemini-cli",
  "copilot",
  "opencode",
] as const;

export { scan } from "./scan/scan.js";
export type { ScanOptions } from "./scan/scan.js";
/** D125: the CLI validates `--platform`/`process.platform` with these before it calls `scan`. */
export { assertScanPlatform, isScanPlatform, SCAN_PLATFORMS } from "./scan/paths.js";
export type { ScanPlatform } from "./scan/paths.js";
export { audit, isPreselected } from "./audit/audit.js";
export type { AuditOptions } from "./audit/audit.js";
export { MULTIPLIERS, modelFamilyOf } from "./tokens/tokenizer.js";

// The actions engine (ticket 24): pure planning here, executors injected by the CLI (D103).
export { apply } from "./actions/apply.js";
export {
  backupDirFor,
  backupPathFor,
  dataDirFor,
  encodePath,
  locatorKey,
  manifestPathFor,
  runIdFor,
} from "./actions/data-dir.js";
export { delegateCwdFor, parseDelegate, updateDelegateFor } from "./actions/delegates.js";
export type { DelegateCommand } from "./actions/delegates.js";
export { removeJsonEntry, rewriteMemoryIndex } from "./actions/edits.js";
export { plan } from "./actions/plan.js";
export {
  canDelete,
  canUpdate,
  inCleanUniverse,
  isLive,
  isPreselectedUnit,
  isProtected,
  isSizeOnly,
  isTickable,
  placementLinks,
  selectionFrom,
  tickableUnits,
} from "./actions/selection.js";
export type { SelectionOptions } from "./actions/selection.js";
export { summaryLines } from "./actions/summary.js";
export type { SummaryOptions } from "./actions/summary.js";
export { updatePreview, UPDATE_PREVIEW_TIMEOUT_MS } from "./actions/update.js";
export type { InstalledCopy, UpdateFetchers, UpdatePreview } from "./actions/update.js";
export { ACTION_ORDER, ACTION_TITLES } from "./actions/types.js";
export type {
  Action,
  ApplyOptions,
  Badge,
  Confirm,
  ConfirmAnswer,
  Device,
  Disposition,
  DispositionKind,
  Executors,
  ManifestGroup,
  ManifestGroupSummary,
  ManifestRow,
  ManifestTarget,
  Plan,
  PlanBackup,
  PlanEdit,
  PlanEnv,
  PlanGroup,
  PlanRow,
  PlanTarget,
  RowStatus,
  RunManifest,
  Selection,
  SelectionTarget,
  SpawnResult,
  StatResult,
  TrashResult,
  VolumeClass,
} from "./actions/types.js";

export type {
  AgentDefinition,
  AuditIndex,
  Breadcrumb,
  BreadcrumbKind,
  Category,
  Confidence,
  ContextFile,
  DuplicatesEdge,
  Edge,
  EdgeBase,
  EdgeKind,
  Entity,
  EntityBase,
  EntityKind,
  EntryFormat,
  Evidence,
  Finding,
  Flag,
  Format,
  GitStatus,
  Harness,
  HarnessCache,
  HarnessId,
  Headline,
  HookDecl,
  ImportsEdge,
  Index,
  ListsEdge,
  LoadedByEdge,
  Locator,
  McpServer,
  MemoryFile,
  Metrics,
  ModelFamily,
  NamesEdge,
  NamesToolEdge,
  Origin,
  OriginatesFromEdge,
  Placement,
  Plugin,
  Project,
  ProvidedByEdge,
  Reachability,
  ReferencesEdge,
  Scope,
  SessionLoad,
  SettingsFile,
  ShadowsEdge,
  Skill,
  Surface,
  TokenRange,
  Warning,
} from "./index/types.js";
