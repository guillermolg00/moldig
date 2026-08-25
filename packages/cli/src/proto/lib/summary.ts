// THROWAWAY PROTOTYPE (ticket 09) — the shareable summary printed on the primary screen
// after the alternate screen is left (ticket 08 §4 wording: freed MB, tokens/session freed
// per harness, rows moved / edited / delegated / refused / failed, manifest path).
import type { AuditIndex } from "@moldig/core";
import { formatBytes, formatRange, formatTokens, plural, shortPath } from "./format.js";
import { type ActionKind, type RunSummary, groupSelection, runTotals } from "./selection.js";

export interface SummaryInput {
  readonly index: AuditIndex;
  readonly marks: ReadonlyMap<string, ActionKind>;
  readonly run: RunSummary | null;
  readonly home: string;
  readonly platform: string;
}

export function harnessName(index: AuditIndex, harnessId: string): string {
  return index.harnesses.find((h) => h.id === harnessId)?.displayName ?? harnessId;
}

export function focusName(index: AuditIndex): string {
  const id = index.headline.focus.project;
  return index.projects.find((p) => p.id === id)?.displayName ?? "no project";
}

export function headlineLines(index: AuditIndex): string[] {
  const focus = focusName(index);
  return index.headline.perHarness.map((h) => {
    const name = harnessName(index, `harness:${h.harness}`).padEnd(12);
    const pct =
      h.pctOfContext === null || h.contextWindowTokens === null
        ? ""
        : ` · ${h.pctOfContext}% of ${formatTokens(h.contextWindowTokens)} context`;
    return `${name} every session pays ${formatTokens(h.baseline.mid)} + ${focus} adds ${formatTokens(h.project.mid)} = ${formatTokens(h.total.mid)} tokens/session (${formatRange(h.total)})${pct}`;
  });
}

function tokensLine(index: AuditIndex, tokens: Readonly<Record<string, number>>): string {
  const parts = Object.entries(tokens)
    .filter(([, t]) => t > 0)
    .map(([h, t]) => `${formatTokens(t)} ${harnessName(index, h)}`);
  return parts.length > 0 ? parts.join(", ") : "none";
}

export function summaryText(input: SummaryInput): string {
  const { index, run } = input;
  const lines: string[] = [];
  lines.push(`moldig — ${focusName(index)} (${index.headline.focus.reason})`);
  for (const line of headlineLines(index)) lines.push(`  ${line}`);

  if (run === null) {
    const groups = groupSelection(index, input.marks);
    const bytes = groups.reduce((acc, g) => acc + g.bytes, 0);
    const tokens: Record<string, number> = {};
    for (const g of groups)
      for (const [h, t] of Object.entries(g.tokens)) tokens[h] = (tokens[h] ?? 0) + t;
    const rows = groups.reduce((acc, g) => acc + g.rows.length, 0);
    lines.push(
      `Nothing moved (preview): ${plural(rows, "row")} selected · ${formatBytes(bytes)} would be freed · tokens/session: ${tokensLine(index, tokens)}`,
    );
    for (const g of groups)
      lines.push(`  ${g.title}: ${plural(g.rows.length, "row")} · ${formatBytes(g.bytes)}`);
    return `${lines.join("\n")}\n`;
  }

  const totals = runTotals(run);
  lines.push(
    `Freed ${formatBytes(totals.freedBytes)} · tokens/session freed: ${tokensLine(index, totals.tokens)}`,
  );
  lines.push(
    `Rows: ${totals.counts.moved} moved · ${totals.counts.edited} edited · ${totals.counts.delegated} delegated · ${totals.counts.refused} refused · ${totals.counts.failed} failed`,
  );
  for (const g of run.groups) {
    lines.push(
      g.skipped
        ? `  ${g.title}: skipped`
        : `  ${g.title}: ${plural(g.rows.length, "row")} · ${formatBytes(g.rows.reduce((acc, r) => acc + (r.result === "moved" || r.result === "edited" || r.result === "delegated" ? r.row.bytes : 0), 0))}`,
    );
  }
  lines.push(`Manifest: ${shortPath(run.manifestPath, input.home, input.platform)}`);
  for (const b of totals.backups) lines.push(`Backup: ${shortPath(b, input.home, input.platform)}`);
  return `${lines.join("\n")}\n`;
}
