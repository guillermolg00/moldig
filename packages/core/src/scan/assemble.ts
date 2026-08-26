/**
 * What `scan` does with what the adapters returned: the deterministic order of the index
 * (ticket 07 §1.1), the cross-adapter entity merge (D38) and the `parent` link between nested
 * Projects (D25). Nothing here reads the disk — it is arithmetic over the adapters' output, so
 * two scans of one unchanged machine serialise identically.
 */
import type { AdapterOutput } from "../adapters/adapter.js";
import type { Edge, Entity, Placement, Skill } from "../index/types.js";
import type { DiscoveredProject } from "./discovery.js";
import { isUnder } from "./paths.js";

export function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Ticket 07 §1.1: edges sort by (kind, from, to, id); a null `to` sorts as `""`. */
export function edgeOrder(a: Edge, b: Edge): number {
  return (
    a.kind.localeCompare(b.kind) ||
    (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
    ((a.to ?? "") < (b.to ?? "") ? -1 : (a.to ?? "") > (b.to ?? "") ? 1 : 0) ||
    byId(a, b)
  );
}

/** One entity as an adapter emitted it, with the directories that adapter's harness owns. */
interface Emitted {
  entity: Entity;
  ownPaths: readonly string[];
}

/**
 * D38: which adapter's copy of a shared entity is the real one. The store several harnesses
 * share wins over any harness's view of it (`harness: null` — `~/.agents/**`, `AGENTS.md`, the
 * lock files); otherwise the adapter whose own directories hold the path owns it; otherwise the
 * first adapter to emit it, which is registration order and therefore stable.
 */
function ownerOf(
  first: Emitted,
  group: readonly Emitted[],
  fold: (path: string) => string,
): Emitted {
  const shared = group.find((item) => item.entity.harness === null);
  if (shared !== undefined) return shared;
  const owns = group.find((item) =>
    item.ownPaths.some((dir) => isUnder(fold(item.entity.path), fold(dir))),
  );
  return owns ?? first;
}

function placementKey(placement: Placement, fold: (path: string) => string): string {
  return [
    fold(placement.path),
    placement.harness ?? "",
    placement.surface ?? "",
    placement.scope,
  ].join(" ");
}

function mergeEntities(emitted: readonly Emitted[], fold: (path: string) => string): Entity[] {
  const groups = new Map<string, Emitted[]>();
  for (const item of emitted) {
    const group = groups.get(item.entity.id);
    if (group === undefined) groups.set(item.entity.id, [item]);
    else group.push(item);
  }
  const merged: Entity[] = [];
  for (const group of groups.values()) {
    const [first] = group;
    if (first === undefined) continue;
    const owner = ownerOf(first, group, fold);
    if (group.length === 1 || owner.entity.kind !== "skill") {
      merged.push(owner.entity);
      continue;
    }
    // A Skill reached through six harnesses is one row with six placements (ticket 07 Q1).
    const placements = new Map<string, Placement>();
    for (const item of group) {
      if (item.entity.kind !== "skill") continue;
      for (const placement of item.entity.placements) {
        const key = placementKey(placement, fold);
        if (!placements.has(key)) placements.set(key, placement);
      }
    }
    const skill: Skill = {
      ...owner.entity,
      placements: [...placements.entries()]
        .toSorted((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([, placement]) => placement),
    };
    merged.push(skill);
  }
  return merged.toSorted(byId);
}

export interface MergedOutputs {
  entities: Entity[];
  edges: Edge[];
}

/**
 * D38: entities that share an id are one entity — `placements[]` and edges unioned, scalars from
 * the owning adapter. This is how one Skill, or one `AGENTS.md`, stays one entity across the
 * adapters that all reach it.
 */
export function mergeOutputs(
  outputs: readonly AdapterOutput[],
  fold: (path: string) => string,
): MergedOutputs {
  const emitted: Emitted[] = outputs.flatMap((output) => {
    const ownPaths =
      output.harness === null ? [] : output.harness.userScope.paths.map((item) => item.path);
    return output.entities.map((entity) => ({ entity, ownPaths }));
  });
  // Two adapters may justify one fact; the edge is written once.
  const edges = new Map<string, Edge>();
  for (const output of outputs) {
    for (const edge of output.edges) if (!edges.has(edge.id)) edges.set(edge.id, edge);
  }
  return {
    entities: mergeEntities(emitted, fold),
    edges: [...edges.values()].toSorted(edgeOrder),
  };
}

/**
 * D25: the nearest enclosing registered Project of a nested repository (`monorepo/vendor/lib` →
 * `monorepo`). Members count, so a repository inside a linked worktree names the worktree's
 * Project; a Project is never its own parent.
 */
export function parentIdOf(
  project: DiscoveredProject,
  all: readonly DiscoveredProject[],
  fold: (path: string) => string,
): string | null {
  const folded = fold(project.path);
  let best: { id: string; length: number } | null = null;
  for (const candidate of all) {
    if (candidate.key === project.key) continue;
    for (const member of candidate.members) {
      const memberFolded = fold(member.path);
      if (memberFolded === folded || !isUnder(folded, memberFolded)) continue;
      if (best === null || memberFolded.length > best.length) {
        best = { id: candidate.id, length: memberFolded.length };
      }
    }
  }
  return best?.id ?? null;
}
