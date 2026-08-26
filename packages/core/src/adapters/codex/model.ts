/**
 * The Codex adapter's working state and the builders every entity and edge share: ids, relative
 * paths, git status, `loaded-by` edges with their chain order. Same shape and same semantics as
 * the Claude Code slice's `model.ts` — the two differ only in the harness they stamp on what they
 * build, so a future `adapters/model.ts` can absorb both without changing a single output.
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
import type { AggregatedSessionCwd, DiscoveredProject, Located } from "../../scan/discovery.js";
import { edgeId, isUnder, tildify } from "../../scan/paths.js";
import type { ProjectFacts } from "../adapter.js";
import type { CodexPaths } from "./paths.js";
import type { ThreadRow } from "./threads.js";
import type { TomlFile } from "./toml.js";

export const HARNESS_ID = "harness:codex";
export const HARNESS = "codex";

/** One `[projects."<path>"]` table of a `config.toml` layer (ticket 06 rule 1: trust is evidence). */
export interface TrustEntry {
  /** The table key exactly as written — always an absolute path, so `recordedForm: "path"`. */
  key: string;
  trustLevel: string | null;
  trusted: boolean | null;
  file: string;
  located: Located;
}

/** A `.codex/config.toml` layer of one Project, root→session directory (closest last). */
export interface ProjectLayer {
  dir: string;
  file: TomlFile;
  /** Distance from the project root: 0 = the root itself, higher = closer to the session dir. */
  depth: number;
}

export interface CodexScan {
  ctx: ScanContext;
  paths: CodexPaths;
  /** The user `config.toml`, read once in `discover`. */
  config: TomlFile;
  /** `$CODEX_HOME/<profile>.config.toml` when `profile` selects one. */
  profile: TomlFile | null;
  /** Every `<name>.config.toml` beside the user config, selected or not (§1.7 lists them all). */
  profileFiles: TomlFile[];
  /** System layers < user < profile, **unredacted**: paths and numbers the adapter itself needs. */
  raw: Record<string, unknown>;
  /** The same layers with D64's rule applied — this is what reaches `Harness.effectiveSettings`. */
  settings: Record<string, unknown>;
  trust: TrustEntry[];
  /** `threads` rows of `state_5.sqlite`; empty when the database could not be read. */
  threads: ThreadRow[];
  threadsFile: string;
  threadsReadable: boolean;
  /** D30: one entry per distinct `cwd`, already aggregated and located. */
  cwds: { crumb: AggregatedSessionCwd<ThreadRow>; located: Located }[];
  /** `project_roots.path` rows (0 on every machine observed); emitted as `project-row` (§1.3). */
  projectRoots: { path: string; located: Located }[];
  version: string | null;
  /** Per Project id, the `.codex/config.toml` layers a session there would load. */
  projectLayers: Map<string, ProjectLayer[]>;
  /** Every `<dir>/.codex` directory the project walk saw: a project-scope trace of Codex (D147). */
  projectDirs: string[];
  /** Folded rollout path → the `harness-cache` id of its unit, for a breadcrumb's `state` (§1.3). */
  rolloutUnits: Map<string, string>;
  /** Bytes the user instruction file already spends against `project_doc_max_bytes` (D58). */
  userDocBytes: number;
  entities: Map<string, Entity>;
  edges: Map<string, Edge>;
  breadcrumbs: Breadcrumb[];
  projectFacts: Map<string, ProjectFacts>;
  orders: Map<string, number>;
}

export function projectsOf(scan: CodexScan): DiscoveredProject[] {
  return scan.ctx.discovery.projects();
}

/** Path relative to the Project (forward slashes); `null` when `path` is not inside a member. */
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
  /** `null` for a store several harnesses share (`~/.agents/skills/<name>`, ticket 07 Q1). */
  harness?: EntityBase["harness"];
  producer?: EntityBase["producer"];
}

export function baseEntity(scan: CodexScan, input: BaseInput): EntityBase {
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
export function addEntity<T extends Entity>(scan: CodexScan, entity: T): T {
  const existing = scan.entities.get(entity.id);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one id ↔ one kind (ADR-0007)
  if (existing !== undefined) return existing as T;
  scan.entities.set(entity.id, entity);
  return entity;
}

export function addEdge(scan: CodexScan, edge: Edge): Edge {
  const existing = scan.edges.get(edge.id);
  if (existing !== undefined) return existing;
  scan.edges.set(edge.id, edge);
  return edge;
}

export function nextOrder(scan: CodexScan, project: string | null): number {
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

/**
 * One `loaded-by` edge per (entity, harness, **Project**) — D136 amends ticket 07's id rule so a
 * store or an `AGENTS.md` several Projects read can hold one verdict per Project.
 */
export function loadedByEdgeId(from: string, project: string | null): string {
  const base = edgeId("loaded-by", from, HARNESS_ID);
  return project === null ? base : `${base}:${project}`;
}

export function loadedBy(scan: CodexScan, input: LoadedByInput): LoadedByEdge {
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

export function evidence(kind: string, detail?: string, locator?: Locator): Evidence {
  const out: Evidence = { kind };
  if (detail !== undefined) out.detail = detail;
  if (locator !== undefined) out.locator = locator;
  return out;
}

/** The directory a session runs in: `cwd` when it lies inside a present member, else the Project. */
export function sessionDirOf(
  scan: CodexScan,
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

/** Trust of a Project (D57: a container entry such as `~` or `/` never propagates downwards). */
export function trustOf(scan: CodexScan, project: DiscoveredProject): boolean | null {
  const same = scan.ctx.identity.same;
  const paths = [project.path, ...project.members.map((member) => member.path)];
  for (const entry of scan.trust) {
    if (entry.located.relativePath !== null && entry.located.relativePath !== "") continue;
    if (paths.some((path) => same(path, entry.key))) return entry.trusted;
  }
  return null;
}
