/**
 * The Copilot adapter's working state: what `discover` resolved (trust entries, session
 * workspaces, VS Code workspace records, the two settings layers), what `collect` emits, and
 * the builders every entity and edge share — ids, relative paths, git status and the
 * `loaded-by` edges with their chain order.
 */
import { relative, sep } from "node:path";
import type {
  Breadcrumb,
  Confidence,
  Edge,
  Entity,
  EntityBase,
  Evidence,
  Format,
  GitStatus,
  LoadedByEdge,
  Locator,
  Metrics,
  Scope,
  Surface,
} from "../../index/types.js";
import type { ScanContext } from "../../scan/context.js";
import type { DiscoveredProject, Located } from "../../scan/discovery.js";
import { edgeId, isUnder, tildify } from "../../scan/paths.js";
import type { ProjectFacts } from "../adapter.js";
import type { CopilotConfig, SettingsLayer } from "./config.js";
import type { CopilotPaths } from "./paths.js";

export const HARNESS_ID = "harness:copilot";
export const HARNESS = "copilot" as const;

/** One `trusted_folders[]` string of `~/.copilot/config.json`, resolved (ticket 06 §1). */
export interface TrustEntry {
  raw: string;
  located: Located | null;
}

/** One `session-state/<uuid>/` directory and the flat keys its `workspace.yaml` carries. */
export interface SessionRecord {
  id: string;
  dir: string;
  /** `<dir>/workspace.yaml` — the only file of the session moldig ever opens. */
  file: string;
  cwd: string | null;
  gitRoot: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Where `cwd` folded; `null` when the file is missing, unparsable or outside every Root. */
  located: Located | null;
}

/** One `workspaceStorage/<id>/` directory of the VS Code surface and its `workspace.json`. */
export interface WorkspaceRecord {
  storageId: string;
  dir: string;
  file: string;
  /** The URI exactly as VS Code recorded it; `null` when the record names no folder (D31). */
  raw: string | null;
  located: Located | null;
  /** D31: a record naming no folder at all is a Stray breadcrumb, never a Project. */
  unresolved: boolean;
  remote: boolean;
}

export interface CopilotScan {
  ctx: ScanContext;
  paths: CopilotPaths;
  config: CopilotConfig;
  /** The VS Code user `settings.json` layer (JSONC), read once in `discover`. */
  vscodeUserSettings: SettingsLayer;
  /** `config.json` + the `chat.*` / `github.copilot*` keys of VS Code, secrets redacted. */
  harnessSettings: Record<string, unknown>;
  trust: TrustEntry[];
  sessions: SessionRecord[];
  workspaces: WorkspaceRecord[];
  /** Folded member paths whose `.github/` or `.vscode/mcp.json` qualifies as Copilot's. */
  qualified: Set<string>;
  /** Folded MCP file path → entries parsed from it, so a settings row need not re-read the file. */
  mcpEntries: Map<string, number>;
  entities: Map<string, Entity>;
  edges: Map<string, Edge>;
  breadcrumbs: Breadcrumb[];
  projectFacts: Map<string, ProjectFacts>;
  orders: Map<string, number>;
}

/** Path relative to the Project (forward slashes); `null` when the path is not inside one. */
export function relativeTo(
  project: DiscoveredProject | null,
  path: string,
  fold: (p: string) => string,
): string | null {
  if (project === null) return null;
  const inside = project.members.some((member) => isUnder(fold(path), fold(member.path)));
  if (!inside) return null;
  return relative(project.path, path).split(sep).join("/");
}

export interface BaseInput {
  kind: EntityBase["kind"];
  path: string;
  scope: Scope;
  project: DiscoveredProject | null;
  ownership: EntityBase["ownership"];
  locator: Locator;
  format: Format;
  label?: string;
  sensitive: boolean;
  protection: EntityBase["protection"];
  removal: EntityBase["removal"];
  metrics: Metrics;
  keyPath?: readonly string[];
  /** `null` for a store several harnesses share (`~/.agents/skills/<n>`). */
  harness?: EntityBase["harness"];
  producer?: EntityBase["producer"];
}

