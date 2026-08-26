/**
 * The Gemini CLI adapter's working state: what `discover` resolved, what `collect` emits, and
 * the builders every entity and edge share (ids, relative paths, git status, `loaded-by` edges
 * with their chain order). Same shape as the Claude Code slice — one adapter per harness, both
 * read-only (ADR-0001, ADR-0002).
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
  McpServer,
  Metrics,
  Plugin,
  Scope,
  Skill,
} from "../../index/types.js";
import type { ScanContext } from "../../scan/context.js";
import type { DiscoveredProject, Located } from "../../scan/discovery.js";
import { edgeId, isUnder, tildify } from "../../scan/paths.js";
import type { ProjectFacts } from "../adapter.js";
import { HARNESS, HARNESS_ID, type GeminiPaths } from "./paths.js";
import type { Layer, Retention } from "./settings.js";

export { HARNESS, HARNESS_ID };

/** One `projects.json` key with the Project it folded into. */
export interface ProjectsEntry {
  key: string;
  slug: string | null;
  located: Located | null;
}

/** One `trustedFolders.json` key with its verdict. */
export interface TrustEntry {
  key: string;
  value: string;
  trusted: boolean | null;
  located: Located | null;
}

/** A `tmp/<slug>` or `history/<slug>` directory and how it resolved (§3). */
export interface SlugDir {
  dir: string;
  slug: string;
  /** `tmp` directories carry state; `history` ones are the shadow git. */
  store: "tmp" | "history";
  located: Located | null;
  resolution: Breadcrumb["resolution"];
}

export interface ExtensionInfo {
  /** Realpath of the extension directory. */
  dir: string;
  name: string;
  entity: Plugin;
  manifest: Record<string, unknown>;
  enabled: boolean | null;
  reason: string;
}

export interface GeminiScan {
  ctx: ScanContext;
  paths: GeminiPaths;
  /** System defaults, the user file and the system settings file, least specific first. */
  systemDefaults: Layer;
  userSettings: Layer;
  systemSettings: Layer;
  /** `system-defaults + user + system settings`, normalised (secrets redacted on the harness row). */
  harnessSettings: Record<string, unknown>;
  /** Per Project id: its merged layers (the project layer dropped when the folder is untrusted). */
  projectSettings: Map<string, Record<string, unknown>>;
  retention: Retention;
  projectsFile: { path: string; present: boolean; entries: ProjectsEntry[] };
  trustFile: { path: string; present: boolean; entries: TrustEntry[] };
  slugs: SlugDir[];
  /** Extensions of `~/.gemini/extensions`, filled by `collectPlugins` before its payload runs. */
  extensions: ExtensionInfo[];
  /** Every MCP entry emitted, for the shadow and duplicate passes. */
  mcp: McpServer[];
  /** Every skill entity emitted, keyed by tier rank, for the precedence pass. */
  skills: { entity: Skill; rank: number; tier: string; dir: string; project: string | null }[];
  entities: Map<string, Entity>;
  edges: Map<string, Edge>;
  breadcrumbs: Breadcrumb[];
  projectFacts: Map<string, ProjectFacts>;
  orders: Map<string, number>;
}

export function projectsOf(scan: GeminiScan): DiscoveredProject[] {
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
  producer?: EntityBase["producer"];
  /** `null` for a store several harnesses share (`~/.agents/skills/<name>`). */
  harness?: EntityBase["harness"];
}

export function baseEntity(scan: GeminiScan, input: BaseInput): EntityBase {
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
export function addEntity<T extends Entity>(scan: GeminiScan, entity: T): T {
  const existing = scan.entities.get(entity.id);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- one id ↔ one kind (ADR-0007)
  if (existing !== undefined) return existing as T;
  scan.entities.set(entity.id, entity);
  return entity;
}

export function addEdge(scan: GeminiScan, edge: Edge): Edge {
  const existing = scan.edges.get(edge.id);
  if (existing !== undefined) return existing;
  scan.edges.set(edge.id, edge);
  return edge;
}

export function nextOrder(scan: GeminiScan, project: string | null): number {
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
  ordered: boolean;
  charsLoaded: number | null;
  importsResolved: number | null;
  tokensLoaded: number | null;
  disableModelInvocation: boolean | null;
  countsTowardHeadline: boolean;
  evidence: Evidence[];
  confidence?: Confidence;
}

/** D136: one `loaded-by` edge per (entity, harness, **Project**). */
export function loadedByEdgeId(from: string, project: string | null): string {
  const base = edgeId("loaded-by", from, HARNESS_ID);
  return project === null ? base : `${base}:${project}`;
}

export function loadedBy(scan: GeminiScan, input: LoadedByInput): LoadedByEdge {
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

/** Every item an extension ships carries this edge; nothing under it is removable on its own. */
export function providedBy(scan: GeminiScan, from: string, plugin: Plugin): void {
  addEdge(scan, {
    id: edgeId("provided-by", from, plugin.id),
    kind: "provided-by",
    from,
    to: plugin.id,
    confidence: "certain",
    // D134: Gemini's units are plugins in every prose string.
    evidence: [evidence("manifest", `shipped by plugin ${plugin.pluginId}`)],
  });
}

/** The directory a session started at `cwd` runs in, when the cwd lies inside a present member. */
export function sessionDirOf(
  scan: GeminiScan,
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

/** The trust verdict of a Project: `false` only for a `DO_NOT_TRUST` entry (§3). */
export function trustOf(scan: GeminiScan, project: DiscoveredProject): boolean | null {
  const entry = scan.trustFile.entries.find(
    (item) => item.located?.project?.id === project.id && item.located.relativePath === null,
  );
  return entry?.trusted ?? null;
}

/** The merged settings a session in this Project sees (the harness layers when it has none). */
export function settingsFor(
  scan: GeminiScan,
  project: DiscoveredProject | null,
): Record<string, unknown> {
  if (project === null) return scan.harnessSettings;
  return scan.projectSettings.get(project.id) ?? scan.harnessSettings;
}
