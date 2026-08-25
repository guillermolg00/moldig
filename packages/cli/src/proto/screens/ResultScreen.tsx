// THROWAWAY PROTOTYPE (ticket 09) — screen 9: the result of the (simulated) run: per group
// counts, freed MB, tokens/session freed per harness, the manifest path, backup paths, and
// the Open group as a reading list. Quitting prints the shareable summary.
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { formatBytes, formatMb, plural, shortPath, truncate } from "../lib/format.js";
import { useKeys } from "../lib/keys.js";
import { type RowResult, runTotals } from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { tokensText } from "./SelectionScreen.js";

const RESULT_COLOR: Readonly<Record<RowResult, string>> = {
  moved: "green",
  edited: "green",
  delegated: "cyan",
  refused: "yellow",
  failed: "red",
};

export function ResultScreen(): ReactElement {
  const store = useStore();
  const { index, run, marks } = store;
  const { rows: screenRows, columns } = useSize();
  const home = store.home;
  const platform = store.platform;
  const toOpen = [...marks]
    .filter(([, a]) => a === "open")
    .map(([id]) => index.entities.find((e) => e.id === id))
    .filter((e) => e !== undefined);

  useKeys((input, key) => {
    if (key.escape || key.return) store.goHome();
    else if (input === "o") {
      const first = toOpen[0];
      if (first) store.openPath(first.path);
      else store.setStatus("nothing marked for Open");
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
  const height = listHeight(screenRows, 8 + run.groups.length * 2);
  const width = Math.max(24, Math.min(44, columns - 60));
  const allRows = run.groups.flatMap((g) => g.rows.map((r) => ({ group: g, r })));

  return (
    <Frame
      title="result"
      keys="o open the first Open row · esc / enter overview · q quit (prints the summary)"
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
        {run.groups.map((g) => (
          <Text key={g.action}>
            {"  "}
            <Text bold>{g.title.padEnd(8)}</Text>
            <Text dimColor>
              {g.skipped
                ? "skipped"
                : `${plural(g.rows.length, "row")} · ${formatBytes(g.rows.reduce((acc, r) => acc + (r.result === "refused" || r.result === "failed" ? 0 : r.row.bytes), 0))}`}
            </Text>
          </Text>
        ))}
        <Box flexDirection="column" paddingTop={1}>
          {allRows.slice(0, height).map(({ group, r }) => (
            <Text key={`${group.action}:${r.row.entity.id}`}>
              {"  "}
              <Text color={RESULT_COLOR[r.result]}>{r.result.padEnd(9)}</Text>
              <Text>{truncate(r.row.entity.label, width).padEnd(width)}</Text>
              <Text dimColor> {r.row.disposition.text}</Text>
              {r.reason ? (
                <Text color={r.result === "failed" ? "red" : "yellow"}> — {r.reason}</Text>
              ) : null}
            </Text>
          ))}
          {allRows.length > height ? <Text dimColor> … {allRows.length - height} more</Text> : null}
        </Box>
        <Box flexDirection="column" paddingTop={1}>
          <Text>
            <Text dimColor>manifest </Text>
            {store.link(run.manifestPath, shortPath(run.manifestPath, home, platform))}
          </Text>
          {totals.backups.map((b) => (
            <Text key={b}>
              <Text dimColor>backup </Text>
              {store.link(b, shortPath(b, home, platform))}
            </Text>
          ))}
          {toOpen.length > 0 ? (
            <Text>
              <Text dimColor>Open ({toOpen.length}) </Text>
              {toOpen
                .map((e) =>
                  store.link(e.path, shortPath(e.path, index.scan.home, index.scan.platform)),
                )
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
