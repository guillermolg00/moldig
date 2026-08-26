/**
 * The seam between the TUI and the actions engine (ticket 24).
 *
 * The TUI decides *what* is selected and shows the disposition of every row; it never touches
 * the filesystem, never classifies a volume and never runs a harness command. A `Runner`
 * answers both questions the screens cannot: whether a target's volume refuses a trash
 * (`refusal`) and what happened when a confirmed group was applied (`run`).
 *
 * `stubRunner` ships until ticket 24 lands: it refuses nothing in advance and reports every row
 * as refused with one reason, so the Confirm and Result screens are exercised end to end
 * without a byte moving.
 */
import type { Entity } from "@moldig/core";
import type { Env } from "./hyperlink.js";
import type { ActionKind, SelectionGroup, SelectionRow } from "./selection.js";

export type RowResult = "moved" | "edited" | "delegated" | "refused" | "failed";

export interface RunRow {
  readonly row: SelectionRow;
  readonly result: RowResult;
  readonly reason: string | null;
  readonly backupPath: string | null;
}

export interface RunGroup {
  readonly action: ActionKind;
  readonly title: string;
  readonly skipped: boolean;
  readonly rows: readonly RunRow[];
}

export interface RunResult {
  readonly runId: string;
  readonly manifestPath: string;
  readonly backupDir: string;
  readonly groups: readonly RunGroup[];
}

export interface RunContext {
  /** The ISO timestamp with `:` replaced by `-`; shared by every group of one run (08 Q2). */
  readonly runId: string;
  readonly home: string;
  readonly platform: string;
  readonly env: Env;
}

export interface Runner {
  /**
   * The engine's verdict on the volume the target sits on — `"network volume"` or `null`.
   * Decided by `lstat().dev` against `$HOME`'s (08 §3); never by a path prefix.
   */
  refusal(entity: Entity): string | null;
  /** Apply the confirmed groups in order and report every row; a failed row never aborts. */
  run(groups: readonly SelectionGroup[], context: RunContext): Promise<RunResult>;
}

function joinFor(platform: string, ...parts: string[]): string {
  return parts.join(platform === "win32" ? "\\" : "/");
}

/** moldig's own data directory (08 Q2): never inside a repository. */
export function dataDir(home: string, platform: string, env: Env): string {
  if (platform === "win32") return `${env["LOCALAPPDATA"] ?? `${home}\\AppData\\Local`}\\moldig`;
  return `${env["XDG_DATA_HOME"] ?? `${home}/.local/share`}/moldig`;
}

export function manifestPathFor(context: RunContext): string {
  const base = dataDir(context.home, context.platform, context.env);
  return joinFor(context.platform, base, "runs", `${context.runId}.json`);
}

export function backupDirFor(context: RunContext): string {
  const base = dataDir(context.home, context.platform, context.env);
  return joinFor(context.platform, base, "backups", context.runId);
}

/** A run id never carries `:` — Windows file names refuse it (08 Q2). */
export function newRunId(now: Date = new Date()): string {
  return now.toISOString().replaceAll(":", "-");
}

export function skippedGroup(group: SelectionGroup): RunGroup {
  return { action: group.action, title: group.title, skipped: true, rows: [] };
}

export const STUB_REASON = "the actions engine lands with ticket 24";

/** Ticket 24's placeholder: nothing is refused in advance, nothing is applied. */
export const stubRunner: Runner = {
  refusal: () => null,
  run: (groups, context) =>
    Promise.resolve({
      runId: context.runId,
      manifestPath: manifestPathFor(context),
      backupDir: backupDirFor(context),
      groups: groups.map((group) => ({
        action: group.action,
        title: group.title,
        skipped: false,
        rows: group.rows.map((row) => ({
          row,
          result: "refused" as const,
          reason: STUB_REASON,
          backupPath: null,
        })),
      })),
    }),
};

export interface RunTotals {
  readonly freedBytes: number;
  readonly tokens: Record<string, number>;
  readonly counts: Record<RowResult, number>;
  readonly backups: string[];
}

/** Freed bytes and tokens count only rows that moved, were edited or delegated in Clean/Delete. */
export function runTotals(groups: readonly RunGroup[]): RunTotals {
  const counts: Record<RowResult, number> = {
    moved: 0,
    edited: 0,
    delegated: 0,
    refused: 0,
    failed: 0,
  };
  const tokens: Record<string, number> = {};
  const backups: string[] = [];
  let freedBytes = 0;
  for (const group of groups) {
    for (const row of group.rows) {
      counts[row.result] += 1;
      if (row.backupPath !== null) backups.push(row.backupPath);
      const applied =
        row.result === "moved" || row.result === "edited" || row.result === "delegated";
      if (!applied) continue;
      if (group.action !== "clean" && group.action !== "delete") continue;
      freedBytes += row.row.bytes;
      for (const [harness, count] of Object.entries(row.row.tokens)) {
        tokens[harness] = (tokens[harness] ?? 0) + count;
      }
    }
  }
  return { freedBytes, tokens, counts, backups };
}

/** Bytes a group actually freed: refused and failed rows freed nothing. */
export function appliedBytes(group: RunGroup): number {
  return group.rows.reduce(
    (sum, row) => sum + (row.result === "refused" || row.result === "failed" ? 0 : row.row.bytes),
    0,
  );
}
