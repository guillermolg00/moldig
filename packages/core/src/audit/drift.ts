/**
 * §7.6 drift [D9; D80; D44]: the distance between an installed copy of a skill and the state its
 * origin recorded. The scan computes `Skill.drift` (only from a lock's 40-hex `git-tree-sha1`,
 * the one hash moldig can reproduce in pure JS); audit files it.
 *
 * `local-modified` outranks `copies-differ` in the single enum, so a skill that is both files
 * **one** drift finding whose message names both conditions — plus its own duplicate finding.
 * `drift: "unknown"` never files anything.
 */
import { basename } from "node:path";
import type { Entity, Finding, Index, Locator, Skill } from "../index/types.js";
import { duplicateCopiesOf, flagsOf, scopeOf, shortHash } from "./shared.js";

/** D80: the three installers whose update command moldig knows how to delegate to. */
const UPDATABLE = new Set(["vercel-skills", "claude-plugin", "gemini-extension"]);

function lockLocator(skill: Skill): Locator | null {
  return skill.origin?.lock ?? null;
}

/** The lock file's basename, whatever shape of locator points into it. */
function lockName(skill: Skill): string {
  const lock = lockLocator(skill);
  if (lock === null) return "its lock";
  if (lock.type === "file" || lock.type === "dir") return basename(lock.path);
  if (lock.type === "paths") return basename(lock.paths[0] ?? "");
  return basename(lock.file);
}

export function driftFindings(index: Index): Finding[] {
  const byId = new Map(index.entities.map((entity) => [entity.id, entity]));
  const out: Finding[] = [];
  for (const entity of index.entities) {
    if (entity.kind !== "skill") continue;
    if (entity.drift !== "local-modified" && entity.drift !== "copies-differ") continue;
    const local = shortHash(entity);
    const copies = duplicateCopiesOf(index, entity.id)
      .map((id) => byId.get(id))
      .filter((copy): copy is Skill => copy?.kind === "skill");
    // A skill is *both* when its lock disagrees with the folder and another copy disagrees too.
    const differing = copies.filter((copy) => shortHash(copy) !== local);
    const both = entity.drift === "local-modified" && differing.length > 0;
    const counterparts = entity.drift === "copies-differ" || both ? differing : [];

    const recorded = entity.origin?.recordedHash?.value.slice(0, 12) ?? null;
    const evidence: Finding["evidence"] = [];
    if (entity.drift === "local-modified" && local !== null && recorded !== null)
      evidence.push({ kind: "content-hash", detail: `git-tree-sha1 ${local} ≠ lock ${recorded}` });
    else if (local !== null)
      evidence.push({
        kind: "content-hash",
        detail: `git-tree-sha1 ${local} ≠ ${differing.map((copy) => shortHash(copy) ?? "?").join(", ") || "the other copy"}`,
      });
    const lock = lockLocator(entity);
    if (lock !== null)
      evidence.push({ kind: "lock-entry", detail: lockName(entity), locator: lock });

    const installer = entity.origin?.installer ?? "unknown";
    const edited = `${entity.name} was edited after ${installer} installed it (${lockName(entity)})`;
    const differs = `${entity.name} at ${scopeOf(index, entity)} differs from the copy at ${
      differing.map((copy) => scopeOf(index, copy)).join(", ") || "another scope"
    }`;
    const targets: Entity[] = [entity, ...counterparts];
    out.push({
      id: `finding:drift:${entity.id}`,
      category: "drift",
      severity: "medium",
      container:
        entity.project ?? `harness:${entity.placements[0]?.harness ?? entity.harness ?? "unknown"}`,
      targets: [
        { id: entity.id, role: "subject" },
        ...counterparts.map((copy) => ({ id: copy.id, role: "counterpart" as const })),
      ],
      message: both
        ? `${edited}, and ${differs}`
        : entity.drift === "local-modified"
          ? edited
          : differs,
      evidence,
      confidence: "certain",
      impact: { bytes: entity.metrics.bytes, tokens: null, files: entity.metrics.files ?? 0 },
      flags: flagsOf(targets),
      action: UPDATABLE.has(installer)
        ? { kind: "update", preselect: false, locator: { type: "dir", path: entity.path } }
        : { kind: "open", preselect: false, locator: entity.locator },
    });
  }
  return out;
}
