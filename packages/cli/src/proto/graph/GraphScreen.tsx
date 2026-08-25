/**
 * THROWAWAY PROTOTYPE — ticket 13 (ego-graph screen), folded into ticket 09.
 *
 * The ego-graph of the focused item (an entity, a harness or a project) over the five
 * legend edge kinds, in three layouts: grouped columns (incoming | FOCUS | outgoing),
 * an outline (indented tree by edge kind, hop 2 indented further) and a radial
 * picture (up to 8 hop-1 neighbours around the focus). Everything fits 80 columns and
 * windows itself into a 24-row terminal: header 2 rows, body, footer 2 rows, and room
 * left for the shell's own Frame (title, two-number header, status, keys).
 */
import type { AuditIndex } from "@moldig/core";
import { Box, Text, useInput, useStdout } from "ink";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { buildEgoGraph, MAX_HOPS } from "./ego-graph.js";
import { LAYOUTS, legendText, renderLayout, type LayoutId, type Line } from "./layouts.js";

export interface GraphScreenProps {
  index: AuditIndex;
  focusId: string;
  onFocus(id: string): void;
  onOpen(id: string): void;
  onBack(): void;
}

/** One line per key, for the shell's help overlay. */
export const graphHelp: readonly string[] = [
  "↑/↓ or j/k   move through the neighbours",
  "enter        focus the highlighted neighbour",
  "o            open the highlighted item (the focus when there is none)",
  "+ / -        widen / narrow the neighbourhood (1 or 2 hops)",
  "L            switch layout: columns → outline → radial",
  "home / end   first / last neighbour",
  "pgup / pgdn  move a screen at a time",
  "esc          back",
];

const MAX_WIDTH = 80;
const MIN_ROWS = 24;
/** Header (2) + footer (2) + the shell Frame's four rows + one spare row. */
const CHROME_ROWS = 9;
const KEYS_HINT = "↑↓ move · enter focus · o open · +/- hops · L layout · esc back · ? help";

export function GraphScreen(props: GraphScreenProps): React.JSX.Element {
  const { index, focusId } = props;
  const { stdout } = useStdout();
  // Re-lay out on resize (stdout.columns / rows are read on every render).
  const [, setResizes] = useState(0);
  useEffect(() => {
    const onResize = (): void => setResizes((n) => n + 1);
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);
  const width = Math.min(MAX_WIDTH, stdout.columns || MAX_WIDTH);
  const rows = Math.max(MIN_ROWS, stdout.rows || MIN_ROWS);
  const bodyHeight = rows - CHROME_ROWS;

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

  useInput((input, key) => {
    if (key.escape) {
      props.onBack();
      return;
    }
    if (key.upArrow || input === "k") {
      setCursor(cursor - 1);
      return;
    }
    if (key.downArrow || input === "j") {
      setCursor(cursor + 1);
      return;
    }
    if (key.pageUp) {
      setCursor(cursor - bodyHeight);
      return;
    }
    if (key.pageDown) {
      setCursor(cursor + bodyHeight);
      return;
    }
    if (key.home) {
      setCursor(0);
      return;
    }
    if (key.end) {
      setCursor(count - 1);
      return;
    }
    if (key.return) {
      if (current && current.node.kind !== "unresolved") props.onFocus(current.node.id);
      return;
    }
    if (input === "o") {
      if (!current) props.onOpen(focusId);
      else if (current.node.kind !== "unresolved") props.onOpen(current.node.id);
      return;
    }
    if (input === "+" || input === "=") {
      setHops((h) => Math.min(MAX_HOPS, h + 1));
      return;
    }
    if (input === "-") {
      setHops((h) => Math.max(1, h - 1));
      return;
    }
    if (input === "L" || input === "l") {
      setLayout((l) => LAYOUTS[(LAYOUTS.indexOf(l) + 1) % LAYOUTS.length] ?? "columns");
    }
  });

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
        <LineView key={i} line={line} />
      ))}
      <Text dimColor wrap="truncate-end">
        {stats.join(" · ")}
      </Text>
      <Text dimColor wrap="truncate-end">
        {KEYS_HINT}
      </Text>
    </Box>
  );
}

function LineView({ line }: { line: Line }): React.JSX.Element {
  // An empty <Text> is zero rows high in Ink; a single space keeps the row.
  if (line.segments.every((s) => s.text === "")) return <Text> </Text>;
  return (
    <Text wrap="truncate-end">
      {line.segments.map((s, j) => (
        <Text
          key={j}
          dimColor={s.dim}
          bold={s.bold}
          inverse={s.inverse}
          {...(s.color === undefined ? {} : { color: s.color })}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  );
}
