/**
 * The text layouts of the graph screen (ticket 13). Every layout returns lines of styled
 * segments that already fit `view.width` (labels truncated with an ellipsis) and `view.height`
 * (lists windowed around the selected row), so the Ink component only paints them.
 *
 * Two layouts ship: grouped `columns` (the default) and the narrow-terminal `outline`; radial
 * is dropped from v1 (D129). Widths are counted in code points — every glyph used here is one
 * cell wide; a label with East Asian wide characters would misalign a column.
 */
import type { HarnessId, Scope } from "@moldig/core";
import {
  LEGEND_KINDS,
  type Direction,
  type EgoGraph,
  type EgoNeighbour,
  type EgoNode,
  type EgoNodeKind,
  type LegendKind,
  type LoadMode,
} from "./ego-graph.js";

export type LayoutId = "columns" | "outline";
/** `L` cycles these two; radial is not shipped in v1 (D129). */
export const LAYOUTS: readonly LayoutId[] = ["columns", "outline"];

export interface Segment {
  text: string;
  dim: boolean;
  bold: boolean;
  inverse: boolean;
  color: string | undefined;
}
export interface Line {
  segments: Segment[];
}
export interface View {
  width: number;
  height: number;
  /** Node id under the cursor; its row is drawn inverse. */
  selectedId: string | null;
}

export const KIND_GLYPH: Record<EgoNodeKind, string> = {
  "context-file": "≡",
  skill: "◆",
  "mcp-server": "◉",
  "memory-file": "✎",
  "agent-definition": "⚑",
  "harness-cache": "▣",
  plugin: "⊞",
  "settings-file": "§",
  harness: "✱",
  project: "⌂",
  unresolved: "?",
  unknown: "?",
};
export const KIND_LABEL: Record<EgoNodeKind, string> = {
  "context-file": "context file",
  skill: "skill",
  "mcp-server": "MCP server",
  "memory-file": "memory file",
  "agent-definition": "agent definition",
  "harness-cache": "harness cache",
  plugin: "plugin",
  "settings-file": "settings file",
  harness: "harness",
  project: "project",
  unresolved: "configured nowhere",
  unknown: "not in the index",
};
export const EDGE_GLYPH: Record<LegendKind, string> = {
  names: "»",
  "names-tool": "⊳",
  "loaded-by": "↦",
  duplicates: "≈",
  "originates-from": "⇠",
};
/** CONTEXT.md's words for the edge kinds. */
export const EDGE_LABEL: Record<LegendKind, string> = {
  names: "names",
  "names-tool": "names a tool",
  "loaded-by": "loaded by",
  duplicates: "duplicates",
  "originates-from": "originates from",
};
/** Short forms of the loaded-by mode for the 30-column cells of the grouped layout. */
const SHORT_MODE: Record<LoadMode, string> = {
  full: "full",
  "description-only": "desc-only",
  "on-demand": "on-demand",
  manual: "manual",
  never: "never",
  disabled: "disabled",
  shadowed: "shadowed",
  unknown: "unknown",
};
const SCOPE_COLOR: Record<Scope, string> = {
  system: "magenta",
  user: "cyan",
  project: "green",
  local: "yellow",
};

export function legendText(): string {
  return LEGEND_KINDS.map((k) => `${EDGE_GLYPH[k]} ${EDGE_LABEL[k]}`).join("  ");
}

type Style = Partial<Omit<Segment, "text">>;

export function seg(text: string, style: Style = {}): Segment {
  return {
    text,
    dim: style.dim ?? false,
    bold: style.bold ?? false,
    inverse: style.inverse ?? false,
    color: style.color,
  };
}

function restyle(segments: Segment[], style: Style): Segment[] {
  return segments.map((s) =>
    seg(s.text, {
      dim: style.dim ?? s.dim,
      bold: style.bold ?? s.bold,
      inverse: style.inverse ?? s.inverse,
      color: style.color ?? s.color,
    }),
  );
}

