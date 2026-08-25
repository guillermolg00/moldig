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
export { audit, isPreselected } from "./audit/audit.js";
export type { AuditOptions } from "./audit/audit.js";
export { MULTIPLIERS, modelFamilyOf } from "./tokens/tokenizer.js";

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
