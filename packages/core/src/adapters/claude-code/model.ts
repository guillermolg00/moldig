/**
 * The Claude Code adapter's working state: what `discover` resolved, what `collect` emits,
 * and the small builders every entity and edge share (ids, relative paths, git status,
 * loaded-by edges with their chain order).
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
} from "../../index/types.js";
import type { ScanContext } from "../../scan/context.js";
import type { DiscoveredProject, Located } from "../../scan/discovery.js";
import { isUnder, edgeId } from "../../scan/paths.js";
import { tildify } from "../../scan/paths.js";
import type { ProjectFacts } from "../adapter.js";
import type { ClaudePaths } from "./paths.js";
import type { ClaudeJson, SettingsFiles } from "./state.js";
import type { SlugDir } from "./transcripts.js";

export const HARNESS_ID = "harness:claude-code";

export interface SlugResolution {
  slug: SlugDir;
  located: Located | null;
  resolution: Breadcrumb["resolution"];
}

export interface ClaudeScan {
  ctx: ScanContext;
  paths: ClaudePaths;
  claudeJson: ClaudeJson;
  userSettings: SettingsFiles;
  /** User layer, secrets redacted (the system layer is not read in this slice). */
  harnessSettings: Record<string, unknown>;
  retention: { days: number | null; invalid: boolean };
  /** Slug directories, resolved; those naming a Project outside every Root are already dropped. */
  slugs: SlugResolution[];
  /** `projects` keys → where they resolved (keys outside every Root are not listed). */
  keyLocated: Map<string, Located>;
  /** The harness version as the newest transcript recorded it (research 01); `null` = never written. */
  version: string | null;
  entities: Map<string, Entity>;
  edges: Map<string, Edge>;
  breadcrumbs: Breadcrumb[];
  projectFacts: Map<string, ProjectFacts>;
  orders: Map<string, number>;
}

export function projectsOf(scan: ClaudeScan): DiscoveredProject[] {
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
}

export function baseEntity(scan: ClaudeScan, input: BaseInput): EntityBase {
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
    harness: "claude-code",
    producer: null,
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
export function addEntity<T extends Entity>(scan: ClaudeScan, entity: T): T {
  const existing = scan.entities.get(entity.id);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one id ↔ one kind (ADR-0007)
  if (existing !== undefined) return existing as T;
  scan.entities.set(entity.id, entity);
  return entity;
}

export function addEdge(scan: ClaudeScan, edge: Edge): Edge {
  const existing = scan.edges.get(edge.id);
  if (existing !== undefined) return existing;
  scan.edges.set(edge.id, edge);
  return edge;
}

export function nextOrder(scan: ClaudeScan, project: string | null): number {
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
  importsResolved: number | null;
  tokensLoaded: number | null;
  disableModelInvocation: boolean | null;
  countsTowardHeadline: boolean;
  evidence: Evidence[];
  confidence?: Confidence;
}

export function loadedBy(scan: ClaudeScan, input: LoadedByInput): LoadedByEdge {
  const id = edgeId("loaded-by", input.from, HARNESS_ID);
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

export function evidence(kind: string, detail?: string, locator?: Locator): Evidence {
  const out: Evidence = { kind };
  if (detail !== undefined) out.detail = detail;
  if (locator !== undefined) out.locator = locator;
  return out;
}

/** The Project a session started at `cwd` belongs to, when the cwd lies inside one of its members. */
export function sessionDirOf(
  scan: ClaudeScan,
  project: DiscoveredProject,
): { dir: string; member: string } {
  const fold = scan.ctx.identity.fold;
  const cwd = scan.ctx.options.cwd;
  for (const member of project.members) {
    if (member.reachability === "present" && isUnder(fold(cwd), fold(member.path))) {
      return { dir: cwd, member: member.path };
    }
  }
  return { dir: project.path, member: project.path };
}
