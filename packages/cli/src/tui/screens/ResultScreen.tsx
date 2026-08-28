/**
 * Screen 9 — Result: what the run did, per group and per row — freed size, tokens per session
 * freed per harness, the manifest and backup paths, and the Open group as a reading list.
 * Everything comes from the run manifest the engine returned (D115); nothing is recomputed.
 * Quitting from here prints the shareable summary on the primary screen.
 */
import { ACTION_TITLES, type RowStatus } from "@moldig/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { formatBytes, formatMb, plural, shortPath, truncate } from "../lib/format.js";
import { useKeys } from "../lib/keys.js";
import { isQuietCleanRun, isQuietPurgeRun, rowsOf, runTotals } from "../lib/runner.js";
import { useStore } from "../lib/store.js";
import { tokensText } from "./SelectionScreen.js";

const RESULT_COLOR: Readonly<Record<RowStatus, string>> = {
  planned: "gray",
  moved: "green",
  edited: "green",
  delegated: "cyan",
  refused: "yellow",
  failed: "red",
};

export function ResultScreen({ returnTo }: { readonly returnTo?: "inventory" }): ReactElement {
  const store = useStore();
  const { index, run, marks } = store;
  const { rows: screenRows, columns } = useSize();
  const { home, platform } = store;
  const toOpen = [...marks]
    .filter(([, action]) => action === "open")
    .map(([id]) => index.entities.find((entity) => entity.id === id))
    .filter((entity) => entity !== undefined);
  const quietClean = store.quietResult?.kind === "clean" && run !== null && isQuietCleanRun(run);
  const quietPurge = store.quietResult?.kind === "purge" && run !== null && isQuietPurgeRun(run);
  const quiet = quietClean || quietPurge;

  useKeys((input, key) => {
    if (quiet) return;
    if (key.escape || key.return) {
      if (returnTo === "inventory") store.reset({ screen: "categories" });
      else store.goHome();
    } else if (input === "o") {
      const first = toOpen[0];
      if (first === undefined) store.setStatus("nothing marked for Open");
      else store.openPath(first.path);
    }
  }, !store.helpOpen);

  if (run === null) {
    return (
      <Frame title="result" keys="esc overview · q quit">
        <Text dimColor>no run yet</Text>
      </Frame>
    );
  }

  const totals = runTotals(run);
  if (quiet) {
    const purgeProjects = store.quietResult?.kind === "purge" ? store.quietResult.projects : null;
    return (
      <Frame title="done" keys="q quit">
        <Box flexDirection="column">
          <Text bold color="green">
            {purgeProjects === null
              ? `Done · ${formatBytes(totals.freedBytes)} to the OS Trash · ${plural(totals.counts.moved, "item")}`
              : `Done · state from ${plural(purgeProjects, "missing Project")} removed · ${formatBytes(totals.freedBytes)}`}
          </Text>
          <Text dimColor>
            {purgeProjects === null
              ? "Recover with Put Back"
              : "Recover from the OS Trash and backups in the manifest"}{" "}
            · manifest {store.link(run.manifestPath, shortPath(run.manifestPath, home, platform))}
          </Text>
        </Box>
      </Frame>
    );
  }
  const height = listHeight(screenRows, 8 + run.groups.length * 2);
  const width = Math.max(24, Math.min(44, columns - 60));
  const allRows = run.groups.flatMap((group) =>
    rowsOf(run, group).map((row) => ({ action: group.action, row })),
  );

  return (
    <Frame
      title="result"
      keys={`o open the first Open row · esc / enter ${returnTo === "inventory" ? "inventory" : "overview"} · q quit (prints the summary)`}
    >
      <Box flexDirection="column">
        <Text>
          <Text bold color="green">
            Freed {formatMb(totals.freedBytes)}
          </Text>
          <Text> · {tokensText(index, totals.tokens)} freed</Text>
        </Text>
        <Text>
          Rows: <Text color="green">{totals.counts.moved} moved</Text> ·{" "}
          <Text color="green">{totals.counts.edited} edited</Text> ·{" "}
          <Text color="cyan">{totals.counts.delegated} delegated</Text> ·{" "}
          <Text color="yellow">{totals.counts.refused} refused</Text> ·{" "}
          <Text color="red">{totals.counts.failed} failed</Text>
        </Text>
        {run.groups.map((group) => (
          <Text key={group.action}>
            {"  "}
            <Text bold>{ACTION_TITLES[group.action].padEnd(8)}</Text>
            <Text dimColor>
              {group.status === "skipped"
                ? "skipped"
                : `${plural(group.summary.rows, "row")} · ${formatBytes(group.summary.bytes)}`}
            </Text>
          </Text>
        ))}
        <Box flexDirection="column" paddingTop={1}>
          {allRows.slice(0, height).map(({ action, row }) => (
            <Text key={`${action}:${row.target.key}`}>
              {"  "}
              <Text color={RESULT_COLOR[row.result.status]}>{row.result.status.padEnd(9)}</Text>
              <Text>{truncate(row.target.label, width).padEnd(width)}</Text>
              <Text dimColor> {row.disposition.display}</Text>
              {row.result.reason === null ? null : (
                <Text color={row.result.status === "failed" ? "red" : "yellow"}>
                  {" "}
                  — {row.result.reason}
                </Text>
              )}
            </Text>
          ))}
          {allRows.length > height ? <Text dimColor> … {allRows.length - height} more</Text> : null}
        </Box>
        <Box flexDirection="column" paddingTop={1}>
          <Text>
            <Text dimColor>manifest </Text>
            {store.link(run.manifestPath, shortPath(run.manifestPath, home, platform))}
          </Text>
          {totals.backups.map((backup) => (
            <Text key={backup}>
              <Text dimColor>backup </Text>
              {store.link(backup, shortPath(backup, home, platform))}
            </Text>
          ))}
          {toOpen.length > 0 ? (
            <Text>
              <Text dimColor>Open ({toOpen.length}) </Text>
              {toOpen
                .map((entity) => store.link(entity.path, shortPath(entity.path, home, platform)))
                .join("  ")}
            </Text>
          ) : null}
          <Text dimColor>
            recovery: OS trash "Put Back" + the backup paths in the manifest (no restore command in
            v1)
          </Text>
        </Box>
      </Box>
    </Frame>
  );
}
