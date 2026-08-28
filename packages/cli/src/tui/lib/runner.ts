/**
 * The seam between the TUI and the actions engine (08 §9). The screens decide *what* is
 * selected; the Runner decides nothing and executes everything: `plan()` turns the confirmed
 * groups into dispositions before a byte moves, `apply()` runs them through the injected
 * executors and hands back the run manifest the Result screen renders.
 *
 * Every side effect arrives as an `Executors` object (D103), so a test drives a whole run over
 * a fixture tree without anything reaching the real trash or the real data directory.
 */
import {
  apply,
  plan,
  type ApplyProgress,
  type AuditIndex,
  type Confirm,
  type Device,
  type Entity,
  type Executors,
  type Locator,
  type ManifestGroup,
  type ManifestRow,
  type Plan,
  type PlanEnv,
  type RowStatus,
  type RunManifest,
  updateAllSelection,
  type Selection,
  type SelectionTarget,
  type UpdateAllSelection,
} from "@moldig/core";
import type { SelectionGroup } from "./selection.js";

/** D89, verbatim: why a volume refuses a row. A row shows the half before the em dash. */
const VOLUME_REASONS: Readonly<Record<Exclude<Device["kind"], "local">, string>> = {
  network: "network volume — no trash available",
  "read-only": "read-only volume — nothing can be moved",
  unknown: "volume moldig cannot classify — no trash available",
  "dropped-mount": "mount outside the system's trash table — no trash available",
};

/** The paths a target moves: what `plan()` classifies, and nothing else (08 §3.2). */
function pathsOf(locator: Locator): string[] {
  if (locator.type === "file" || locator.type === "dir") return [locator.path];
  return locator.type === "paths" ? [...locator.paths] : [];
}

/**
 * The engine's verdict on the volume a target sits on: the verbatim reason or `null`. Decided
 * by `lstat().dev` against `$HOME`'s through the injected probe, never by a path prefix.
 */
export function refusalFor(entity: Entity, deviceOf: (path: string) => Device): string | null {
  for (const path of pathsOf(entity.locator)) {
    const { kind } = deviceOf(path);
    if (kind !== "local") return VOLUME_REASONS[kind];
  }
  return null;
}

/** One selection target per marked row; the Open group plans but never runs (08 §1). */
export function selectionOf(groups: readonly SelectionGroup[]): Selection {
  const targets: SelectionTarget[] = [];
  for (const group of groups) {
    for (const row of group.rows) {
      targets.push({ action: group.action, id: row.entity.id });
    }
  }
  return targets;
}

export interface UpdateAllPlan extends UpdateAllSelection {
  readonly plan: Plan;
}

export interface Runner {
  /** The volume verdict a screen greys a row with; `null` when the row can move. */
  refusal(entity: Entity): string | null;
  /** Every disposition, backup path and delegate decided before anything moves (08 §3). */
  plan(groups: readonly SelectionGroup[]): Plan;
  /** Locator targets used by explicit Project-level deletion, without an item review detour. */
  planSelection(selection: Selection): Plan;
  /** One deduplicated machine-wide updater Plan plus every honest skip/managed reason. */
  planUpdateAll(): UpdateAllPlan;
  /** Applies the Plan group by group, asking `confirm`; a failed row never aborts (08 §7). */
  apply(
    runPlan: Plan,
    confirm: Confirm,
    onProgress?: (event: ApplyProgress) => void,
  ): Promise<RunManifest>;
}

export interface RunnerOptions {
  readonly index: AuditIndex;
  readonly executors: Executors;
  /** Which volume a path sits on; `createDeviceProbe` builds the real one. */
  readonly deviceOf: (path: string) => Device;
  /** `$XDG_DATA_HOME/moldig` — never inside a repository (08 §5). */
  readonly dataDir: string;
  readonly platform: "darwin" | "linux" | "win32";
  readonly home: string;
  readonly version: string;
  /** The command line the manifest records (`clean --yes --harness claude-code`). */
  readonly command: string;
  /** Awaited before the first write: the runs directory has to exist (08 §5). */
  readonly prepare?: (runPlan: Plan) => Promise<void>;
}