export function textWidth(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

export function lineWidth(segments: readonly Segment[]): number {
  return segments.reduce((sum, s) => sum + textWidth(s.text), 0);
}

/** Truncates to `width` cells, ending with an ellipsis when something was cut. */
export function fit(segments: Segment[], width: number): Segment[] {
  if (width <= 0) return [];
  if (lineWidth(segments) <= width) return segments;
  const out: Segment[] = [];
  const limit = width - 1;
  let used = 0;
  for (const s of segments) {
    const chars = Array.from(s.text);
    if (used + chars.length <= limit) {
      out.push(s);
      used += chars.length;
      continue;
    }
    out.push(seg(`${chars.slice(0, limit - used).join("")}…`, s));
    return out;
  }
  return out;
}

function blank(width: number): Segment {
  return seg(" ".repeat(Math.max(0, width)));
}

type Align = "left" | "right" | "center";

function align(segments: Segment[], width: number, how: Align): Segment[] {
  const gap = width - lineWidth(segments);
  if (gap <= 0) return segments;
  if (how === "left") return [...segments, blank(gap)];
  if (how === "right") return [blank(gap), ...segments];
  const left = Math.floor(gap / 2);
  return [blank(left), ...segments, blank(gap - left)];
}

// ---------- rows ----------

interface Row {
  segments: Segment[];
  nodeId: string | null;
}

/** What every row needs to know about the graph it belongs to. */
interface Ctx {
  focusHarness: HarnessId | null;
  /** Harness tags are noise when the whole neighbourhood belongs to one harness. */
  tagHarness: boolean;
}

function ctxOf(graph: EgoGraph): Ctx {
  const harnesses = new Set<string>();
  for (const n of graph.neighbours) {
    if (n.node.kind !== "harness" && n.node.harness !== null) harnesses.add(n.node.harness);
  }
  return {
    focusHarness: graph.focus.harness,
    tagHarness: graph.focus.harness !== null || harnesses.size > 1,
  };
}

function nodeSegments(node: EgoNode, ctx: Ctx): Segment[] {
  const segs = [seg(`${KIND_GLYPH[node.kind]} ${node.label}`)];
  if (node.scope !== null) segs.push(seg(` [${node.scope}]`, { color: SCOPE_COLOR[node.scope] }));
  if (
    ctx.tagHarness &&
    node.harness !== null &&
    node.harness !== ctx.focusHarness &&
    node.kind !== "harness"
  ) {
    segs.push(seg(` ${node.harness}`, { dim: true }));
  }
  if (node.shared) segs.push(seg(" shared", { color: "yellow" }));
  if (node.dangling) segs.push(seg(" dangling", { color: "red" }));
  if (node.live) segs.push(seg(" live", { color: "magenta" }));
  return segs;
}

function arrow(direction: Direction): string {
  return direction === "incoming" ? "←" : "→";
}

interface RowOptions {
  arrow: boolean;
  /** Narrow cell: short mode, confidence only when it is worth a warning. */
  compact: boolean;
}

/** One neighbour: direction, node, loaded-by mode, confidence; dimmed below high. */
function neighbourSegments(n: EgoNeighbour, ctx: Ctx, options: RowOptions): Segment[] {
  const weak = n.confidence === "medium" || n.confidence === "low";
  const segs: Segment[] = [];
  if (options.arrow) segs.push(seg(`${arrow(n.direction)} `));
  segs.push(...nodeSegments(n.node, ctx));
  if (n.mode !== null) segs.push(seg(` · ${options.compact ? SHORT_MODE[n.mode] : n.mode}`));
  if (!options.compact || weak) segs.push(seg(` · ${n.confidence}`, { dim: true }));
  return weak ? restyle(segs, { dim: true }) : segs;
}

function header(text: string): Row {
  return { segments: [seg(text, { bold: true })], nodeId: null };
}

function note(text: string): Row {
  return { segments: [seg(text, { dim: true })], nodeId: null };
}

function highlight(rows: Row[], selectedId: string | null): Row[] {
  return rows.map((r) =>
    r.nodeId !== null && r.nodeId === selectedId
      ? { nodeId: r.nodeId, segments: restyle(r.segments, { inverse: true }) }
      : r,
  );
}

/** Keeps the selected row visible inside `height` rows, with "⋯ N more" indicators. */
function windowRows(rows: Row[], selectedId: string | null, height: number): Row[] {
  if (height <= 0) return [];
  if (rows.length <= height) return rows;
  const selected = rows.findIndex((r) => r.nodeId !== null && r.nodeId === selectedId);
  const anchor = selected < 0 ? 0 : selected;
  if (height < 3) {
    const start = Math.max(0, Math.min(anchor, rows.length - height));
    return rows.slice(start, start + height);
  }
  const inner = height - 2;
  const start = Math.max(0, Math.min(anchor - Math.floor(inner / 2), rows.length - inner));
  const below = rows.length - start - inner;
  return [
    note(start > 0 ? `⋯ ${start} more above` : ""),
    ...rows.slice(start, start + inner),
    note(below > 0 ? `⋯ ${below} more below` : ""),
  ];
}

function toLines(rows: Row[]): Line[] {
  return rows.map((r) => ({ segments: r.segments }));
}

// ---------- (2) outline ----------

function outlineRows(graph: EgoGraph, ctx: Ctx): Row[] {
  const options: RowOptions = { arrow: true, compact: false };
  const rows: Row[] = [
    {
      segments: [
        ...restyle(nodeSegments(graph.focus, ctx), { bold: true }),
        seg(` · ${KIND_LABEL[graph.focus.kind]}`, { dim: true }),
      ],
      nodeId: null,
    },
  ];
  const hop1 = graph.neighbours.filter((n) => n.hop === 1);
  const children = new Map<string, EgoNeighbour[]>();
  for (const n of graph.neighbours) {
    if (n.hop === 1) continue;
    const list = children.get(n.via);
    if (list) list.push(n);
    else children.set(n.via, [n]);
  }
  const addChildren = (viaId: string, depth: number): void => {
    for (const c of children.get(viaId) ?? []) {
      rows.push({
        segments: [
          seg(`${"  ".repeat(depth)}  ↳ `),
          ...neighbourSegments(c, ctx, options),
          seg(` ‹${EDGE_LABEL[c.kind]}›`, { dim: true }),
        ],
        nodeId: c.node.id,
      });
      addChildren(c.node.id, depth + 1);
    }
  };
  for (const kind of LEGEND_KINDS) {
    const group = hop1.filter((n) => n.kind === kind);
    if (group.length === 0) continue;
    rows.push(header(`${EDGE_GLYPH[kind]} ${EDGE_LABEL[kind]} (${group.length})`));
    for (const n of group) {
      rows.push({
        segments: [seg("  "), ...neighbourSegments(n, ctx, options)],
        nodeId: n.node.id,
      });
      addChildren(n.node.id, 1);
    }
  }
  if (hop1.length === 0) rows.push(note("  no edges of the legend kinds"));
  return rows;
}

function outlineLines(graph: EgoGraph, view: View): Line[] {
  const rows = highlight(
    outlineRows(graph, ctxOf(graph)).map((r) => ({
      nodeId: r.nodeId,
      segments: fit(r.segments, view.width),
    })),
    view.selectedId,
  );
  return toLines(windowRows(rows, view.selectedId, view.height));
}

// ---------- (1) grouped columns: incoming | FOCUS | outgoing ----------

function columnsLines(graph: EgoGraph, view: View): Line[] {
  const centreW = view.width >= 80 ? 14 : 12;
  const side = Math.max(10, Math.floor((view.width - 6 - centreW) / 2));
  const ctx = ctxOf(graph);
  const byId = new Map(graph.neighbours.map((n) => [n.node.id, n]));
  const columnOf = (n: EgoNeighbour): Direction => {
    let cur = n;
    while (cur.hop > 1) {
      const via = byId.get(cur.via);
      if (!via) break;
      cur = via;
    }
    return cur.direction;
  };

  const sideRows = (dir: Direction): Row[] => {
    const rows: Row[] = [];
    const hop1 = graph.neighbours.filter((n) => n.hop === 1 && n.direction === dir);
    const deeper = graph.neighbours.filter((n) => n.hop > 1 && columnOf(n) === dir);
    rows.push(header(`${arrow(dir)} ${dir} (${hop1.length})`));
    for (const kind of LEGEND_KINDS) {
      const group = hop1.filter((n) => n.kind === kind);
      if (group.length === 0) continue;
      rows.push(header(`${EDGE_GLYPH[kind]} ${EDGE_LABEL[kind]} (${group.length})`));
      for (const n of group) {
        rows.push({
          segments: [seg("  "), ...neighbourSegments(n, ctx, { arrow: false, compact: true })],
          nodeId: n.node.id,
        });
      }
    }
    if (deeper.length > 0) {
      rows.push(header(`↳ hop 2 (${deeper.length})`));
      for (const n of deeper) {
        rows.push({
          segments: [
            seg("  "),
            ...neighbourSegments(n, ctx, { arrow: true, compact: true }),
            seg(` ‹${EDGE_LABEL[n.kind]} ${byId.get(n.via)?.node.label ?? ""}›`, { dim: true }),
          ],
          nodeId: n.node.id,
        });
      }
    }
    if (hop1.length === 0 && deeper.length === 0) rows.push(note("  none"));
    return rows;
  };

  const focus = graph.focus;
  const focusRows: Row[] = [
    note("FOCUS"),
    { segments: [seg(`${KIND_GLYPH[focus.kind]} ${focus.label}`, { bold: true })], nodeId: null },
    note(KIND_LABEL[focus.kind]),
  ];
  if (focus.scope !== null) {
    focusRows.push({
      segments: [seg(`[${focus.scope}]`, { color: SCOPE_COLOR[focus.scope] })],
      nodeId: null,
    });
  }
  if (focus.harness !== null && focus.kind !== "harness") focusRows.push(note(focus.harness));
  if (focus.shared)
    focusRows.push({ segments: [seg("shared", { color: "yellow" })], nodeId: null });
  if (focus.dangling)
    focusRows.push({ segments: [seg("dangling", { color: "red" })], nodeId: null });
  if (focus.live) focusRows.push({ segments: [seg("live", { color: "magenta" })], nodeId: null });

  const prepare = (rows: Row[], width: number, how: Align): Row[] => {
    const fitted = rows.map((r) => ({ nodeId: r.nodeId, segments: fit(r.segments, width) }));
    const windowed = windowRows(highlight(fitted, view.selectedId), view.selectedId, view.height);
    return windowed.map((r) => ({
      nodeId: r.nodeId,
      segments: align(fit(r.segments, width), width, how),
    }));
  };

  const left = prepare(sideRows("incoming"), side, "left");
  const centre = prepare(focusRows, centreW, "center");
  const right = prepare(sideRows("outgoing"), side, "left");
  const sep = seg(" │ ", { dim: true });
  const lines: Line[] = [];
  const n = Math.min(view.height, Math.max(left.length, centre.length, right.length));
  for (let i = 0; i < n; i++) {
    lines.push({
      segments: [
        ...(left[i]?.segments ?? [blank(side)]),
        sep,
        ...(centre[i]?.segments ?? [blank(centreW)]),
        sep,
        ...(right[i]?.segments ?? [blank(side)]),
      ],
    });
  }
  return lines;
}

const RENDERERS: Record<LayoutId, (graph: EgoGraph, view: View) => Line[]> = {
  columns: columnsLines,
  outline: outlineLines,
};

export function renderLayout(layout: LayoutId, graph: EgoGraph, view: View): Line[] {
  return RENDERERS[layout](graph, view);
}
