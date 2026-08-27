/**
 * The quiet frame every screen renders in: one title, an optional subtitle, the body, a status
 * line and only the keys relevant to the current step. The help overlay replaces the body.
 */
import { Box, Text, useWindowSize } from "ink";
import type { ReactElement, ReactNode } from "react";
import { formatMb, formatTokens } from "../lib/format.js";
import { selectedTotals, type ActionKind } from "../lib/selection.js";
import { useStore, type Store } from "../lib/store.js";
import { HelpOverlay } from "./HelpOverlay.js";

export function useSize(): { readonly rows: number; readonly columns: number } {
  const size = useWindowSize();
  const rows = Number.isFinite(size.rows) && size.rows > 0 ? size.rows : 24;
  const columns = Number.isFinite(size.columns) && size.columns > 0 ? size.columns : 80;
  return { rows, columns };
}

/** Rows left for a list once the frame's own lines (`reserved`) are taken. */
export function listHeight(rows: number, reserved: number): number {
  return Math.max(3, rows - 4 - reserved);
}

export function twoNumberHeader(store: {
  readonly index: Store["index"];
  readonly marks: ReadonlyMap<string, ActionKind>;
}): string {
  const { bytes, tokens } = selectedTotals(store.index, store.marks);
  const selected = Object.values(tokens).reduce((sum, count) => sum + count, 0);
  const total = store.index.headline.perHarness.reduce((sum, entry) => sum + entry.total.mid, 0);
  return `selected ${formatMb(bytes)} / ${formatMb(store.index.totals.bytes)} · ${formatTokens(selected)} / ${formatTokens(total)} tokens/session`;
}

export function Frame({
  title,
  keys,
  subtitle,
  children,
}: {
  readonly title: string;
  readonly keys: string;
  readonly subtitle?: string;
  readonly children: ReactNode;
}): ReactElement {
  const store = useStore();
  const { columns } = useSize();
  return (
    <Box flexDirection="column" width={columns}>
      <Box flexDirection="column" paddingBottom={1}>
        <Text>
          <Text bold color="cyan">
            moldig
          </Text>
          <Text dimColor> · {title}</Text>
        </Text>
        {subtitle === undefined ? null : <Text dimColor>{subtitle}</Text>}
      </Box>
      <Box flexDirection="column" overflowY="hidden">
        {store.helpOpen ? <HelpOverlay /> : children}
      </Box>
      {store.status === null ? null : <Text color="yellow">{store.status}</Text>}
      <Text dimColor>{store.helpOpen ? "press any key to close" : keys}</Text>
    </Box>
  );
}
