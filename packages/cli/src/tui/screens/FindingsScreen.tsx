/**
 * Screen 5 — Category findings: the Findings of one Category with severity, message, container
 * and impact; `enter` opens the target rows with the Items screen's mechanics.
 *
 * The order is the one `moldig audit` prints — Category, then the pinned flags, then impact
 * descending (`displayOrder` in `report.ts`, D85). Severity is a badge, never the sort key.
 */
import type { Category, Finding } from "@moldig/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { displayOrder } from "../../report.js";
import { Badges, SeverityBadge } from "../components/Badges.js";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { categoryLabel, formatBytes, formatTokens, plural, truncate } from "../lib/format.js";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { containerLabel } from "../lib/rows.js";
import { type Badge, entityById, flagBadge } from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { useList } from "../lib/use-list.js";

function targetIds(finding: Finding): string[] {
  return finding.targets.map((target) => target.id).filter((id): id is string => id !== undefined);
}

export function FindingsScreen({ category }: { readonly category: Category }): ReactElement {
  const store = useStore();
  const { index } = store;
  const { rows: screenRows, columns } = useSize();
  const findings = displayOrder(index.findings.filter((finding) => finding.category === category));
  const list = useList(findings, listHeight(screenRows, 1), (finding) => finding.id);
  // D130: `a` on a duplicate or drift target list marks every copy for Update.
  const updateAll = category === "duplicate" || category === "drift";

  useKeys((input, key) => {
    const finding = list.current;
    if (isUp(input, key)) list.move(-1);
    else if (isDown(input, key)) list.move(1);
    else if (key.pageUp) list.move(-10);
    else if (key.pageDown) list.move(10);
    else if (key.home) list.jump("home");
    else if (key.end) list.jump("end");
    else if (key.escape) store.pop();
    else if (finding === undefined) return;
    else if (key.return) {
      store.push({
        screen: "items",
        container: finding.container,
        title: finding.message,
        onlyIds: targetIds(finding),
        updateAll,
      });
    } else if (input === "g") {
      const first = targetIds(finding)[0];
      if (first !== undefined) store.push({ screen: "graph", focusId: first });
    } else if (input === "o") {
      const first = targetIds(finding)[0];
      const entity = first === undefined ? undefined : entityById(index, first);
      if (entity !== undefined) store.openPath(entity.path);
    }
  }, !store.helpOpen);

  const width = Math.max(30, columns - 46);

  return (
    <Frame
      title={`${categoryLabel(category)} · ${plural(findings.length, "finding")}`}
      keys="↑↓ move · enter targets · g graph · o open · esc back · ? help · q quit"
    >
      <Box flexDirection="column">
        {findings.length === 0 ? <Text dimColor>no findings in this category</Text> : null}
        {list.visible.map((finding, i) => {
          const current = list.start + i === list.cursor;
          const badges = finding.flags
            .map(flagBadge)
            .filter((badge): badge is Badge => badge !== null);
          const impact = [
            finding.impact.bytes > 0 ? formatBytes(finding.impact.bytes) : null,
            finding.impact.tokens ? `${formatTokens(finding.impact.tokens)} tokens/session` : null,
            plural(finding.impact.files, "file"),
            `action: ${finding.action.kind}`,
          ]
            .filter(Boolean)
            .join(" · ");
          return (
            <Box key={finding.id} flexDirection="column">
              <Text inverse={current}>
                {current ? "> " : "  "}
                <SeverityBadge severity={finding.severity} />
                <Text> {truncate(finding.message, width)}</Text>
                <Badges badges={badges} />
              </Text>
              <Text dimColor>
                {"           "}
                {containerLabel(index, finding.container)} · {impact}
              </Text>
            </Box>
          );
        })}
        {list.hiddenBelow > 0 ? <Text dimColor>… {list.hiddenBelow} more</Text> : null}
      </Box>
    </Frame>
  );
}
