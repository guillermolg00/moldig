/**
 * The predicates of ticket 08 and the selection they build. Every one of them reads index v0
 * fields and nothing else; `plan()` evaluates them again, so a row a screen let through by
 * mistake becomes `refused` with its reason instead of being acted on (08 §2).
 */
import type { AuditIndex, Entity, HarnessCache, Index, Skill } from "../index/types.js";
import { isPreselected } from "../audit/audit.js";
import type { Selection, SelectionTarget } from "./types.js";

/**
 * CONTEXT.md Live: an item a harness is using right now. Shown, never selectable for any
 * action. `liveGuard: null` is selectable and never preselected (D105).
 */
export function isLive(entity: Entity): boolean {
  if (entity.protection === "live") return true;
  return entity.kind === "harness-cache" && entity.liveGuard?.alive === true;
}

/** `protection: "undocumented"` — moldig cannot say what the item is: size only, no action. */
export function isSizeOnly(entity: Entity): boolean {
  return entity.protection === "undocumented";
}

/**
 * D142: a settings file is never removable — its Entries are. The Claude Code slice on `main`
 * still emits a project `.mcp.json` as `protection: "none"` with a trash removal; the engine
 * refuses it here rather than trusting that row.
 */
export function isProtected(entity: Entity): boolean {
  return entity.kind === "settings-file" || entity.protection === "never";
}

/** Clean's universe: `ownership: "harness"` ∧ `protection: "none"` (08 Answer preamble). */
export function inCleanUniverse(entity: Entity): boolean {
  return (
    entity.ownership === "harness" &&
    entity.protection === "none" &&
    entity.kind !== "settings-file"
  );
}

/**
 * Tickable in the Clean panel: in the universe, removable, not Live, and either a harness
 * cache unit the harness sweeps or leaves undocumented, or a memory file — memory files are
 * tickable by kind and never ticked by default (08 Answer preamble; a `rule: "kept"` unit is
 * reachable through Delete only, D111). The volume is re-checked by `plan()`.
 */
export function isTickable(entity: Entity): boolean {
  if (!inCleanUniverse(entity)) return false;
  if (entity.removal.method === "none" || isLive(entity)) return false;
  if (entity.kind === "memory-file") return true;
  return (
    entity.kind === "harness-cache" && (entity.rule === "swept" || entity.rule === "undocumented")
  );
}

/**
 * Delete reaches human-owned kinds and `rule: "kept"` units alike; settings files never
 * (14 §1, D142). The volume is re-checked by `plan()`.
 */
export function canDelete(entity: Entity): boolean {
  if (isProtected(entity) || isSizeOnly(entity)) return false;
  return entity.protection === "none" && entity.removal.method !== "none" && !isLive(entity);
}

/** An Installer is recognised, so the row can be delegated an Update (14 §2, §6.1). */
export function canUpdate(entity: Entity): boolean {
  if (entity.kind !== "skill" && entity.kind !== "plugin") return false;
  if (entity.origin === null) return false;
  const installer: string = entity.origin.installer;
  return (
    installer === "vercel-skills" ||
    installer === "claude-plugin" ||
    installer === "gemini-extension" ||
    installer === "git-clone"
  );
}

/** Every entity a Clean panel would show a checkbox for. */
export function tickableUnits(index: Index): Entity[] {
  return index.entities.filter((entity) => isTickable(entity));
}

/** Ticket 08's preselect rule, re-exported so consumers need one import. */
export function isPreselectedUnit(entity: Entity): entity is HarnessCache {
  return entity.kind === "harness-cache" && isPreselected(entity);
}

export interface SelectionOptions {
  /** Default `true`: the units the audit preselected — never memory, never human-owned (D16). */
  preselected?: boolean;
  /** Narrows to these harnesses; never widens (D16). */
  harnesses?: readonly string[];
  /** Narrows to units older than this many days; never widens (D16). */
  olderThanDays?: number;
  /** Narrows to these cacheKinds' Findings categories; v1 accepts `harness-cache` only (D16). */
  categories?: readonly string[];
}

/**
 * The selection a non-interactive `clean` starts from, and the initial marks of the panel:
 * every preselected `harness-cache` unit, narrowed by the filters, in index order. The
 * Findings carry the same marks (`targets[].preselect`, 07 point 15) — this reads the units
 * so the two can never drift.
 */
export function selectionFrom(index: AuditIndex, options: SelectionOptions = {}): Selection {
  if (options.preselected === false) return [];
  const findingOf = new Map<string, string>();
  for (const finding of index.findings) {
    if (finding.action.kind !== "clean") continue;
    for (const target of finding.targets) {
      if (target.id !== undefined && target.preselect === true)
        findingOf.set(target.id, finding.id);
    }
  }
  const categories = options.categories ?? [];
  const harnesses = options.harnesses ?? [];
  const out: SelectionTarget[] = [];
  for (const entity of index.entities) {
    if (!isPreselectedUnit(entity) || !isTickable(entity)) continue;
    if (harnesses.length > 0 && (entity.harness === null || !harnesses.includes(entity.harness))) {
      continue;
    }
    if (categories.length > 0 && !categories.includes("harness-cache")) continue;
    if (options.olderThanDays !== undefined) {
      const age = entity.metrics.ageDays;
      if (age === null || age <= options.olderThanDays) continue;
    }
    const finding = findingOf.get(entity.id);
    out.push({
      action: "clean",
      id: entity.id,
      ...(finding === undefined ? {} : { finding }),
    });
  }
  return out;
}

/** Every placement of a Skill that is a link into a harness's own directory (14 §1, §4.4). */
export function placementLinks(skill: Skill): string[] {
  return skill.placements
    .filter((placement) => placement.isSymlink && placement.path !== skill.path)
    .map((placement) => placement.path);
}
