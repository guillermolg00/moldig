// THROWAWAY PROTOTYPE (ticket 09) — screen 7: the selection panel (dua-cli's mark pane):
// groups Clean / Delete / Update / Open in that order, each with count, MB, tokens per
// session per harness and shared warnings; rows with ticket 08 §4 disposition strings.
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { Badges } from "../components/Badges.js";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { formatBytes, formatTokens, plural, truncate } from "../lib/format.js";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { type SelectionGroup, type SelectionRow, groupSelection } from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { harnessName } from "../lib/summary.js";
import { useList } from "../lib/useList.js";

type PanelRow =
  | { readonly key: string; readonly kind: "group"; readonly group: SelectionGroup }
  | { readonly key: string; readonly kind: "row"; readonly row: SelectionRow };

export function tokensText(
  index: { harnesses: { id: string; displayName: string }[] },
  tokens: Readonly<Record<string, number>>,
): string {
  const parts = Object.entries(tokens)
    .filter(([, t]) => t > 0)
    .map(
      ([h, t]) => `${formatTokens(t)} ${index.harnesses.find((x) => x.id === h)?.displayName ?? h}`,
    );
  return parts.length > 0 ? `${parts.join(", ")} tokens/session` : "no tokens/session";
}

export function SelectionScreen(): ReactElement {
  const store = useStore();
  const { index, marks } = store;
  const { rows: screenRows, columns } = useSize();
  const groups = groupSelection(index, marks);
  const rows: PanelRow[] = [];
  for (const g of groups) {
    rows.push({ key: `group:${g.action}`, kind: "group", group: g });
    for (const r of g.rows) rows.push({ key: r.entity.id, kind: "row", row: r });
  }
  const list = useList(
    rows,
    listHeight(screenRows, 1),
    (r) => r.key,
    (r) => r.kind === "row",
  );

  useKeys((input, key) => {
    const current = list.current;
    if (isUp(input, key)) list.move(-1);
    else if (isDown(input, key)) list.move(1);
    else if (key.escape) store.pop();
    else if (key.return) {
      if (groups.length === 0)
        store.setStatus(
          "nothing selected yet — space ticks harness-owned rows, d / u mark human-owned ones",
        );
      else store.push({ screen: "confirm" });
    } else if (!current || current.kind !== "row") return;
    else if (input === " " || input === "x") store.setMark(current.row.entity.id, null);
    else if (input === "o") store.openPath(current.row.entity.path);
  }, !store.helpOpen);

  const width = Math.max(24, Math.min(44, columns - 60));

  return (
    <Frame
      title="selection"
      keys="enter confirm · space/x unselect · o open · esc back · ? help · q quit"
    >
      <Box flexDirection="column">
        {groups.length === 0 ? <Text dimColor>nothing selected</Text> : null}
        {list.visible.map((r, i) => {
          const current = list.start + i === list.cursor;
          if (r.kind === "group") {
            const g = r.group;
            return (
              <Box key={r.key} flexDirection="column" paddingTop={i === 0 ? 0 : 1}>
                <Text bold underline>
                  {g.title} ({g.rows.length}) · {formatBytes(g.bytes)} ·{" "}
                  {tokensText(index, g.tokens)}
                </Text>
                {g.sharedCount > 0 ? (
                  <Text color="yellow">
                    {" "}
                    ⚠ {plural(g.sharedCount, "shared row")} — git-tracked, collaborators may rely on
                    them
                  </Text>
                ) : null}
                {g.extraConfirm ? (
                  <Text color="magenta"> ⚠ holds {g.extraConfirm} — confirmed separately</Text>
                ) : null}
              </Box>
            );
          }
          const row = r.row;
          return (
            <Text key={r.key} inverse={current}>
              {current ? "> " : "  "}
              <Text>{truncate(row.entity.label, width).padEnd(width)}</Text>
              <Text
                color={
                  row.disposition.kind === "refused"
                    ? "red"
                    : row.disposition.permanent
                      ? "red"
                      : "green"
                }
              >
                {" "}
                {row.disposition.text}
              </Text>
              <Badges badges={row.badges} />
              <Text dimColor>
                {"  "}
                {formatBytes(row.bytes)}
                {Object.keys(row.tokens).length > 0
                  ? ` · ${Object.entries(row.tokens)
                      .map(([h, t]) => `${formatTokens(t)} ${harnessName(index, h)}`)
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
