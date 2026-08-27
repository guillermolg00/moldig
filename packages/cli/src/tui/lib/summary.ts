/**
 * The quiet summary moldig leaves in scrollback after the alternate screen closes. No run means
 * one line; a finished run keeps the engine's recovery details. Plain text, no ANSI, paths
 * `~`-shortened.
 */
import { summaryLines, type AuditIndex, type RunManifest } from "@moldig/core";
import { formatBytes, formatRange, formatTokens, plural } from "../../format.js";
import { shortPath } from "./format.js";
import { type ActionKind, groupSelection, type Refusal, noRefusal } from "./selection.js";

export interface SummaryInput {
  readonly index: AuditIndex;
  readonly marks: ReadonlyMap<string, ActionKind>;
  readonly run: RunManifest | null;
  readonly home: string;
  readonly platform: string;
  readonly refusal?: Refusal;
}

/** `claude-code` and `harness:claude-code` alike answer `Claude Code` (08 §4 wording). */
export function harnessNames(index: AuditIndex): Record<string, string> {
  const names: Record<string, string> = {};
  for (const harness of index.harnesses) {
    names[harness.id] = harness.displayName;
    names[harness.id.replace(/^harness:/u, "")] = harness.displayName;
  }
  return names;
}

/** The two lines of `summaryLines` that carry a path are `~`-shortened here (09 §8). */
const PATH_LINE = /^(Manifest|Backup): (.+)$/u;

export function harnessName(index: AuditIndex, harnessId: string): string {
  return index.harnesses.find((harness) => harness.id === harnessId)?.displayName ?? harnessId;
}

export function focusName(index: AuditIndex): string {
  const id = index.headline.focus.project;
  return index.projects.find((project) => project.id === id)?.displayName ?? "no project";
}

export function headlineLines(index: AuditIndex): string[] {
  const focus = focusName(index);
  return index.headline.perHarness.map((entry) => {
    const name = harnessName(index, `harness:${entry.harness}`).padEnd(12);
    const pct =
      entry.pctOfContext === null || entry.contextWindowTokens === null
        ? ""
        : ` · ${entry.pctOfContext}% of ${formatTokens(entry.contextWindowTokens)} context`;
    const range = formatRange(entry.total.low, entry.total.high);
    return (
      `${name} every session pays ${formatTokens(entry.baseline.mid)} + ${focus} adds ` +
      `${formatTokens(entry.project.mid)} = ${formatTokens(entry.total.mid)} tokens/session (${range})${pct}`
    );
  });
}

export function summaryText(input: SummaryInput): string {
  const { index, run } = input;
  const lines: string[] = [`moldig · ${focusName(index)}`];

  if (run === null) {
    const groups = groupSelection(index, input.marks, input.refusal ?? noRefusal);
    const bytes = groups.reduce((sum, group) => sum + group.bytes, 0);
    const rows = groups.reduce((sum, group) => sum + group.rows.length, 0);
    const result =
      rows === 0
        ? "No changes."
        : `No changes · ${plural(rows, "item")} still selected · ${formatBytes(bytes)}.`;
    return `${lines[0]} — ${result}\n`;
  }

  // After a run the numbers come from the engine's own summary (08 §4), so the shareable text,
  // the Result screen and an unattended run all say the same thing.
  for (const line of summaryLines(run, { harnessNames: harnessNames(index) })) {
    const match = PATH_LINE.exec(line);
    lines.push(
      match === null
        ? line
        : `${match[1]}: ${shortPath(match[2] ?? "", input.home, input.platform)}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