export function createRunner(options: RunnerOptions): Runner {
  const environment = (): PlanEnv => ({
    home: options.home,
    platform: options.platform,
    dataDir: options.dataDir,
    now: options.executors.now(),
    moldig: { version: options.version },
    command: options.command,
    deviceOf: options.deviceOf,
  });
  return {
    refusal: (entity) => refusalFor(entity, options.deviceOf),
    plan: (groups) => plan(options.index, selectionOf(groups), environment()),
    planSelection: (selection) => plan(options.index, selection, environment()),
    planUpdateAll: () => {
      const preview = updateAllSelection(options.index);
      return { ...preview, plan: plan(options.index, preview.selection, environment()) };
    },
    apply: async (runPlan, confirm, onProgress) => {
      await options.prepare?.(runPlan);
      return apply(runPlan, options.executors, {
        confirm,
        ...(onProgress === undefined ? {} : { onProgress }),
      });
    },
  };
}

export interface RunTotals {
  readonly freedBytes: number;
  readonly tokens: Record<string, number>;
  readonly counts: Record<RowStatus, number>;
  readonly backups: string[];
}

/** Freed bytes and tokens count only rows that moved, were edited or delegated (08 §4). */
export function runTotals(manifest: RunManifest): RunTotals {
  const counts: Record<RowStatus, number> = {
    planned: 0,
    moved: 0,
    edited: 0,
    delegated: 0,
    refused: 0,
    failed: 0,
  };
  const tokens: Record<string, number> = {};
  const backups: string[] = [];
  const actionOf = new Map<string, string>();
  for (const group of manifest.groups) {
    for (const key of group.rows) actionOf.set(key, group.action);
  }
  let freedBytes = 0;
  for (const row of manifest.rows) {
    counts[row.result.status] += 1;
    const applied =
      row.result.status === "moved" ||
      row.result.status === "edited" ||
      row.result.status === "delegated";
    if (!applied) continue;
    for (const backup of row.target.backupPaths) {
      if (!backups.includes(backup)) backups.push(backup);
    }
    const action = actionOf.get(row.target.key);
    if (action !== "clean" && action !== "delete") continue;
    freedBytes += row.target.bytes;
    for (const [harness, count] of Object.entries(row.tokensPerSession)) {
      tokens[harness] = (tokens[harness] ?? 0) + count;
    }
  }
  return { freedBytes, tokens, counts, backups };
}

/** The manifest rows of one group, in the order the group ran them. */
export function rowsOf(manifest: RunManifest, group: ManifestGroup): ManifestRow[] {
  const byKey = new Map(manifest.rows.map((row) => [row.target.key, row]));
  return group.rows
    .map((key) => byKey.get(key))
    .filter((row): row is ManifestRow => row !== undefined);
}

/** A boring successful sweep earns a quiet close; anything else keeps the detailed engine report. */
export function isQuietCleanRun(manifest: RunManifest): boolean {
  if (manifest.mode !== "run" || manifest.groups.length !== 1 || manifest.rows.length === 0) {
    return false;
  }
  const group = manifest.groups[0];
  return (
    group?.action === "clean" &&
    group.status === "ran" &&
    !group.confirmation.extraRequired &&
    manifest.rows.every((row) => row.disposition.kind === "trash" && row.result.status === "moved")
  );
}

export function isQuietPurgeRun(manifest: RunManifest): boolean {
  if (manifest.mode !== "run" || manifest.groups.length !== 1 || manifest.rows.length === 0) {
    return false;
  }
  const group = manifest.groups[0];
  const completed = new Set<RowStatus>(["moved", "edited", "delegated"]);
  return (
    group?.action === "delete" &&
    group.status === "ran" &&
    group.confirmation.extraRequired &&
    manifest.rows.every((row) => completed.has(row.result.status))
  );
}
