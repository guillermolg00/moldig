/**
 * Cursor and window for a keyboard-driven list.
 *
 * The cursor is remembered by key so it survives filtering and re-sorting; the window is the
 * slice of `height` items that keeps the cursor visible. Rows a screen marks unselectable
 * (section headers) are skipped by every move.
 */
import { useRef, useState } from "react";

export interface ListState<T> {
  readonly cursor: number;
  readonly current: T | undefined;
  readonly start: number;
  readonly visible: readonly T[];
  readonly hiddenAbove: number;
  readonly hiddenBelow: number;
  readonly move: (delta: number) => void;
  readonly jump: (to: "home" | "end") => void;
  readonly setCursor: (index: number) => void;
}

export function useList<T>(
  items: readonly T[],
  height: number,
  keyOf: (item: T) => string,
  selectable: (item: T) => boolean = () => true,
): ListState<T> {
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [fallback, setFallback] = useState(0);
  const startRef = useRef(0);

  const found = selectedKey === null ? -1 : items.findIndex((item) => keyOf(item) === selectedKey);
  let cursor = found >= 0 ? found : Math.min(fallback, Math.max(0, items.length - 1));
  if (found < 0) {
    // Land on a selectable row: forward first, then backward.
    const forward = items.findIndex((item, i) => i >= cursor && selectable(item));
    if (forward >= 0) {
      cursor = forward;
    } else {
      for (let i = cursor; i >= 0; i--) {
        const item = items[i];
        if (item !== undefined && selectable(item)) {
          cursor = i;
          break;
        }
      }
    }
  }

  const rows = Math.max(1, height);
  let start = startRef.current;
  if (cursor < start) start = cursor;
  else if (cursor >= start + rows) start = cursor - rows + 1;
  start = Math.max(0, Math.min(start, Math.max(0, items.length - rows)));
  startRef.current = start;

  const setCursor = (index: number): void => {
    const clamped = Math.max(0, Math.min(index, items.length - 1));
    setFallback(clamped);
    const item = items[clamped];
    setSelectedKey(item === undefined ? null : keyOf(item));
  };

  const move = (delta: number): void => {
    const step = delta < 0 ? -1 : 1;
    let next = cursor;
    for (let remaining = Math.abs(delta); remaining > 0; remaining--) {
      let probe = next + step;
      while (probe >= 0 && probe < items.length) {
        const item = items[probe];
        if (item !== undefined && selectable(item)) break;
        probe += step;
      }
      if (probe < 0 || probe >= items.length) break;
      next = probe;
    }
    setCursor(next);
  };

  const jump = (to: "home" | "end"): void => {
    if (to === "home") {
      const first = items.findIndex((item) => selectable(item));
      setCursor(first >= 0 ? first : 0);
      return;
    }
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item !== undefined && selectable(item)) {
        setCursor(i);
        return;
      }
    }
  };

  return {
    cursor,
    current: items[cursor],
    start,
    visible: items.slice(start, start + rows),
    hiddenAbove: start,
    hiddenBelow: Math.max(0, items.length - start - rows),
    move,
    jump,
    setCursor,
  };
}
