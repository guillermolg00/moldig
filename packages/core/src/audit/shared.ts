/**
 * What every detector of §7 needs: the container rule, the derived flags, the label helpers and
 * the copy formats the messages share. Nothing here decides a category.
 */
import type {
  Entity,
  Flag,
  Harness,
  HarnessId,
  Index,
  LoadedByEdge,
  Skill,
} from "../index/types.js";
import { PINNED_FLAGS } from "./order.js";

export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

/** 1024-based, as the harness-cache messages print it (`x.y MB` / `x.y KB` / `n B`). */
export function sizeOf(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

export function displayNameOf(index: Index, projectId: string | null): string {
  if (projectId === null) return "the user scope";
  return index.projects.find((project) => project.id === projectId)?.displayName ?? projectId;
}

export function harnessNameOf(index: Index, harnessId: HarnessId | null): string {
  return (
    index.harnesses.find((harness) => harness.harness === harnessId)?.displayName ?? "the harness"
  );
}

export function harnessOf(index: Index, harnessId: HarnessId | null): Harness | null {
  return index.harnesses.find((harness) => harness.harness === harnessId) ?? null;
}

/** §7.1: the Project the subjects belong to, else the harness id for user-scope and stray items. */
export function containerOf(entity: Entity): string {
  return entity.project ?? `harness:${entity.harness ?? "unknown"}`;
}

/** `<scope> scope[ of <project displayName>]`, the phrase the duplicate and drift messages share. */
export function scopeOf(index: Index, entity: Entity): string {
  return `${entity.scope} scope${entity.project === null ? "" : ` of ${displayNameOf(index, entity.project)}`}`;
}

/**
 * D143: a Skill in a store outside any repository has `shared: null` at the entity level, and only
 * its placements know that one of the paths a harness reaches it through is tracked.
 */
export function isShared(entity: Entity): boolean {
  if (entity.shared === true) return true;
  return (
    entity.kind === "skill" && entity.placements.some((placement) => placement.shared === true)
  );
}

/**
 * §7.1: the six flags are derived from the targets, never typed by hand, and always emitted in
 * the pinned order the display comparator and the report labels use.
 */
export function flagsOf(targets: Entity[], extra: Flag[] = []): Flag[] {
  const held = new Set<Flag>(extra);
  if (targets.some((entity) => isShared(entity))) held.add("shared");
  if (targets.some((entity) => entity.sensitive)) held.add("sensitive");
  if (targets.some((entity) => entity.kind === "memory-file")) held.add("memory");
  const live = targets.some(
    (entity) =>
      entity.protection === "live" ||
      (entity.kind === "harness-cache" && entity.liveGuard?.alive === true),
  );
  if (live) held.add("live");
  if (targets.some((entity) => entity.kind === "harness-cache" && entity.userContent))
    held.add("user-content");
  return PINNED_FLAGS.filter((flag) => held.has(flag));
}

export function loadedByOf(index: Index, entityId: string): LoadedByEdge[] {
  return index.edges.filter(
    (edge): edge is LoadedByEdge => edge.kind === "loaded-by" && edge.from === entityId,
  );
}

/** The hash a lock can be compared against, shortened the way the drift evidence prints it. */
export function shortHash(skill: Skill): string | null {
  const hash =
    skill.contentHash.find((item) => item.algo === "git-tree-sha1") ?? skill.contentHash[0];
  return hash === undefined ? null : hash.value.slice(0, 12);
}

/** Members of the `duplicates` component `entityId` belongs to, itself excluded. */
export function duplicateCopiesOf(index: Index, entityId: string): string[] {
  const out = new Set<string>();
  for (const edge of index.edges) {
    if (edge.kind !== "duplicates") continue;
    if (edge.from === entityId) out.add(edge.to);
    if (edge.to === entityId) out.add(edge.from);
  }
  return [...out].toSorted();
}
