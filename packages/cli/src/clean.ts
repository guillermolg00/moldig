/**
 * `moldig clean` outside the selection panel: the plan `--dry-run` prints, the unattended run
 * `--yes` plus a filter allows, and the shareable summary both leave behind (§1.10, 08 §4).
 *
 * The universe is exactly what the audit preselected; the filters only narrow it and nothing
 * can widen it (D16). Every disposition is decided before anything moves, `--dry-run` runs no
 * executor at all, and a failed row never aborts the run (08 §3).
 */
import {
  apply,
  plan,
  selectionFrom,
  summaryLines,
  type AuditIndex,
  type Device,
  type Executors,
  type Plan,
  type PlanEnv,
  type PlanRow,
  type RunManifest,
  type ScanPlatform,
} from "@moldig/core";
import type { Options } from "./args.js";
import { ensureDirFor } from "./executors/index.js";
import { formatBytes, formatTokens, plural } from "./format.js";
import { badgesOfRow } from "./tui/lib/selection.js";
import { harnessNames } from "./tui/lib/summary.js";

export interface CleanContext {
  readonly index: AuditIndex;
  readonly executors: Executors;
  /** `$XDG_DATA_HOME/moldig` — never inside a repository (08 §5). */
  readonly dataDir: string;
  readonly platform: ScanPlatform;
  readonly home: string;
  /** Which volume a path sits on; `createDeviceProbe` builds the real one (08 §3.2). */
  readonly deviceOf: (path: string) => Device;
  readonly version: string;
  /** The command line the manifest records (`moldig clean --yes --harness codex`). */
  readonly command: string;
}

/** `12 000 Claude Code, 3 400 Codex`, or `none` (09 §8). */
function tokensList(index: AuditIndex, tokens: Readonly<Record<string, number>>): string {
  const names = harnessNames(index);
  const parts = Object.entries(tokens)
    .filter(([, count]) => count > 0)
    .map(([harness, count]) => `${formatTokens(count)} ${names[harness] ?? harness}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

/** `12 000 Claude Code tokens/session`, or nothing to say. */
function tokensText(index: AuditIndex, tokens: Readonly<Record<string, number>>): string {
  const list = tokensList(index, tokens);
  return list === "none" ? "no tokens/session" : `${list} tokens/session`;
}

function badgesText(row: PlanRow): string {
  const badges = badgesOfRow(row);
  return badges.length === 0 ? "" : ` ${badges.map((badge) => `[${badge}]`).join(" ")}`;
}

/**
 * The preview of 08 §4: per group the count, the size and the tokens per session, the shared
 * and extra-confirmation warnings, then every row with its disposition string and its badges.
 */
export function planLines(runPlan: Plan, index: AuditIndex): string[] {
  const lines: string[] = [];
  for (const group of runPlan.groups) {
    if (lines.length > 0) lines.push("");
    lines.push(
      `${group.title} (${group.count}) · ${formatBytes(group.bytes)} · ${tokensText(index, group.tokensPerSession)}`,
    );
    for (const warning of group.warnings) lines.push(` ${warning}`);
    for (const row of group.rows) {
      lines.push(
        `  ${row.target.label}  ${row.disposition.display}${badgesText(row)}  ${formatBytes(row.bytes)}`,
      );
    }
  }
  return lines;
}

/**
 * What a preview ends with (09 §8). It reads the Plan, not the dry-run manifest: a planned row
 * has moved nothing, so the manifest's group summaries are all zero — the sizes the user needs
 * to see are the Plan's own.
 */
export function planSummaryLines(runPlan: Plan, index: AuditIndex): string[] {
  const rows = runPlan.groups.reduce((sum, group) => sum + group.count, 0);
  const bytes = runPlan.groups.reduce((sum, group) => sum + group.bytes, 0);
  const tokens: Record<string, number> = {};
  for (const group of runPlan.groups) {
    for (const [harness, count] of Object.entries(group.tokensPerSession)) {
      tokens[harness] = (tokens[harness] ?? 0) + count;
    }
  }
  return [
    `Nothing moved (preview): ${plural(rows, "row")} selected · ${formatBytes(bytes)} would be freed · tokens/session: ${tokensList(index, tokens)}`,
    ...runPlan.groups.map(
      (group) => `  ${group.title}: ${plural(group.count, "row")} · ${formatBytes(group.bytes)}`,
    ),
  ];
}

/** The selection an unattended run starts from: the preselected units, narrowed (D16). */
export function cleanPlan(options: Options, context: CleanContext): Plan {
  const selection = selectionFrom(context.index, {
    categories: options.categories,
    harnesses: options.harnesses,
    ...(options.olderThanDays === null ? {} : { olderThanDays: options.olderThanDays }),
  });
  const environment: PlanEnv = {
    home: context.home,
    platform: context.platform,
    dataDir: context.dataDir,
    now: context.executors.now(),
    moldig: { version: context.version },
    command: context.command,
    deviceOf: context.deviceOf,
  };
  return plan(context.index, selection, environment);
}

/** D115: the plan as the run-manifest document, `mode: "dry-run"`, every row `planned`. */
export function dryRun(runPlan: Plan, context: CleanContext): Promise<RunManifest> {
  return apply(runPlan, context.executors, { mode: "dry-run" });
}

/** Nothing was ever attempted, so nothing can have failed: refused rows are not failures (D4). */
export function exitCodeFor(manifest: RunManifest): number {
  return manifest.rows.some((row) => row.result.status === "failed") ? 1 : 0;
}

export function summaryFor(manifest: RunManifest, index: AuditIndex): string[] {
  return summaryLines(manifest, { harnessNames: harnessNames(index) });
}

/** The runs directory has to exist before the manifest lands there, before the first move. */
export async function applyPlan(runPlan: Plan, context: CleanContext): Promise<RunManifest> {
  await ensureDirFor(runPlan.manifestPath);
  return apply(runPlan, context.executors);
}
