// THROWAWAY PROTOTYPE (ticket 09) — screen 4: the items of one container (a Project or a
// harness's user scope) or of a finding's target list. Human-owned rows are advice (no
// checkbox, `o` opens, `d`/`u` mark); harness-owned tickable rows carry a checkbox; memory
// units and cache groups expand; live rows are greyed; refused rows show the reason.
import { Box, Text } from "ink";
import { type ReactElement, useState } from "react";
import { Badges } from "../components/Badges.js";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { plural, truncate } from "../lib/format.js";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { type ItemRow, buildRows, containerLabel } from "../lib/rows.js";
import { type ActionKind, canDelete, canUpdate } from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { useList } from "../lib/useList.js";

export function ItemsScreen({
  container,
  title,
  onlyIds,
}: {
  readonly container: string | null;
  readonly title: string;
  readonly onlyIds?: readonly string[] | undefined;
}): ReactElement {
  const store = useStore();
  const { index, marks } = store;
  const { rows: screenRows, columns } = useSize();
  const [filter, setFilter] = useState("");
  const editing = store.filterEditing;

  const rows = buildRows(index, {
    container,
    onlyIds: onlyIds ? new Set(onlyIds) : null,
    expanded: store.expanded,
    showSettings: store.showSettings,
    filter,
    marks,
    home: index.scan.home,
    platform: index.scan.platform,
  });
  const list = useList(
    rows,
    listHeight(screenRows, 1),
    (r) => r.key,
    (r) => r.kind !== "section",
  );

  const toggleAll = (): void => {
    const ids = rows
      .filter((r) => r.kind === "entity" && r.tickable && r.entity)
      .map((r) => r.entity?.id ?? "");
    store.toggleMany(ids, "clean");
  };

  const markRow = (row: ItemRow, action: ActionKind): void => {
    const entity = row.entity;
    if (!entity) return;
    if (action === "delete" && !canDelete(entity)) {
      store.setStatus(
        `${entity.label}: cannot be deleted (${row.live ? "live" : (row.refused ?? entity.protection)})`,
      );
      return;
    }
    if (action === "update" && !canUpdate(entity)) {
      store.setStatus(`${entity.label}: no installer recorded an origin; nothing to update`);
      return;
    }
    store.toggleMark(entity.id, action);
  };

  useKeys((input, key) => {
    if (editing) {
      if (key.return) store.setFilterEditing(false);
      else if (key.escape) {
        setFilter("");
        store.setFilterEditing(false);
      } else if (key.backspace || key.delete) setFilter((f) => f.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setFilter((f) => f + input);
      return;
    }
    const row = list.current;
    if (isUp(input, key)) list.move(-1);
    else if (isDown(input, key)) list.move(1);
    else if (key.pageUp) list.move(-10);
    else if (key.pageDown) list.move(10);
    else if (key.home) list.jump("home");
    else if (key.end) list.jump("end");
    else if (input === "/") store.setFilterEditing(true);
    else if (input === "h") store.toggleSettings();
    else if (input === "a") toggleAll();
    else if (key.escape) {
      if (filter !== "") setFilter("");
      else store.pop();
    } else if (!row) return;
    else if (input === " ") {
      if (row.kind === "group") {
        if (row.childIds.length === 0)
          store.setStatus(`${row.label}: nothing tickable in this group`);
        else store.toggleMany(row.childIds, "clean");
      } else if (row.tickable && row.entity) store.toggleMark(row.entity.id, "clean");
      else if (row.humanOwned && row.entity) store.toggleMark(row.entity.id, "open");
      else if (row.entity) {
        const why = row.live
          ? "live"
          : row.refused
            ? `refused: ${row.refused}`
            : row.sizeOnly
              ? "size only — moldig cannot say what this is"
              : row.entity.kind === "harness-cache" && row.entity.rule === "kept"
                ? "kept by the harness — reach it with d (Delete)"
                : "no action";
        store.setStatus(`${row.label}: not selectable (${why})`);
      }
    } else if (key.return) {
      if (row.kind === "group") store.toggleExpanded(row.key);
      else if (row.entity) store.push({ screen: "detail", id: row.entity.id });
    } else if (key.rightArrow && row.kind === "group") store.setExpanded(row.key, true);
    else if (key.leftArrow && row.kind === "group") store.setExpanded(row.key, false);
    else if (input === "d") markRow(row, "delete");
    else if (input === "u") markRow(row, "update");
    else if (input === "g" && row.entity) store.push({ screen: "graph", focusId: row.entity.id });
    else if (input === "o" && row.entity) store.openPath(row.entity.path);
  }, !store.helpOpen);

  const labelWidth = Math.max(20, Math.min(48, columns - 60));
  const scope = containerLabel(index, container);
  const subtitle = [
    onlyIds ? `${title} · ${scope}` : scope,
    plural(rows.filter((r) => r.kind !== "section").length, "row"),
    editing ? `filter: /${filter}▏` : filter ? `filter: /${filter}` : null,
    store.showSettings ? "settings files shown" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Frame
      title={onlyIds ? "finding" : "items"}
      subtitle={subtitle}
      keys={
        editing
          ? "type to filter · enter keep · esc clear"
          : "space toggle · a all · d delete · u update · enter open/expand · o open · g graph · / filter · h settings · esc back · ? help"
      }
    >
      <Box flexDirection="column">
        {list.hiddenAbove > 0 ? <Text dimColor>… {list.hiddenAbove} above</Text> : null}
        {list.visible.map((row, i) => (
          <RowLine
            key={row.key}
            row={row}
            current={list.start + i === list.cursor}
            marks={marks}
            labelWidth={labelWidth}
          />
        ))}
        {list.hiddenBelow > 0 ? <Text dimColor>… {list.hiddenBelow} more</Text> : null}
        {rows.length === 0 ? (
          <Text dimColor>nothing here{filter ? ` for /${filter}` : ""}</Text>
        ) : null}
      </Box>
    </Frame>
  );
}

function checkbox(row: ItemRow, marks: ReadonlyMap<string, ActionKind>): string {
  if (row.kind === "group") {
    if (row.childIds.length === 0) return "   ";
    const n = row.childIds.filter((id) => marks.get(id) === "clean").length;
    return n === 0 ? "[ ]" : n === row.childIds.length ? "[x]" : "[-]";
  }
  const mark = row.entity ? marks.get(row.entity.id) : undefined;
  if (row.tickable) return mark === "clean" ? "[x]" : mark === "delete" ? "[d]" : "[ ]";
  if (row.refused) return " ✗ ";
  return "   ";
}

export function RowLine({
  row,
  current,
  marks,
  labelWidth,
}: {
  readonly row: ItemRow;
  readonly current: boolean;
  readonly marks: ReadonlyMap<string, ActionKind>;
  readonly labelWidth: number;
}): ReactElement {
  if (row.kind === "section") {
    return (
      <Text bold underline>
        {row.label} <Text dimColor>({row.meta})</Text>
      </Text>
    );
  }
  const mark = row.entity ? marks.get(row.entity.id) : undefined;
  const tag =
    mark === "delete" && !row.tickable
      ? " → Delete"
      : mark === "update"
        ? " → Update"
        : mark === "open"
          ? " → open"
          : mark === "delete" && row.tickable
            ? " → Delete"
            : "";
  const indent = "  ".repeat(Math.max(0, row.depth - 1));
  const caret = row.expandable ? (row.expanded ? "▾ " : "▸ ") : "";
  const label = truncate(`${indent}${caret}${row.label}`, labelWidth);
  return (
    <Text inverse={current} dimColor={row.live || row.sizeOnly}>
      {current ? "> " : "  "}
      <Text {...(row.humanOwned ? { color: "gray" } : {})}>{checkbox(row, marks)}</Text>{" "}
      <Text bold={row.kind === "group"}>{label}</Text>
      <Badges badges={row.badges} />
      {tag ? <Text color="magenta">{tag}</Text> : null}
      {row.humanOwned && !tag ? <Text dimColor> advice · o open</Text> : null}
      <Text dimColor>
        {"  "}
        {row.meta}
      </Text>
      {row.refused ? <Text color="red"> refused: {row.refused} — no trash available</Text> : null}
    </Text>
  );
}
