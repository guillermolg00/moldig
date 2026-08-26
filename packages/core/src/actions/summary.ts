/**
 * The summary of ticket 08 §4: a pure function over the run manifest returning the lines the
 * CLI prints — freed bytes, tokens per session freed per harness, rows moved / edited /
 * delegated / refused / failed, one line per group, the manifest path and the backup paths.
 * Freed bytes and tokens count only rows that moved, were edited or delegated, in the Clean
 * and Delete groups.
 */
import { ACTION_TITLES, type RunManifest } from "./types.js";

export interface SummaryOptions {
  /** `claude-code` → `Claude Code`; the ids stand in when a name is missing. */
  harnessNames?: Record<string, string>;
}

function sizeOf(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function count(value: number): string {
  return value.toString().replaceAll(/\B(?=(?:\d{3})+(?!\d))/gu, ",");
}

function tokensText(tokens: Record<string, number>, options: SummaryOptions): string | null {
  const parts = Object.entries(tokens)
    .filter(([, value]) => value > 0)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([harness, value]) => `${options.harnessNames?.[harness] ?? harness} ${count(value)}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** The lines the result screen and the shareable summary print (08 §4; 09 §9). */
export function summaryLines(manifest: RunManifest, options: SummaryOptions = {}): string[] {
  const counted = { moved: 0, edited: 0, delegated: 0, refused: 0, failed: 0, planned: 0 };
  const tokens: Record<string, number> = {};
  let bytes = 0;
  const freed = new Set(["moved", "edited", "delegated"]);
  const groupOf = new Map<string, string>();
  for (const group of manifest.groups) {
    for (const key of group.rows) groupOf.set(key, group.action);
  }
  for (const row of manifest.rows) {
    counted[row.result.status] += 1;
    const action = groupOf.get(row.target.key) ?? "clean";
    if (!freed.has(row.result.status) || (action !== "clean" && action !== "delete")) continue;
    bytes += row.target.bytes;
    for (const [harness, value] of Object.entries(row.tokensPerSession)) {
      tokens[harness] = (tokens[harness] ?? 0) + value;
    }
  }
  const perHarness = tokensText(tokens, options);
  const lines: string[] = [];
  if (manifest.mode === "dry-run") {
    const selected = manifest.rows.length;
    const would = manifest.groups.reduce((sum, group) => sum + group.summary.bytes, 0);
    const planned = manifest.groups.reduce<Record<string, number>>((into, group) => {
      for (const [harness, value] of Object.entries(group.summary.tokensPerSession)) {
        into[harness] = (into[harness] ?? 0) + value;
      }
      return into;
    }, {});
    const plannedTokens = tokensText(planned, options);
    lines.push(
      `Nothing moved (preview): ${selected} ${selected === 1 ? "row" : "rows"} selected · ${sizeOf(would)} would be freed${plannedTokens === null ? "" : ` · tokens/session: ${plannedTokens}`}`,
    );
  } else {
    lines.push(
      `Freed ${sizeOf(bytes)}${perHarness === null ? "" : ` · tokens/session freed: ${perHarness}`}`,
    );
    lines.push(
      `Rows: ${counted.moved} moved · ${counted.edited} edited · ${counted.delegated} delegated · ${counted.refused} refused · ${counted.failed} failed`,
    );
  }
  for (const group of manifest.groups) {
    const title = ACTION_TITLES[group.action];
    lines.push(
      group.status === "skipped"
        ? `${title} skipped`
        : `${title} ${group.summary.rows} ${group.summary.rows === 1 ? "row" : "rows"} · ${sizeOf(group.summary.bytes)}`,
    );
  }
  if (manifest.mode === "dry-run") return lines;
  lines.push(`Manifest: ${manifest.manifestPath}`);
  for (const row of manifest.rows) {
    if (!freed.has(row.result.status)) continue;
    for (const backup of row.target.backupPaths) lines.push(`Backup: ${backup}`);
  }
  lines.push(
    'recovery: OS trash "Put Back" + the backup paths in the manifest (no restore command in v1)',
  );
  return lines;
}
