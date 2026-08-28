/** One machine-wide, deduplicated Update Plan; unsupported items stay visible with a reason. */
import type { PlanRow, UpdateNotice } from "@moldig/core";
import { Box, Text } from "ink";
import { type ReactElement, useState } from "react";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { plural, truncate } from "../lib/format.js";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { useStore } from "../lib/store.js";
import { useList } from "../lib/use-list.js";

interface NoticeGroup {
  readonly key: string;
  readonly kind: UpdateNotice["kind"];
  readonly reason: string;
  readonly labels: readonly string[];
  readonly count: number;
}

type Row =
  | { readonly kind: "ready"; readonly key: string; readonly row: PlanRow }
  | { readonly kind: "notice"; readonly key: string; readonly notice: NoticeGroup };

function noticeGroups(notices: readonly UpdateNotice[]): NoticeGroup[] {
  const grouped = new Map<string, NoticeGroup>();
  for (const notice of notices) {
    const key = `${notice.kind}:${notice.reason}`;
    const current = grouped.get(key);
    const labels = [...(current?.labels ?? []), notice.label].toSorted((left, right) =>
      left.localeCompare(right),
    );
    grouped.set(key, {
      key,
      kind: notice.kind,
      reason: notice.reason,
      labels,
      count: labels.length,
    });
  }
  const order: Readonly<Record<UpdateNotice["kind"], number>> = {
    excluded: 0,
    managed: 1,
    unsupported: 2,
  };
  return [...grouped.values()].toSorted(
    (left, right) =>
      order[left.kind] - order[right.kind] ||
      right.count - left.count ||
      left.reason.localeCompare(right.reason),
  );
}

function noticeLabel(kind: UpdateNotice["kind"]): string {
  if (kind === "managed") return "managed";
  if (kind === "excluded") return "excluded";
  return "no updater";
}

export function UpdatePlanScreen({
  standalone = false,
}: {
  readonly standalone?: boolean;
}): ReactElement {
  const store = useStore();
  const { rows: terminalRows, columns } = useSize();
  const [update] = useState(() => store.runner.planUpdateAll());
  const ready = update.plan.groups
    .filter((group) => group.action === "update")
    .flatMap((group) => group.rows);
  const rows: Row[] = [
    ...ready.map((row) => ({ kind: "ready" as const, key: `ready:${row.key}`, row })),
    ...noticeGroups(update.notices).map((notice) => ({
      kind: "notice" as const,
      key: `notice:${notice.key}`,
      notice,
    })),
  ];
  const list = useList(rows, listHeight(terminalRows, 6), (row) => row.key);

  useKeys((input, key) => {
    if (isUp(input, key)) list.move(-1);
    else if (isDown(input, key)) list.move(1);
    else if (key.home) list.jump("home");
    else if (key.end) list.jump("end");
    else if (key.pageUp) list.move(-10);
    else if (key.pageDown) list.move(10);
    else if (key.return) {
      if (ready.length === 0) {
        store.setStatus("nothing has a runnable updater");
        return;
      }
      store.push({ screen: "confirm", runPlan: update.plan, afterRun: "inventory" });
    } else if (key.escape) {
      if (standalone) store.quit();
      else store.pop();
    }
  }, !store.helpOpen);

  const counts = update.counts;
  const readyText = [
    counts.skillsReady > 0 ? plural(counts.skillsReady, "Skill") : null,
    counts.mcpServersReady > 0 ? plural(counts.mcpServersReady, "MCP server") : null,
    counts.pluginsReady > 0 ? plural(counts.pluginsReady, "plugin") : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" · ");
  const labelWidth = Math.max(24, Math.min(48, columns - 42));

  return (
    <Frame
      title="update all"
      subtitle={`${plural(counts.batches, "updater run")} ready${readyText === "" ? "" : ` · ${readyText}`}`}
      keys={`↑↓ inspect   enter continue   esc ${standalone ? "cancel" : "back"}`}
    >
      <Box flexDirection="column">
        <Text dimColor>
          One run per Installer scope or Docker target. Local Skill changes and unknown updaters
          stay.
        </Text>
        <Box flexDirection="column" paddingTop={1}>
          {list.visible.map((item, offset) => {
            const current = list.start + offset === list.cursor;
            if (item.kind === "ready") {
              return (
                <Text key={item.key} {...(current ? { color: "cyan" as const } : {})}>
                  {current ? "› " : "  "}
                  <Text color="green">[ready] </Text>
                  {truncate(item.row.target.label, labelWidth).padEnd(labelWidth)}
                  <Text dimColor={!current}>
                    {" "}
                    {truncate(
                      item.row.disposition.display,
                      Math.max(18, columns - labelWidth - 14),
                    )}
                  </Text>
                </Text>
              );
            }
            return (
              <Text key={item.key} {...(current ? { color: "cyan" as const } : {})}>
                {current ? "› " : "  "}
                <Text {...(item.notice.kind === "excluded" ? { color: "yellow" as const } : {})}>
                  [{noticeLabel(item.notice.kind)}]{" "}
                </Text>
                {truncate(item.notice.reason, labelWidth + 12).padEnd(labelWidth + 12)}
                <Text dimColor={!current}> {plural(item.notice.count, "item")}</Text>
              </Text>
            );
          })}
          {list.hiddenBelow > 0 ? <Text dimColor>… {list.hiddenBelow} more</Text> : null}
        </Box>
        {list.current?.kind === "notice" ? (
          <Box paddingTop={1}>
            <Text dimColor>
              items: {truncate(list.current.notice.labels.join(", "), Math.max(20, columns - 10))}
            </Text>
          </Box>
        ) : null}
        <Box paddingTop={1}>
          <Text bold>
            {ready.length === 0
              ? "Nothing has a runnable updater."
              : `Enter continues to one confirmation for ${plural(counts.batches, "updater run")}. Network access is expected.`}
          </Text>
        </Box>
      </Box>
    </Frame>
  );
}
