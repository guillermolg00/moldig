/**
 * The Cursor adapter's working state: what `discover` resolved, what `collect` emits, and the
 * small builders every entity and edge share (ids, relative paths, git status, `loaded-by` edges
 * with their chain order). Same shape as the Claude Code slice's `model.ts` — one adapter reads
 * like the next.
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
  HarnessId,
  LoadedByEdge,
  Locator,
  Metrics,
  Scope,
} from "../../index/types.js";
import type { ScanContext } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { edgeId, isUnder, tildify } from "../../scan/paths.js";
import type { ProjectFacts } from "../adapter.js";
import type { SlugResolution, WorkspaceRecord, WorktreeLeaf } from "./breadcrumbs.js";
import type { CursorPaths } from "./paths.js";

export const HARNESS_ID = "harness:cursor";
export const HARNESS: HarnessId = "cursor";

export interface CursorScan {
  ctx: ScanContext;
  paths: CursorPaths;
  /** `<app-support>/User/workspaceStorage/<id>/`, resolved in `discover`. */
  records: WorkspaceRecord[];
  /** `~/.cursor/projects/<slug>`, resolved through the records and the known Projects. */
  slugs: SlugResolution[];
  /** `~/.cursor/worktrees/<repo>/<id>/`, attributed through their `gitdir:` pointer. */
  worktrees: WorktreeLeaf[];
  /** `~/.cursor/cli-config.json`, raw (the only user-scope file whose values are read). */
  cliConfig: Record<string, unknown>;
  /** `<app-support>/User/settings.json`, raw (two keys are modelled, §1.2). */
  ideSettings: Record<string, unknown>;
  /** `cli-config.json` + the two IDE keys, secrets redacted (D64). */
  harnessSettings: Record<string, unknown>;
  /** `cursor.worktreeMaxCount` and whether it was unusable (D120). */
  retention: { count: number | null; invalid: boolean };
  entities: Map<string, Entity>;
  edges: Map<string, Edge>;
  breadcrumbs: Breadcrumb[];
  projectFacts: Map<string, ProjectFacts>;
  orders: Map<string, number>;
}

export function projectsOf(scan: CursorScan): DiscoveredProject[] {
  return scan.ctx.discovery.projects();
}

/** Path relative to the Project (forward slashes; `../<worktree>/…` inside a linked worktree). */
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
  /** `null` for a store several harnesses share (`~/.agents/skills/<n>`) — ticket 07 §4. */
  harness?: HarnessId | null;
  producer?: EntityBase["producer"];
}

export function baseEntity(scan: CursorScan, input: BaseInput): EntityBase {
  const { ctx } = scan;
  const fold = ctx.identity.fold;
  const relativePath = relativeTo(input.project, input.path, fold);
  const insideRepo = input.project !== null && relativePath !== null;
  const gitStatus: GitStatus | null = insideRepo ? ctx.gitStatusOf(input.path) : "outside-repo";
  // Ticket 07: `shared` = tracked ∧ scope ∈ {project, local}; `null` = no repo / git not run.
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
export function addEntity<T extends Entity>(scan: CursorScan, entity: T): T {
  const existing = scan.entities.get(entity.id);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one id ↔ one kind (ADR-0007)
  if (existing !== undefined) return existing as T;
  scan.entities.set(entity.id, entity);
  return entity;
}

export function addEdge(scan: CursorScan, edge: Edge): Edge {
  const existing = scan.edges.get(edge.id);
  if (existing !== undefined) return existing;
  scan.edges.set(edge.id, edge);
  return edge;
}

export function nextOrder(scan: CursorScan, project: string | null): number {
  const key = project ?? "";
  const order = scan.orders.get(key) ?? 0;
  scan.orders.set(key, order + 1);
  return order;
}

export interface LoadedByInput {
  from: string;
  project: string | null;
  mode: LoadedByEdge["mode"];
  reason: string;
  placement: string | null;
  effectiveName: string | null;
  /** `true` = take the next chain position for the Project; `false` = no position (on demand). */
  ordered: boolean;
  charsLoaded: number | null;
  tokensLoaded: number | null;
  countsTowardHeadline: boolean;
  evidence: Evidence[];
  disableModelInvocation?: boolean | null;
  confidence?: Confidence;
}

/** D136: one `loaded-by` edge per (entity, harness, **Project**) — the id carries the Project. */
export function loadedByEdgeId(from: string, project: string | null): string {
  const base = edgeId("loaded-by", from, HARNESS_ID);
  return project === null ? base : `${base}:${project}`;
}

export function loadedBy(scan: CursorScan, input: LoadedByInput): LoadedByEdge {
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
    // Cursor documents no import syntax for its rules (D68: `importCount: 0`, no `imports` edges).
    importsResolved: null,
    tokensLoaded: input.tokensLoaded,
    disableModelInvocation: input.disableModelInvocation ?? null,
    countsTowardHeadline: input.countsTowardHeadline,
  };
  scan.edges.set(id, edge);
  return edge;
}

export function evidence(kind: string, detail?: string, locator?: Locator): Evidence {
  const out: Evidence = { kind };
  if (detail !== undefined) out.detail = detail;
  if (locator !== undefined) out.locator = locator;
  return out;
}
