/**
 * The ego-graph builder (ticket 13). Pure: no terminal, no React — the screen paints what this
 * returns. Breadth-first over the five legend edge kinds, one node per id (first reach wins),
 * capped neighbourhood, the other five kinds hidden but counted.
 *
 * The order is deterministic at every hop — legend kind, outgoing before incoming, label, edge
 * id, compared as code units — so the same index always draws the same picture.
 */
import type {
  AuditIndex,
  Confidence,
  Edge,
  Entity,
  EntityKind,
  HarnessId,
  LoadedByEdge,
  Scope,
} from "@moldig/core";

/** The five edge kinds of the legend (ticket 13); the other five are hidden and counted. */
export const LEGEND_KINDS = [
  "names",
  "names-tool",
  "loaded-by",
  "duplicates",
  "originates-from",
] as const;
export type LegendKind = (typeof LEGEND_KINDS)[number];
export type LegendEdge = Extract<Edge, { kind: LegendKind }>;

export const MAX_HOPS = 2;
export const NEIGHBOURHOOD_CAP = 60;

export type EgoNodeKind = EntityKind | "harness" | "project" | "unresolved" | "unknown";
/** Relative to the node the neighbour was reached from (`via`). */
export type Direction = "incoming" | "outgoing";
export type LoadMode = LoadedByEdge["mode"];

export interface EgoNode {
  id: string;
  kind: EgoNodeKind;
  label: string;
  scope: Scope | null;
  harness: HarnessId | null;
  shared: boolean;
  /** A skill with a placement that points at nothing, or a named tool configured nowhere. */
  dangling: boolean;
  live: boolean;
}

export interface EgoNeighbour {
  node: EgoNode;
  edge: LegendEdge;
  kind: LegendKind;
  direction: Direction;
  hop: number;
  /** Node id this neighbour was reached from — the focus at hop 1. */
  via: string;
  confidence: Confidence;
  /** `loaded-by` only: the reader's verdict. */
  mode: LoadMode | null;
}

export interface EgoGraph {
  focus: EgoNode;
  hops: number;
  /** BFS order: hop 1 first (legend order, outgoing before incoming, then label), then hop 2. */
  neighbours: EgoNeighbour[];
  /** Reachable nodes beyond `NEIGHBOURHOOD_CAP` ("…and N more"). */
  omitted: number;
  /** Edges of the other kinds touching the focus or a shown neighbour ("+N other edges"). */
  hiddenEdges: number;
}

const LEGEND_ORDER: ReadonlyMap<string, number> = new Map(LEGEND_KINDS.map((k, i) => [k, i]));

export function isLegendEdge(edge: Edge): edge is LegendEdge {
  return LEGEND_ORDER.has(edge.kind);
}

const UNRESOLVED_PREFIX = "unresolved:";

function unknownNode(id: string): EgoNode {
  return {
    id,
    kind: "unknown",
    label: id,
    scope: null,
    harness: null,
    shared: false,
    dangling: false,
    live: false,
  };
}

/** The far end of a `names-tool` edge whose server is configured nowhere. */
function unresolvedNode(edge: LegendEdge): EgoNode {
  return {
    id: `${UNRESOLVED_PREFIX}${edge.id}`,
    kind: "unresolved",
    label: edge.kind === "names-tool" ? edge.tool : "?",
    scope: null,
    harness: null,
    shared: false,
    dangling: true,
    live: false,
  };
}

function nodeFromEntity(entity: Entity): EgoNode {
  return {
    id: entity.id,
    kind: entity.kind,
    label: entity.label,
    scope: entity.scope,
    harness: entity.harness,
    shared: entity.shared === true,
    dangling: entity.kind === "skill" && entity.placements.some((p) => p.dangling),
    live:
      entity.protection === "live" ||
      (entity.kind === "harness-cache" && entity.liveGuard?.alive === true),
  };
}

function makeResolver(index: AuditIndex): (id: string) => EgoNode {
  const entities = new Map(index.entities.map((e) => [e.id, e]));
  const harnesses = new Map(index.harnesses.map((h) => [h.id, h]));
  const projects = new Map(index.projects.map((p) => [p.id, p]));
  const cache = new Map<string, EgoNode>();
  return (id) => {
    const hit = cache.get(id);
    if (hit) return hit;
    let node: EgoNode;
    const entity = entities.get(id);
    const harness = harnesses.get(id);
    const project = projects.get(id);
    if (entity) {
      node = nodeFromEntity(entity);
    } else if (harness) {
      node = {
        id,
        kind: "harness",
        label: harness.displayName,
        scope: null,
        harness: harness.harness,
        shared: false,
        dangling: false,
        live: false,
      };
    } else if (project) {
      node = {
        id,
        kind: "project",
        label:
          project.reachability === "orphan" ? `${project.displayName} (gone)` : project.displayName,
        scope: null,
        harness: null,
        shared: false,
        dangling: false,
        live: false,
      };
    } else {
      node = unknownNode(id);
    }
    cache.set(id, node);
    return node;
  };
}

