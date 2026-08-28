import { selectionFrom, type AuditIndex, type HarnessCache, type Plan } from "@moldig/core";
import { type ActionKind, noRefusal, type Refusal } from "./selection.js";

export type CleanScope =
  | { readonly kind: "project"; readonly project: string }
  | { readonly kind: "global" };

export function defaultCleanScope(index: AuditIndex): CleanScope {
  const project = index.headline.focus.project;
  return index.headline.focus.reason === "cwd" && project !== null
    ? { kind: "project", project }
    : { kind: "global" };
}

/** The narrow set `moldig` can recommend without asking the user to reconstruct the audit. */
export function cleanCandidates(
  index: AuditIndex,
  scope: CleanScope,
  refusal: Refusal = noRefusal,
): HarnessCache[] {
  const selected = new Set(
    selectionFrom(index)
      .map((target) => target.id)
      .filter((id): id is string => id !== undefined),
  );

  return index.entities.filter(
    (entity): entity is HarnessCache =>
      entity.kind === "harness-cache" &&
      (scope.kind === "global" || entity.project === scope.project) &&
      selected.has(entity.id) &&
      entity.removal.method === "trash" &&
      refusal(entity) === null,
  );
}

export function recommendedCleanMarks(
  index: AuditIndex,
  scope: CleanScope,
  refusal: Refusal = noRefusal,
): Map<string, ActionKind> {
  return new Map(cleanCandidates(index, scope, refusal).map((entity) => [entity.id, "clean"]));
}

export interface CleanBucket {
  readonly key: string;
  readonly harness: string;
  readonly harnessName: string;
  readonly cacheKind: string;
  readonly units: readonly HarnessCache[];
  readonly bytes: number;
  readonly selected: number;
  readonly selectedBytes: number;
  readonly retentionDays: number | null;
  readonly projectCount: number;
  readonly includesUserScope: boolean;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function harnessName(index: AuditIndex, harness: string): string {
  return (
    index.harnesses.find((entry) => entry.harness === harness || entry.id === harness)
      ?.displayName ?? harness
  );
}

export function cleanBuckets(
  index: AuditIndex,
  candidates: readonly HarnessCache[],
  marks: ReadonlyMap<string, ActionKind>,
): CleanBucket[] {
  const grouped = new Map<string, HarnessCache[]>();
  for (const entity of candidates) {
    const key = `${entity.harness ?? "shared"}:${entity.cacheKind}`;
    const units = grouped.get(key) ?? [];
    units.push(entity);
    grouped.set(key, units);
  }

  return [...grouped]
    .map(([group, members]) => {
      const units = members.toSorted(
        (a, b) =>
          (b.metrics.ageDays ?? -1) - (a.metrics.ageDays ?? -1) ||
          compare(a.label, b.label) ||
          compare(a.id, b.id),
      );
      const harness = units[0]?.harness ?? "shared";
      const cacheKind = units[0]?.cacheKind ?? group;
      const selected = units.filter((unit) => marks.get(unit.id) === "clean");
      const retention = new Set(units.map((unit) => unit.retention.days));
      return {
        key: `clean-plan:${group}`,
        harness,
        harnessName: harnessName(index, harness),
        cacheKind,
        units,
        bytes: units.reduce((sum, unit) => sum + unit.metrics.bytes, 0),
        selected: selected.length,
        selectedBytes: selected.reduce((sum, unit) => sum + unit.metrics.bytes, 0),
        retentionDays: retention.size === 1 ? (units[0]?.retention.days ?? null) : null,
        projectCount: new Set(
          units
            .map((unit) => unit.project)
            .filter((project): project is string => project !== null),
        ).size,
        includesUserScope: units.some((unit) => unit.project === null),
      } satisfies CleanBucket;
    })
    .toSorted(
      (a, b) =>
        compare(a.harnessName, b.harnessName) ||
        compare(a.cacheKind, b.cacheKind) ||
        compare(a.key, b.key),
    );
}

export function selectedCleanMarks(
  candidates: readonly HarnessCache[],
  marks: ReadonlyMap<string, ActionKind>,
): Map<string, ActionKind> {
  const selected = new Map<string, ActionKind>();
  for (const entity of candidates) {
    if (marks.get(entity.id) === "clean") selected.set(entity.id, "clean");
  }
  return selected;
}

/** Defence in depth for the one-Enter path: only a local, recoverable cache-to-Trash Plan qualifies. */
export function isSafeCleanPlan(runPlan: Plan, scope: CleanScope): boolean {
  if (runPlan.groups.length !== 1) return false;
  const group = runPlan.groups[0];
  if (
    group === undefined ||
    group.action !== "clean" ||
    group.rows.length === 0 ||
    group.extraConfirmation.required ||
    group.shared !== 0 ||
    group.warnings.length !== 0
  ) {
    return false;
  }

  return group.rows.every(
    (row) =>
      row.action === "clean" &&
      row.target.kind === "harness-cache" &&
      (scope.kind === "global" || row.target.project === scope.project) &&
      row.disposition.kind === "trash" &&
      row.disposition.runnable &&
      !row.disposition.permanent &&
      row.disposition.reason === null &&
      row.paths.length > 0 &&
      row.backups.length === 0 &&
      row.edits.length === 0 &&
      (row.volume === "home" || row.volume === "local") &&
      !row.flags.some((flag) => flag === "shared" || flag === "live" || flag === "user-content") &&
      !row.badges.some(
        (badge) => badge === "permanent" || badge === "kept" || badge === "size-only",
      ),
  );
}
