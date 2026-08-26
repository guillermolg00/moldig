/**
 * Screen 4 — Items: everything moldig found for one container (a Project or a harness's user
 * scope), or the target rows of one Finding.
 *
 * Human-owned rows are advice: no checkbox, `o` opens them, `d`/`u` mark them. Harness-owned
 * tickable rows carry a checkbox and start ticked only where a Finding preselected them. Memory
 * units and harness-cache groups expand; live and size-only rows are greyed; a refused row
 * carries the reason the actions engine gave.
 */
import { Box, Text } from "ink";
import { type ReactElement, useState } from "react";
import { Badges } from "../components/Badges.js";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { plural, truncate } from "../lib/format.js";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { buildRows, containerLabel, type ItemRow } from "../lib/rows.js";
import { type ActionKind, canDelete, canUpdate } from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { useList } from "../lib/use-list.js";

export function ItemsScreen({
  container,
  title,
  onlyIds,
  updateAll,
}: {
  readonly container: string | null;
  readonly title: string;
  readonly onlyIds?: readonly string[] | undefined;
  readonly updateAll?: boolean | undefined;
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
    refusal: store.refusal,
  });
  const list = useList(
    rows,
    listHeight(screenRows, 1),
    (row) => row.key,
    (row) => row.kind !== "section",
  );

  /**
   * `a` toggles every visible tickable row for Clean; on a duplicate or drift Finding's target
   * list it marks every copy for Update instead (D130).
   */
  const toggleAll = (): void => {
    if (updateAll === true) {
      const ids = rows
        .filter((row) => row.entity !== null && canUpdate(row.entity))
        .map((row) => row.entity?.id ?? "");
      if (ids.length === 0) {
        store.setStatus("no installer recorded an origin; nothing to update");
        return;
      }
      store.toggleMany(ids, "update");
      return;
    }
    const ids = rows
      .filter((row) => row.kind === "entity" && row.tickable && row.entity !== null)
      .map((row) => row.entity?.id ?? "");
    store.toggleMany(ids, "clean");
  };

  const markRow = (row: ItemRow, action: ActionKind): void => {
    const entity = row.entity;
    if (entity === null) return;
    if (action === "delete" && !canDelete(entity, store.refusal)) {
      const why = row.live ? "live" : (row.refused ?? entity.protection);
      store.setStatus(`${entity.label}: cannot be deleted (${why})`);
      return;
    }
    if (action === "update" && !canUpdate(entity)) {
      store.setStatus(`${entity.label}: no installer recorded an origin; nothing to update`);
      return;
    }
    store.toggleMark(entity.id, action);
  };

  const notSelectable = (row: ItemRow): void => {
    const entity = row.entity;
    if (entity === null) return;
    const why = row.live
      ? "live"
      : row.refused !== null
        ? `refused: ${row.refused}`
        : row.sizeOnly
          ? "size only — moldig cannot say what this is"
          : entity.kind === "harness-cache" && entity.rule === "kept"
            ? "kept by the harness — reach it with d (Delete)"
            : "no action";
    store.setStatus(`${row.label}: not selectable (${why})`);
  };

  useKeys((input, key) => {
    if (editing) {
      if (key.return) store.setFilterEditing(false);
      else if (key.escape) {
        setFilter("");
        store.setFilterEditing(false);
      } else if (key.backspace || key.delete) setFilter((text) => text.slice(0, -1));
      else if (input && !key.ctrl && !key.meta) setFilter((text) => text + input);
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
      // A filter is cleared first; a second `esc` pops the screen.
      if (filter !== "") setFilter("");
      else store.pop();
    } else if (row === undefined) return;
    else if (input === " ") {
      if (row.kind === "group") {
        if (row.childIds.length === 0) {
          store.setStatus(`${row.label}: nothing tickable in this group`);
        } else store.toggleMany(row.childIds, "clean");
      } else if (row.tickable && row.entity !== null) store.toggleMark(row.entity.id, "clean");
      else if (row.humanOwned && row.entity !== null) store.toggleMark(row.entity.id, "open");
      else notSelectable(row);
    } else if (key.return) {
      if (row.kind === "group") store.toggleExpanded(row.key);
      else if (row.entity !== null) store.push({ screen: "detail", id: row.entity.id });
    } else if (key.rightArrow && row.kind === "group") store.setExpanded(row.key, true);
    else if (key.leftArrow && row.kind === "group") store.setExpanded(row.key, false);
    else if (input === "d") markRow(row, "delete");
    else if (input === "u") markRow(row, "update");
    else if (input === "g" && row.entity !== null) {
      store.push({ screen: "graph", focusId: row.entity.id });
    } else if (input === "o" && row.entity !== null) store.openPath(row.entity.path);
  }, !store.helpOpen);

  const labelWidth = Math.max(20, Math.min(48, columns - 60));
  const scope = containerLabel(index, container);
  const subtitle = [
    onlyIds ? `${title} · ${scope}` : scope,
    plural(rows.filter((row) => row.kind !== "section").length, "row"),
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
    const ticked = row.childIds.filter((id) => marks.get(id) === "clean").length;
    return ticked === 0 ? "[ ]" : ticked === row.childIds.length ? "[x]" : "[-]";
  }
  const mark = row.entity === null ? undefined : marks.get(row.entity.id);
  if (row.tickable) return mark === "clean" ? "[x]" : mark === "delete" ? "[d]" : "[ ]";
  if (row.refused !== null) return " ✗ ";
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
  const mark = row.entity === null ? undefined : marks.get(row.entity.id);
  const tag =
    mark === "delete"
      ? " → Delete"
      : mark === "update"
        ? " → Update"
        : mark === "open"
          ? " → open"
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
      {row.refused === null ? null : (
        <Text color="red"> refused: {row.refused} — no trash available</Text>
      )}
    </Text>
  );
}
