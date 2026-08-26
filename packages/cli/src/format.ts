/**
 * Number and table formatting for the human reports. Everything here is pure: the width comes
 * in as an argument so the same table can be rendered at 80 columns in a pipe and wider on a
 * terminal. Tables never wrap inside a cell — a cell that does not fit is truncated with `…`
 * (spec § "the exact column layout … is the ticket's").
 */

/** U+2009 THIN SPACE: the thousands separator of every token count moldig prints. */
const THIN = " ";

/** SGR escape sequences a palette may have wrapped a cell in; they occupy no columns. */
// oxlint-disable-next-line no-control-regex -- measuring around SGR is this regex's job
const SGR = /\u001B\[[\d;]*m/gu;

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;

function scaled(value: number, unit: string): string {
  return `${value < 100 ? value.toFixed(1) : Math.round(value).toString()} ${unit}`;
}

/** `123 B` · `4.2 KB` · `12.3 MB` · `810 MB` · `1.4 GB`. One decimal below 100 of a unit. */
export function formatBytes(bytes: number): string {
  if (bytes >= GB) return scaled(bytes / GB, "GB");
  if (bytes >= MB) return scaled(bytes / MB, "MB");
  if (bytes >= KB) return scaled(bytes / KB, "KB");
  return `${Math.round(bytes)} B`;
}

/** `1234567` → `1 234 567`, grouped with thin spaces. */
export function formatTokens(tokens: number): string {
  const digits = Math.round(tokens).toString();
  let out = "";
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += THIN;
    out += digits[i];
  }
  return out;
}

/** `100`–`120` as one range; a range whose ends are equal collapses to the single number. */
export function formatRange(low: number, high: number): string {
  return low === high ? formatTokens(low) : `${formatTokens(low)}–${formatTokens(high)}`;
}

/** `1.8 %`, `12 %`; whole numbers lose the decimal. */
export function formatPercent(percent: number): string {
  return `${Number.isInteger(percent) ? percent.toString() : percent.toFixed(1)} %`;
}

export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

/**
 * Printable width of `text`, ignoring the SGR sequences a palette may have wrapped it in. Good
 * enough for the reports: they carry no wide (CJK) or combining characters of moldig's own,
 * and a path that does gets its column widened, never split.
 */
export function width(text: string): number {
  return Array.from(text.replaceAll(SGR, "")).length;
}

/** Pads to `to` columns, counting the printable width only. */
export function pad(text: string, to: number, align: "left" | "right" = "left"): string {
  const filler = " ".repeat(Math.max(0, to - width(text)));
  return align === "right" ? filler + text : text + filler;
}

/** Truncates to `to` printable columns with `…`. Only ever called on unstyled text. */
export function truncate(text: string, to: number): string {
  if (to <= 0) return "";
  const chars = Array.from(text);
  if (chars.length <= to) return text;
  return (
    chars
      .slice(0, Math.max(0, to - 1))
      .join("")
      .trimEnd() + "…"
  );
}

/** A cell is one line, always: a message carrying a newline of its own is folded, not wrapped. */
export function oneLine(text: string): string {
  return text.replaceAll(/\s+/gu, " ").trim();
}

export interface Column {
  /** Column heading; `""` renders no heading. */
  header: string;
  align?: "left" | "right";
  /** The column that absorbs the leftover width and is truncated when the table is too wide. */
  flex?: boolean;
}

/**
 * Renders `rows` as space-separated columns that fit in `total` columns. Column widths come
 * from the content; when the table is wider than `total` the `flex` column gives up the excess
 * and its cells are truncated. Styling is applied by the caller, so cells may carry SGR codes.
 */
export function table(
  columns: readonly Column[],
  rows: readonly string[][],
  total: number,
): string[] {
  if (rows.length === 0) return [];
  const gap = 2;
  const body = rows.map((row) => row.map(oneLine));
  const widths = columns.map((column, i) =>
    Math.max(width(column.header), ...body.map((row) => width(row[i] ?? ""))),
  );
  const flex = columns.findIndex((column) => column.flex === true);
  if (flex !== -1) {
    const others = widths.reduce((sum, w, i) => (i === flex ? sum : sum + w), 0);
    const room = total - others - gap * (columns.length - 1);
    // Never wider than its content, never narrower than 12 columns: the cell is truncated, not
    // wrapped, and a table that cannot fit overflows by those 12 columns rather than mangling.
    widths[flex] = Math.min(widths[flex] ?? 0, Math.max(12, room));
  }
  const render = (cells: readonly string[]): string =>
    columns
      .map((column, i) => {
        const target = widths[i] ?? 0;
        const cell = cells[i] ?? "";
        return pad(width(cell) > target ? truncate(cell, target) : cell, target, column.align);
      })
      .join(" ".repeat(gap))
      .trimEnd();
  const heading = columns.some((column) => column.header !== "")
    ? [render(columns.map((c) => c.header))]
    : [];
  return [...heading, ...body.map(render)];
}
