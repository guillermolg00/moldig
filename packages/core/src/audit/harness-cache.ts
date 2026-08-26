/**
 * §7.9 harness-cache [ticket 08; D113; D116]: state a harness keeps for its own operation,
 * grouped by `(container, cacheKind)` — one finding per group, one `subject` target per sweep
 * unit, each carrying its own preselect tick. `rule: "kept"` units, `exempt` units and anything
 * whose `protection` is not `none` never appear here: kept state is reachable only through Delete
 * on the items screen, and a size-only row has no action at all.
 */
import type { Finding, HarnessCache, Index } from "../index/types.js";
import { flagsOf, harnessNameOf, plural, sizeOf } from "./shared.js";

/**
 * D113: the group turns `medium` past `100 × 1024 × 1024` bytes or 50 units — the copy says
 * "100 MB" — and never reaches `high`: a cache is large, not dangerous.
 */
const MEDIUM_BYTES = 100 * 1024 * 1024;
const MEDIUM_UNITS = 50;

/** Ticket 08: swept ∧ retention.days ∧ ageDays > days ∧ liveGuard.alive === false ∧ ¬userContent. */
export function isPreselected(unit: HarnessCache): boolean {
  return (
    unit.rule === "swept" &&
    unit.retention.days !== null &&
    unit.metrics.ageDays !== null &&
    unit.metrics.ageDays > unit.retention.days &&
    unit.liveGuard !== null &&
    !unit.liveGuard.alive &&
    !unit.userContent
  );
}

/** D111: what a clean group may hold — a `kept` unit never enters one. */
export function isCleanable(unit: HarnessCache): boolean {
  return unit.protection === "none" && (unit.rule === "swept" || unit.rule === "undocumented");
}

export function harnessCacheFindings(index: Index): Finding[] {
  const groups = new Map<string, { container: string; cacheKind: string; units: HarnessCache[] }>();
  for (const entity of index.entities) {
    if (entity.kind !== "harness-cache" || !isCleanable(entity)) continue;
    const container = entity.project ?? `harness:${entity.harness ?? "unknown"}`;
    const key = `${container} ${entity.cacheKind}`;
    const group = groups.get(key) ?? { container, cacheKind: entity.cacheKind, units: [] };
    group.units.push(entity);
    groups.set(key, group);
  }
  const out: Finding[] = [];
  for (const [, { container, cacheKind, units }] of groups) {
    const sorted = units.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const bytes = sorted.reduce((sum, unit) => sum + unit.metrics.bytes, 0);
    const files = sorted.reduce((sum, unit) => sum + (unit.metrics.files ?? 0), 0);
    const preselected = sorted.filter((unit) => isPreselected(unit));
    const harnessName = harnessNameOf(index, sorted[0]?.harness ?? null);
    const retention = sorted[0]?.retention ?? {
      days: null,
      bytes: null,
      count: null,
      source: null,
    };
    const noun = cacheKind === "transcript" ? "session" : cacheKind.replaceAll("-", " ");
    let message: string;
    if (retention.days !== null) {
      message =
        preselected.length > 0
          ? `${plural(preselected.length, noun)} older than the ${retention.days}-day retention ${harnessName} sweeps itself (${plural(sorted.length, noun)}, ${sizeOf(bytes)})`
          : `${plural(sorted.length, noun)} (${sizeOf(bytes)}) within the ${retention.days}-day retention ${harnessName} sweeps itself`;
    } else if (retention.count !== null) {
      message = `${plural(sorted.length, noun)} (${sizeOf(bytes)}); ${harnessName} keeps the ${retention.count} newest`;
    } else {
      message = `${plural(sorted.length, noun)} (${sizeOf(bytes)}) ${harnessName} documents no sweep for`;
    }
    const evidence: Finding["evidence"] = [];
    if (retention.days !== null) {
      const oldest = sorted.reduce<number | null>(
        (max, unit) =>
          unit.metrics.ageDays === null ? max : Math.max(max ?? 0, unit.metrics.ageDays),
        null,
      );
      evidence.push({
        kind: "retention-rule",
        detail: `${retention.source ?? "retention"} = ${retention.days}; oldest unit ${oldest ?? 0} days old`,
      });
    } else if (retention.count !== null) {
      evidence.push({
        kind: "retention-rule",
        detail: `${retention.source ?? "retention"} keeps ${retention.count}`,
      });
    } else {
      evidence.push({ kind: "retention-rule", detail: "no documented sweep" });
    }
    out.push({
      id: `finding:harness-cache:${container}:${cacheKind}`,
      category: "harness-cache",
      severity: bytes > MEDIUM_BYTES || sorted.length > MEDIUM_UNITS ? "medium" : "low",
      container,
      targets: sorted.map((unit) => ({
        id: unit.id,
        role: "subject" as const,
        preselect: isPreselected(unit),
      })),
      message,
      evidence,
      confidence: "certain",
      impact: { bytes, tokens: null, files },
      flags: flagsOf(sorted),
      action: { kind: "clean", preselect: preselected.length > 0, locator: null },
    });
  }
  return out;
}
