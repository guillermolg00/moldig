/**
 * Screen 7 — Selection panel (dua-cli's mark pane): the groups Clean → Delete → Update → Open in
 * that order, each with its count, size, tokens per session per harness and the shared warning;
 * every row carries the disposition decided before anything moves (08 §4).
 */
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { Badges } from "../components/Badges.js";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { formatBytes, formatTokens, plural, truncate } from "../lib/format.js";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { groupSelection, type SelectionGroup, type SelectionRow } from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { harnessName } from "../lib/summary.js";
import { useList } from "../lib/use-list.js";

type PanelRow =
  | { readonly key: string; readonly kind: "group"; readonly group: SelectionGroup }
  | { readonly key: string; readonly kind: "row"; readonly row: SelectionRow };

export function tokensText(
  index: { readonly harnesses: readonly { readonly id: string; readonly displayName: string }[] },
  tokens: Readonly<Record<string, number>>,
): string {
  const parts = Object.entries(tokens)
    .filter(([, count]) => count > 0)
    .map(([harness, count]) => {
      const name = index.harnesses.find((item) => item.id === harness)?.displayName ?? harness;
      return `${formatTokens(count)} ${name}`;
    });
  return parts.length > 0 ? `${parts.join(", ")} tokens/session` : "no tokens/session";
}

export function SelectionScreen(): ReactElement {
  const store = useStore();
  const { index, marks } = store;
  const { rows: screenRows, columns } = useSize();
  const groups = groupSelection(index, marks, store.refusal);
  const rows: PanelRow[] = [];
  for (const group of groups) {
    rows.push({ key: `group:${group.action}`, kind: "group", group });
    for (const row of group.rows) rows.push({ key: row.entity.id, kind: "row", row });
  }
  const list = useList(
    rows,
    listHeight(screenRows, 1),
    (row) => row.key,
    (row) => row.kind === "row",
  );

  useKeys((input, key) => {
    const current = list.current;
    if (isUp(input, key)) list.move(-1);
    else if (isDown(input, key)) list.move(1);
    else if (key.pageUp) list.move(-10);
    else if (key.pageDown) list.move(10);
    else if (key.escape) store.pop();
    else if (key.return) {
      if (groups.length === 0) {
        store.setStatus("nothing selected — go back and choose a cleanup scope");
      } else store.push({ screen: "confirm" });
    } else if (current === undefined || current.kind !== "row") return;
    else if (input === " " || input === "x") store.setMark(current.row.entity.id, null);
    else if (input === "o") store.openPath(current.row.entity.path);
  }, !store.helpOpen);

  const width = Math.max(24, Math.min(44, columns - 60));

  return (
    <Frame
      title="selection"
      subtitle={`${plural(marks.size, "item")} selected · ${formatBytes(groups.reduce((sum, group) => sum + group.bytes, 0))}`}
      keys="↑↓ navigate   space remove   enter review   esc back   ? shortcuts"
    >
      <Box flexDirection="column">
        {groups.length === 0 ? <Text dimColor>nothing selected</Text> : null}
        {list.visible.map((entry, i) => {
          const current = list.start + i === list.cursor;
          if (entry.kind === "group") {
            const group = entry.group;
            return (
              <Box key={entry.key} flexDirection="column" paddingTop={i === 0 ? 0 : 1}>
                <Text>
                  {group.title} ({group.rows.length})
                  <Text dimColor>
                    {"   "}
                    {formatBytes(group.bytes)} {tokensText(index, group.tokens)}
                  </Text>
                </Text>
                {group.sharedCount > 0 ? (
                  <Text color="yellow">
                    {"  "}
                    {plural(group.sharedCount, "shared row")} may affect collaborators.
                  </Text>
                ) : null}
                {group.extraConfirm === null ? null : (
                  <Text color="magenta"> {group.extraConfirm} requires a second confirmation.</Text>
                )}
              </Box>
            );
          }
          const row = entry.row;
          const danger = row.disposition.kind === "refused" || row.disposition.permanent;
          return (
            <Text key={entry.key} {...(current ? { color: "cyan" as const } : {})}>
              {current ? "› " : "  "}
              <Text>{truncate(row.entity.label, width).padEnd(width)}</Text>
              <Text>{"   "}</Text>
              <Text color={danger ? "red" : "green"}>{row.disposition.text}</Text>
              <Badges badges={row.badges} />
              <Text dimColor={!current}>
                {"   "}
                {formatBytes(row.bytes)}
                {Object.keys(row.tokens).length > 0
                  ? `   ${Object.entries(row.tokens)
                      .map(
                        ([harness, count]) =>
                          `${formatTokens(count)} ${harnessName(index, harness)}`,
                      )
                      .join(", ")}`
                  : ""}
              </Text>
            </Text>
          );
        })}
        {list.hiddenBelow > 0 ? <Text dimColor>… {list.hiddenBelow} more</Text> : null}
      </Box>
    </Frame>
  );
}