export function baseEntity(scan: CopilotScan, input: BaseInput): EntityBase {
  const { ctx } = scan;
  const fold = ctx.identity.fold;
  const relativePath = relativeTo(input.project, input.path, fold);
  const insideRepo = input.project !== null && relativePath !== null;
  const gitStatus: GitStatus | null = insideRepo ? ctx.gitStatusOf(input.path) : "outside-repo";
  const shared =
    gitStatus === null || gitStatus === "outside-repo"
      ? null
      : gitStatus === "tracked" && (input.scope === "project" || input.scope === "local");
  return {
    id: ctx.id(input.kind, input.path, input.keyPath),
    kind: input.kind,
    harness: input.harness === undefined ? HARNESS : input.harness,
    producer: input.producer ?? null,
    project: input.project?.id ?? null,
    scope: input.scope,
    ownership: input.ownership,
    shared,
    gitStatus,
    path: input.path,
    relativePath,
    locator: input.locator,
    format: input.format,
    label: input.label ?? relativePath ?? tildify(input.path, scan.paths.home),
    sensitive: input.sensitive,
    protection: input.protection,
    removal: input.removal,
    metrics: input.metrics,
  };
}

/** Adds an entity unless one with the same id exists (the first real thing wins). */
export function addEntity<T extends Entity>(scan: CopilotScan, entity: T): T {
  const existing = scan.entities.get(entity.id);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one id ↔ one kind (ADR-0007)
  if (existing !== undefined) return existing as T;
  scan.entities.set(entity.id, entity);
  return entity;
}

export function addEdge(scan: CopilotScan, edge: Edge): Edge {
  const existing = scan.edges.get(edge.id);
  if (existing !== undefined) return existing;
  scan.edges.set(edge.id, edge);
  return edge;
}

export function nextOrder(scan: CopilotScan, project: string | null): number {
  const key = project ?? "";
  const order = scan.orders.get(key) ?? 0;
  scan.orders.set(key, order + 1);
  return order;
}

export function evidence(kind: string, detail?: string, locator?: Locator): Evidence {
  const out: Evidence = { kind };
  if (detail !== undefined) out.detail = detail;
  if (locator !== undefined) out.locator = locator;
  return out;
}

/**
 * D136: one `loaded-by` edge per (entity, harness, **Project**) — the baseline verdict keeps
 * the plain id, a Project-scoped one carries the Project segment. The two surfaces of this
 * harness share one edge (the index has no surface field on an edge, ticket 07 §14), so the
 * surface is named in `reason`.
 */
export function loadedByEdgeId(from: string, project: string | null): string {
  const base = edgeId("loaded-by", from, HARNESS_ID);
  return project === null ? base : `${base}:${project}`;
}

export interface LoadedByInput {
  from: string;
  project: string | null;
  mode: LoadedByEdge["mode"];
  reason: string;
  placement: string | null;
  effectiveName: string | null;
  /** `true` = take the next chain position for the Project; `false` = no position. */
  ordered: boolean;
  charsLoaded: number | null;
  importsResolved: number | null;
  tokensLoaded: number | null;
  disableModelInvocation: boolean | null;
  countsTowardHeadline: boolean;
  evidence: Evidence[];
  confidence?: Confidence;
}

export function loadedBy(scan: CopilotScan, input: LoadedByInput): LoadedByEdge {
  const id = loadedByEdgeId(input.from, input.project);
  const existing = scan.edges.get(id);
  if (existing !== undefined && existing.kind === "loaded-by") return existing;
  const edge: LoadedByEdge = {
    id,
    kind: "loaded-by",
    from: input.from,
    to: HARNESS_ID,
    confidence: input.confidence ?? "certain",
    evidence: input.evidence,
    project: input.project,
    mode: input.mode,
    reason: input.reason,
    placement: input.placement,
    effectiveName: input.effectiveName,
    order: input.ordered ? nextOrder(scan, input.project) : null,
    charsLoaded: input.charsLoaded,
    importsResolved: input.importsResolved,
    tokensLoaded: input.tokensLoaded,
    disableModelInvocation: input.disableModelInvocation,
    countsTowardHeadline: input.countsTowardHeadline,
  };
  scan.edges.set(id, edge);
  return edge;
}

/** The surface a file belongs to, spelled for a `reason` string. */
export function surfaceName(surface: Surface): string {
  return surface === "vscode" ? "VS Code" : "the CLI";
}

/**
 * One present member of a Project whose `.github/` qualifies as Copilot's, with the settings a
 * session started there sees: the VS Code user layer overlaid by the member's own
 * `.vscode/settings.json` (the workspace layer wins per key).
 */
export interface MemberScope {
  project: DiscoveredProject;
  path: string;
  /** What a session started here sees: the user layer overlaid by the workspace layer. */
  settings: Record<string, unknown>;
  /** The workspace layer alone — index v0's `perHarness[h].effectiveSettings` is project + local. */
  workspaceSettings: Record<string, unknown>;
}
