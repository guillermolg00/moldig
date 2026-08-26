/**
 * The two facts about a Skill no single adapter can know: which other Skill is a copy of it, and
 * whether the copies differ. Both need every adapter's skills at once, so this pass runs over the
 * **merged** index (ticket 06 §13: "emitted by the shared adapter over every skill entity of the
 * merged index — the only adapter that sees them all"); nothing here touches the disk.
 *
 * `duplicates` edges pair distinct real directories by content, then origin, then name, with D79's
 * confidences (`certain` / `high` / `medium`), one edge per pair, ordered by id. Drift then follows
 * D80: a `local-modified` verdict from a lock hash outranks `copies-differ`, which is what two
 * copies of one origin holding different bytes are.
 */
import type { DuplicatesEdge, Entity, Evidence, Skill } from "../../index/types.js";
import { edgeOrder, type MergedOutputs } from "../../scan/assemble.js";
import { edgeId } from "../../scan/paths.js";

type Same = DuplicatesEdge["same"];

function hashesOf(skill: Skill): Map<string, string> {
  return new Map(skill.contentHash.map((item) => [item.algo, item.value]));
}

/** The strongest sameness of two skills, or `null` when they are not copies of one another. */
function samenessOf(a: Skill, b: Skill): { same: Same; evidence: Evidence } | null {
  const left = hashesOf(a);
  const right = hashesOf(b);
  for (const algo of ["sha256-folder", "git-tree-sha1"] as const) {
    const value = left.get(algo);
    if (value !== undefined && value === right.get(algo)) {
      return {
        same: "content",
        evidence: { kind: "content-hash", detail: `${algo} ${value.slice(0, 12)}` },
      };
    }
  }
  if (a.name !== b.name) return null;
  // §13's origin triple, narrowed by the lock key the entry lives under: `source` + `skillPath`
  // alone pair every skill installed from one multi-skill repository (`skillPath: null`, or a
  // lock whose values are placeholders), which is not evidence that two directories are copies.
  if (
    a.origin !== null &&
    b.origin !== null &&
    a.origin.sourceType === b.origin.sourceType &&
    a.origin.source === b.origin.source &&
    a.origin.skillPath === b.origin.skillPath
  ) {
    return {
      same: "origin",
      evidence: { kind: "lock-entry", detail: `${a.origin.sourceType} ${a.origin.source}` },
    };
  }
  return { same: "name", evidence: { kind: "name-only", detail: a.name } };
}

/** D79: `certain` for equal content, `high` for one origin, `medium` for one name. */
function confidenceOf(same: Same): DuplicatesEdge["confidence"] {
  return same === "content" ? "certain" : same === "origin" ? "high" : "medium";
}

function folderHash(skill: Skill): string | null {
  return skill.contentHash.find((item) => item.algo === "sha256-folder")?.value ?? null;
}

/**
 * D38's merge leaves one Skill per real directory; this adds what only the whole set shows.
 * Returns a new `{entities, edges}` — the input is never mutated.
 */
export function withSharedSkillFacts(merged: MergedOutputs): MergedOutputs {
  const skills = merged.entities
    .filter((entity): entity is Skill => entity.kind === "skill" && entity.form === "skill-dir")
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const duplicates: DuplicatesEdge[] = [];
  /** Skill id → the ids it is a copy of, with the sameness that paired them. */
  const copies = new Map<string, { id: string; same: Same }[]>();
  for (let i = 0; i < skills.length; i += 1) {
    for (let j = i + 1; j < skills.length; j += 1) {
      const from = skills[i];
      const to = skills[j];
      if (from === undefined || to === undefined) continue;
      const sameness = samenessOf(from, to);
      if (sameness === null) continue;
      duplicates.push({
        id: edgeId("duplicates", from.id, to.id),
        kind: "duplicates",
        from: from.id,
        to: to.id,
        confidence: confidenceOf(sameness.same),
        evidence: [sameness.evidence],
        same: sameness.same,
      });
      copies.set(from.id, [...(copies.get(from.id) ?? []), { id: to.id, same: sameness.same }]);
      copies.set(to.id, [...(copies.get(to.id) ?? []), { id: from.id, same: sameness.same }]);
    }
  }
  const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const entities: Entity[] = merged.entities.map((entity) => {
    if (entity.kind !== "skill" || entity.form !== "skill-dir") return entity;
    // D80: a lock hash that already disagrees outranks the copies verdict.
    if (entity.drift === "local-modified") return entity;
    const mine = folderHash(entity);
    if (mine === null) return entity;
    const differs = (copies.get(entity.id) ?? []).some((copy) => {
      if (copy.same === "content") return false;
      const other = byId.get(copy.id);
      const theirs = other === undefined ? null : folderHash(other);
      return theirs !== null && theirs !== mine && other?.drift !== "local-modified";
    });
    return differs ? { ...entity, drift: "copies-differ" } : entity;
  });
  return { entities, edges: [...merged.edges, ...duplicates].toSorted(edgeOrder) };
}
