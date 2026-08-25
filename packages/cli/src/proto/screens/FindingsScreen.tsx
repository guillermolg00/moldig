// THROWAWAY PROTOTYPE (ticket 09) — screen 5: the findings of one category (message,
// severity, container, impact); enter opens the target list with the items-screen mechanics.
import type { Category, Finding } from "@moldig/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { Badges, SeverityBadge } from "../components/Badges.js";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { CATEGORY_LABEL, formatBytes, formatTokens, plural, truncate } from "../lib/format.js";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { containerLabel } from "../lib/rows.js";
import { type Badge, entityById, flagBadge } from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { useList } from "../lib/useList.js";

const RANK: Record<Finding["severity"], number> = { low: 1, medium: 2, high: 3 };

function targetIds(f: Finding): string[] {
  return f.targets.map((t) => t.id).filter((id): id is string => id !== undefined);
}

export function FindingsScreen({ category }: { readonly category: Category }): ReactElement {
  const store = useStore();
  const { index } = store;
  const { rows: screenRows, columns } = useSize();
  const findings = index.findings
    .filter((f) => f.category === category)
    .toSorted((a, b) => RANK[b.severity] - RANK[a.severity] || b.impact.bytes - a.impact.bytes);
  const list = useList(findings, listHeight(screenRows, 1), (f) => f.id);

  useKeys((input, key) => {
    const f = list.current;
    if (isUp(input, key)) list.move(-1);
    else if (isDown(input, key)) list.move(1);
    else if (key.escape) store.pop();
    else if (!f) return;
    else if (key.return) {
      store.push({
        screen: "items",
        container: f.container,
        title: f.message,
        onlyIds: targetIds(f),
      });
    } else if (input === "g") {
      const first = targetIds(f)[0];
      if (first) store.push({ screen: "graph", focusId: first });
    } else if (input === "o") {
      const first = targetIds(f)[0];
      const entity = first ? entityById(index, first) : undefined;
      if (entity) store.openPath(entity.path);
    }
  }, !store.helpOpen);

  const width = Math.max(30, columns - 46);

  return (
    <Frame
      title={`${CATEGORY_LABEL[category] ?? category} · ${plural(findings.length, "finding")}`}
      keys="↑↓ move · enter targets · g graph · o open · esc back · ? help · q quit"
    >
      <Box flexDirection="column">
        {findings.length === 0 ? <Text dimColor>no findings in this category</Text> : null}
        {list.visible.map((f, i) => {
          const current = list.start + i === list.cursor;
          const badges = f.flags.map(flagBadge).filter((b): b is Badge => b !== null);
          const impact = [
            f.impact.bytes > 0 ? formatBytes(f.impact.bytes) : null,
            f.impact.tokens ? `${formatTokens(f.impact.tokens)} tokens/session` : null,
            plural(f.impact.files, "file"),
            `action: ${f.action.kind}`,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <Box key={f.id} flexDirection="column">
              <Text inverse={current}>
                {current ? "> " : "  "}
                <SeverityBadge severity={f.severity} />
                <Text> {truncate(f.message, width)}</Text>
                <Badges badges={badges} />
              </Text>
              <Text dimColor>
                {"           "}
                {containerLabel(index, f.container)} · {impact}
              </Text>
            </Box>
          );
        })}
        {list.hiddenBelow > 0 ? <Text dimColor>… {list.hiddenBelow} more</Text> : null}
      </Box>
    </Frame>
  );
}
