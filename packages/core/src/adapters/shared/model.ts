/**
 * The shared-stores adapter's working state and the builders its entities share. Everything it
 * emits carries `harness: null` — a canonical store, a lock or an `AGENTS.md` belongs to no single
 * harness, which is exactly what makes it this adapter's (CONTEXT.md Adapter; 07 point 4).
 */
import { relative, sep } from "node:path";
import type {
  Edge,
  Entity,
  EntityBase,
  Evidence,
  Format,
  GitStatus,
  Locator,
  Metrics,
  Scope,
  Skill,
} from "../../index/types.js";
import type { ScanContext } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isUnder, tildify } from "../../scan/paths.js";
import type { SkillLock } from "./locks.js";

export interface StoreDir {
  /** `<X>/.agents/skills`. */
  dir: string;
  scope: "user" | "project";
  project: DiscoveredProject | null;
}

export interface SharedScan {
  ctx: ScanContext;
  home: string;
  /** The locks read in `discover`, global first (D75: the `XDG_STATE_HOME` one wins by name). */
  locks: SkillLock[];
  /** Every canonical store this scan reaches, user scope first. */
  stores: StoreDir[];
  entities: Map<string, Entity>;
  edges: Map<string, Edge>;
  /** Store skills by folded real path, so a link elsewhere can add its Placement to them. */
  skills: Map<string, Skill>;
}

/** Path relative to the Project (forward slashes); `null` when the path is outside its members. */
export function relativeTo(
  project: DiscoveredProject | null,
  path: string,
  fold: (value: string) => string,
): string | null {
  if (project === null) return null;
  if (!project.members.some((member) => isUnder(fold(path), fold(member.path)))) return null;
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
}

export function baseEntity(scan: SharedScan, input: BaseInput): EntityBase {
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
    id: ctx.id(input.kind, input.path),
    kind: input.kind,
    // 07 point 4: a store several harnesses share belongs to none of them.
    harness: null,
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
    label: input.label ?? relativePath ?? tildify(input.path, scan.home),
    sensitive: input.sensitive,
    protection: input.protection,
    removal: input.removal,
    metrics: input.metrics,
  };
}

/** Adds an entity unless one with the same id exists (the first real thing wins). */
export function addEntity<T extends Entity>(scan: SharedScan, entity: T): T {
  const existing = scan.entities.get(entity.id);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one id ↔ one kind (ADR-0007)
  if (existing !== undefined) return existing as T;
  scan.entities.set(entity.id, entity);
  return entity;
}

export function addEdge(scan: SharedScan, edge: Edge): Edge {
  const existing = scan.edges.get(edge.id);
  if (existing !== undefined) return existing;
  scan.edges.set(edge.id, edge);
  return edge;
}

export function evidence(kind: string, detail?: string, locator?: Locator): Evidence {
  const out: Evidence = { kind };
  if (detail !== undefined) out.detail = detail;
  if (locator !== undefined) out.locator = locator;
  return out;
}
