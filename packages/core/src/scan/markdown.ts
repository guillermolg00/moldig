/**
 * The Markdown facts adapters read: YAML frontmatter (the subset harness files use — scalars,
 * block lists of scalars, inline lists, one level of nested maps), block-level HTML comments
 * (stripped before Claude Code measures a file), `@path` imports (skipped inside code spans and
 * fences) and the markdown-link list items of a memory index.
 */

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 0;
  for (const char of text) if (char === "\n") lines += 1;
  return text.endsWith("\n") ? lines : lines + 1;
}

export interface Frontmatter {
  data: Record<string, unknown>;
  /** Body without the frontmatter block. */
  body: string;
  present: boolean;
}

function parseScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === "") return "";
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (text === "null" || text === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    return inner === "" ? [] : inner.split(",").map((item) => parseScalar(item));
  }
  return text;
}

interface Line {
  indent: number;
  text: string;
}

function parseBlock(
  lines: Line[],
  start: number,
  indent: number,
): [Record<string, unknown>, number] {
  const out: Record<string, unknown> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      i += 1;
      continue;
    }
    const match = /^([^:#][^:]*):(.*)$/.exec(line.text);
    if (match === null) {
      i += 1;
      continue;
    }
    const key = (match[1] ?? "").trim();
    const rest = (match[2] ?? "").trim();
    i += 1;
    if (rest !== "") {
      out[key] = parseScalar(rest);
      continue;
    }
    const next = lines[i];
    if (next === undefined || next.indent <= indent) {
      out[key] = null;
      continue;
    }
    if (next.text.startsWith("- ") || next.text === "-") {
      const items: unknown[] = [];
      while (i < lines.length) {
        const item = lines[i];
        if (item === undefined || item.indent !== next.indent || !item.text.startsWith("-")) break;
        items.push(parseScalar(item.text.slice(1)));
        i += 1;
      }
      out[key] = items;
      continue;
    }
    const [nested, end] = parseBlock(lines, i, next.indent);
    out[key] = nested;
    i = end;
  }
  return [out, i];
}

/** Parses a leading `---` block; unknown shapes yield an empty map rather than an error. */
export function parseFrontmatter(text: string): Frontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (match === null) return { data: {}, body: text, present: false };
  const block = match[1] ?? "";
  const lines: Line[] = block
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"))
    .map((line) => ({ indent: line.length - line.trimStart().length, text: line.trim() }));
  const [data] = parseBlock(lines, 0, lines[0]?.indent ?? 0);
  return { data, body: text.slice(match[0].length), present: true };
}

/** Removes block-level HTML comments (a comment that starts a line), leaving code fences alone. */
export function stripBlockComments(text: string): string {
  const out: string[] = [];
  let inFence = false;
  let inComment = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!inComment && /^(?:```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    if (inComment) {
      if (trimmed.includes("-->")) inComment = false;
      continue;
    }
    if (trimmed.startsWith("<!--")) {
      if (!trimmed.includes("-->")) inComment = true;
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

export interface ImportStatement {
  line: number;
  target: string;
}

/** `@path` imports outside code spans and fences: `@docs/notes.md`, `@~/x.md`, `@/abs/x.md`. */
export function findImports(text: string): ImportStatement[] {
  const out: ImportStatement[] = [];
  let inFence = false;
  text.split("\n").forEach((rawLine, index) => {
    const trimmed = rawLine.trim();
    if (/^(?:```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    const line = rawLine.replaceAll(/`[^`]*`/g, (span) => " ".repeat(span.length));
    for (const match of line.matchAll(/(?:^|\s)@([~./\\A-Za-z0-9_-][^\s`)>,;]*)/g)) {
      const target = (match[1] ?? "").replace(/[.,;:]+$/, "");
      if (target === "" || target.includes("@")) continue;
      out.push({ line: index + 1, target });
    }
  });
  return out;
}

export interface IndexLink {
  line: number;
  target: string;
}

/** List items whose first markdown link names a file: `- [x.md](x.md): …` (ticket 08 §2). */
export function findIndexLinks(text: string): IndexLink[] {
  const out: IndexLink[] = [];
  text.split("\n").forEach((line, index) => {
    if (!/^\s*[-*+]\s/.test(line)) return;
    const match = /\[[^\]]*\]\(([^)\s]+)\)/.exec(line);
    if (match?.[1] !== undefined) out.push({ line: index + 1, target: match[1] });
  });
  return out;
}

/** The first `min(lines, bytes)` portion of a text, the way Claude Code caps a memory index. */
export function capPortion(
  text: string,
  maxLines: number,
  maxBytes: number,
): { text: string; lines: number; bytes: number } {
  const lines = text.split("\n");
  const kept = lines.slice(0, maxLines);
  let portion = kept.join("\n");
  if (lines.length > maxLines) portion += "\n";
  let bytes = Buffer.byteLength(portion, "utf8");
  if (bytes > maxBytes) {
    portion = Buffer.from(portion, "utf8").subarray(0, maxBytes).toString("utf8");
    portion = portion.replace(/�$/, "");
    bytes = Buffer.byteLength(portion, "utf8");
  }
  return { text: portion, lines: countLines(portion), bytes };
}
