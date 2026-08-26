/**
 * The graph screen (ticket 13): the ego-graph of the focused item — an entity, a harness or a
 * Project — over the five legend edge kinds, in two text layouts (grouped columns by default,
 * an outline for narrow terminals; radial is not shipped, D129).
 *
 * It draws its own two header rows and two footer rows instead of the shell `Frame`, and
 * windows itself into `min(24, rows)` (D129) so it never outgrows a small terminal.
 */
import { Box, Text, useWindowSize } from "ink";
import { type ReactElement, useMemo, useState } from "react";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { useStore } from "../lib/store.js";
import { buildEgoGraph, MAX_HOPS, type EgoNode } from "./ego-graph.js";
import { LAYOUTS, legendText, renderLayout, type LayoutId, type Line } from "./layouts.js";

/** One line per key, for the shell's help overlay. */
export const graphHelp: readonly string[] = [
  "↑/↓ or j/k   move through the neighbours",
  "enter        focus the highlighted neighbour",
  "o            open the highlighted item in the editor (the focus when there is none)",
  "+ / -        widen / narrow the neighbourhood (1 or 2 hops)",
  "L            switch layout: columns → outline",
  "home / end   first / last neighbour",
  "pgup / pgdn  move a screen at a time",
  "esc          back",
];

const MAX_WIDTH = 80;
const MAX_ROWS = 24;
/** Header (2) + footer (2) + the shell's own four rows + one spare. */
const CHROME_ROWS = 9;
const KEYS_HINT = "↑↓ move · enter focus · o open · +/- hops · L layout · esc back · ? help";

export function GraphScreen({ focusId }: { readonly focusId: string }): ReactElement {
  const store = useStore();
  const { index } = store;
  const size = useWindowSize();
  const width = Math.min(MAX_WIDTH, size.columns > 0 ? size.columns : MAX_WIDTH);
  const rows = Math.max(12, Math.min(MAX_ROWS, size.rows > 0 ? size.rows : MAX_ROWS));
  const bodyHeight = Math.max(3, rows - CHROME_ROWS);

  const [hops, setHops] = useState(1);
  const [layout, setLayout] = useState<LayoutId>("columns");
  // The cursor is keyed by the focus so a new focus starts at the first neighbour.
  const [cursorState, setCursorState] = useState({ focusId, index: 0 });

  const graph = useMemo(() => buildEgoGraph(index, focusId, hops), [index, focusId, hops]);
  const count = graph.neighbours.length;
  const cursor =
    cursorState.focusId === focusId ? Math.min(cursorState.index, Math.max(0, count - 1)) : 0;
  const current = graph.neighbours[cursor];

  const setCursor = (next: number): void => {
    setCursorState({ focusId, index: Math.max(0, Math.min(count - 1, next)) });
  };

  /** Where a node lives on disk: an entity's path, a Project's directory, a harness's config. */
  const pathOf = (node: EgoNode): string | null => {
    const entity = index.entities.find((item) => item.id === node.id);
    if (entity) return entity.path;
    const project = index.projects.find((item) => item.id === node.id);
    if (project) return project.path;
    const harness = index.harnesses.find((item) => item.id === node.id);
    return harness?.userScope.paths[0]?.path ?? null;
  };

  useKeys((input, key) => {
    if (key.escape) store.pop();
    else if (isUp(input, key)) setCursor(cursor - 1);
    else if (isDown(input, key)) setCursor(cursor + 1);
    else if (key.pageUp) setCursor(cursor - bodyHeight);
    else if (key.pageDown) setCursor(cursor + bodyHeight);
    else if (key.home) setCursor(0);
    else if (key.end) setCursor(count - 1);
    else if (key.return) {
      // D129: enter focuses the neighbour; a tool configured nowhere cannot be focused.
      if (current && current.node.kind !== "unresolved") {
        store.replace({ screen: "graph", focusId: current.node.id });
      }
    } else if (input === "o") {
      const node = current?.node ?? graph.focus;
      const path = node.kind === "unresolved" ? null : pathOf(node);
      if (path === null) store.setStatus(`${node.label}: not selectable (no action)`);
      else store.openPath(path);
    } else if (input === "+" || input === "=") setHops((h) => Math.min(MAX_HOPS, h + 1));
    else if (input === "-") setHops((h) => Math.max(1, h - 1));
    else if (input === "L" || input === "l") {
      setLayout(
        (current_) => LAYOUTS[(LAYOUTS.indexOf(current_) + 1) % LAYOUTS.length] ?? "columns",
      );
    }
  }, !store.helpOpen);

  const lines = renderLayout(layout, graph, {
    width,
    height: bodyHeight,
    selectedId: current?.node.id ?? null,
  });

  const header = `graph · ${graph.focus.label} · ${graph.hops} hop${graph.hops > 1 ? "s" : ""} · ${layout}`;
  const stats = [`${count} neighbour${count === 1 ? "" : "s"}`];
  if (graph.omitted > 0) stats.push(`…and ${graph.omitted} more`);
  if (graph.hiddenEdges > 0) {
    stats.push(`+${graph.hiddenEdges} other edge${graph.hiddenEdges === 1 ? "" : "s"} hidden`);
  }
  if (current) stats.push(`on: ${current.node.label}`);

  return (
    <Box flexDirection="column" width={width}>
      <Text bold wrap="truncate-end">
        {header}
      </Text>
      <Text dimColor wrap="truncate-end">
        {legendText()}
      </Text>
      {lines.map((line, i) => (
        <LineView key={String(i)} line={line} />
      ))}
      {store.status === null ? null : <Text color="green">{store.status}</Text>}
      <Text dimColor wrap="truncate-end">
        {stats.join(" · ")}
      </Text>
      <Text dimColor wrap="truncate-end">
        {KEYS_HINT}
      </Text>
    </Box>
  );
}

function LineView({ line }: { readonly line: Line }): ReactElement {
  // An empty <Text> is zero rows high in Ink; a single space keeps the row.
  if (line.segments.every((segment) => segment.text === "")) return <Text> </Text>;
  return (
    <Text wrap="truncate-end">
      {line.segments.map((segment, i) => (
        <Text
          key={String(i)}
          dimColor={segment.dim}
          bold={segment.bold}
          inverse={segment.inverse}
          {...(segment.color === undefined ? {} : { color: segment.color })}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}