interface End {
  edge: LegendEdge;
  node: EgoNode;
  direction: Direction;
}

/** Code-unit order: deterministic on every platform (localeCompare is not). */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function clampHops(hops: number): number {
  if (!Number.isFinite(hops)) return 1;
  return Math.min(MAX_HOPS, Math.max(1, Math.trunc(hops)));
}

/**
 * The ego-graph of `focusId` — an entity id, a harness id or a project id — over the
 * legend edge kinds, `hops` deep (1..MAX_HOPS).
 *
 * A project is never an end of a legend edge, so for a project focus the hop-1
 * neighbours are the `loaded-by` verdicts that hold for that project
 * (`edge.project === focusId`): the loaded entity, incoming. Deeper hops follow
 * the ordinary from/to ends.
 */
export function buildEgoGraph(index: AuditIndex, focusId: string, hops: number): EgoGraph {
  const depth = clampHops(hops);
  const resolve = makeResolver(index);
  const focus = resolve(focusId);

  const incident = new Map<string, LegendEdge[]>();
  const projectVerdicts: LoadedByEdge[] = [];
  const others: Edge[] = [];
  const touch = (id: string, edge: LegendEdge): void => {
    const list = incident.get(id);
    if (list) list.push(edge);
    else incident.set(id, [edge]);
  };
  for (const edge of index.edges) {
    if (!isLegendEdge(edge)) {
      others.push(edge);
      continue;
    }
    touch(edge.from, edge);
    if (edge.to !== null) touch(edge.to, edge);
    if (focus.kind === "project" && edge.kind === "loaded-by" && edge.project === focusId) {
      projectVerdicts.push(edge);
    }
  }

  const endsOf = (viaId: string): End[] => {
    const ends: End[] = [];
    for (const edge of incident.get(viaId) ?? []) {
      if (edge.from === viaId && edge.to === viaId) continue; // self-loop
      if (edge.from === viaId) {
        ends.push({
          edge,
          node: edge.to === null ? unresolvedNode(edge) : resolve(edge.to),
          direction: "outgoing",
        });
      } else {
        ends.push({ edge, node: resolve(edge.from), direction: "incoming" });
      }
    }
    if (viaId === focus.id) {
      for (const edge of projectVerdicts) {
        ends.push({ edge, node: resolve(edge.from), direction: "incoming" });
      }
    }
    ends.sort(
      (a, b) =>
        (LEGEND_ORDER.get(a.edge.kind) ?? 0) - (LEGEND_ORDER.get(b.edge.kind) ?? 0) ||
        (a.direction === "outgoing" ? 0 : 1) - (b.direction === "outgoing" ? 0 : 1) ||
        compare(a.node.label, b.node.label) ||
        compare(a.edge.id, b.edge.id),
    );
    return ends;
  };

  const visited = new Set<string>([focus.id]);
  const all: EgoNeighbour[] = [];
  let frontier: string[] = [focus.id];
  for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
    const next: string[] = [];
    for (const viaId of frontier) {
      for (const { edge, node, direction } of endsOf(viaId)) {
        if (visited.has(node.id)) continue;
        visited.add(node.id);
        all.push({
          node,
          edge,
          kind: edge.kind,
          direction,
          hop,
          via: viaId,
          confidence: edge.confidence,
          mode: edge.kind === "loaded-by" ? edge.mode : null,
        });
        if (node.kind !== "unresolved") next.push(node.id);
      }
    }
    frontier = next;
  }

  const neighbours = all.slice(0, NEIGHBOURHOOD_CAP);
  const shown = new Set<string>([focus.id, ...neighbours.map((n) => n.node.id)]);
  const hiddenEdges = others.filter(
    (e) => shown.has(e.from) || (e.to !== null && shown.has(e.to)),
  ).length;

  return { focus, hops: depth, neighbours, omitted: all.length - neighbours.length, hiddenEdges };
}
