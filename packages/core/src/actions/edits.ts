/**
 * Recoverable text edits as pure `string → string | null` functions, tested on strings before
 * `apply()` runs them on a tree: JSON / JSONC properties and array values, one TOML table, and the
 * `MEMORY.md` index rewrite of ticket 08 §2.
 *
 * `null` means "nothing matched": the caller writes nothing and records why (08 §2, D98).
 */
import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
  type Edit,
} from "jsonc-parser";

const LEADING_SPACE = /^\s+/u;

/**
 * jsonc-parser re-indents the whole region it touches when it is given formatting options — it
 * would expand a one-line sibling entry nobody asked it to change. Without them the removal is
 * the smallest possible range, so every other byte (comments, key order, trailing commas, the
 * file's own indentation) comes back unchanged. The one dent that leaves is the whitespace
 * right after `{` when the first entry goes; it is put back here.
 */
function repair(text: string, edits: readonly Edit[]): Edit[] {
  return edits.map((edit) => {
    if (edit.content !== "") return edit;
    const previous = text.slice(0, edit.offset).trimEnd().at(-1);
    if (previous !== "{" && previous !== "[") return edit;
    const lead = LEADING_SPACE.exec(text.slice(edit.offset, edit.offset + edit.length))?.[0] ?? "";
    return lead === "" ? edit : { ...edit, content: lead };
  });
}

/**
 * Remove the property at `keyPath` (raw segments, exactly as the index carries them — 07
 * point 2) with `modify` + `applyEdits`: comments, key order and the surrounding formatting
 * are preserved (14 §1). Returns `null` when the file holds no such entry.
 */
export function removeJsonEntry(text: string, keyPath: readonly string[]): string | null {
  const tree = parseTree(text);
  if (tree === undefined) return null;
  const path = [...keyPath];
  if (findNodeAtLocation(tree, path) === undefined) return null;
  const edits = modify(text, path, undefined, {});
  if (edits.length === 0) return null;
  return applyEdits(text, repair(text, edits));
}

/** Remove one exact string from a JSON / JSONC array, preserving every sibling and comment. */
export function removeJsonArrayValue(
  text: string,
  keyPath: readonly string[],
  value: string,
): string | null {
  const tree = parseTree(text);
  if (tree === undefined) return null;
  const array = findNodeAtLocation(tree, [...keyPath]);
  if (array?.type !== "array" || array.children === undefined) return null;
  const index = array.children.findIndex((child) => getNodeValue(child) === value);
  if (index < 0) return null;
  const edits = modify(text, [...keyPath, index], undefined, {});
  if (edits.length === 0) return null;
  return applyEdits(text, repair(text, edits));
}

function basicString(text: string, start: number): { value: string; end: number } | null {
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char !== '"') continue;
    const raw = text.slice(start, index + 1);
    try {
      const value: unknown = JSON.parse(raw);
      return typeof value === "string" ? { value, end: index + 1 } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The subset of TOML dotted keys used by Codex's `[projects."<absolute path>"]` tables. */
function dottedTomlKey(text: string): string[] | null {
  const parts: string[] = [];
  let index = 0;
  while (index < text.length) {
    while (/\s/u.test(text[index] ?? "")) index += 1;
    if (index >= text.length) return parts.length > 0 ? parts : null;
    const quote = text[index];
    if (quote === '"') {
      const found = basicString(text, index);
      if (found === null) return null;
      parts.push(found.value);
      index = found.end;
    } else if (quote === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) return null;
      parts.push(text.slice(index + 1, end));
      index = end + 1;
    } else {
      const start = index;
      while (index < text.length && text[index] !== "." && !/\s/u.test(text[index] ?? "")) {
        index += 1;
      }
      const part = text.slice(start, index);
      if (part === "") return null;
      parts.push(part);
    }
    while (/\s/u.test(text[index] ?? "")) index += 1;
    if (index >= text.length) return parts;
    if (text[index] !== ".") return null;
    index += 1;
  }
  return parts.length > 0 ? parts : null;
}

/** A single-bracket TOML table header, without accepting array-of-table headers. */
function tableHeader(line: string): string[] | null {
  let index = 0;
  while (/\s/u.test(line[index] ?? "") && line[index] !== "\n" && line[index] !== "\r") {
    index += 1;
  }
  if (line[index] !== "[" || line[index + 1] === "[") return null;
  const start = index + 1;
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (index = start; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"') {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (char === "'") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== "]") continue;
    const tail = line.slice(index + 1).trim();
    if (tail !== "" && !tail.startsWith("#")) return null;
    return dottedTomlKey(line.slice(start, index));
  }
  return null;
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}

function descendsFrom(path: readonly string[], parent: readonly string[]): boolean {
  return path.length > parent.length && parent.every((part, index) => part === path[index]);
}

/**
 * Remove one TOML table and any child tables. The surrounding bytes are untouched; this is the
 * narrow orphan-Project exception to the normal rule that moldig never rewrites TOML.
 */
export function removeTomlTable(text: string, keyPath: readonly string[]): string | null {
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)?.filter((line) => line !== "") ?? [];
  const start = lines.findIndex((line) => {
    const header = tableHeader(line);
    return header !== null && samePath(header, keyPath);
  });
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length) {
    const header = tableHeader(lines[end] ?? "");
    if (header !== null && !descendsFrom(header, keyPath)) break;
    end += 1;
  }
  return [...lines.slice(0, start), ...lines.slice(end)].join("");
}

/** Basename of a markdown link target: `/` and `\` both separate, whatever the host. */
function basename(target: string): string {
  const cut = Math.max(target.lastIndexOf("/"), target.lastIndexOf("\\"));
  return cut === -1 ? target : target.slice(cut + 1);
}

const LIST_ITEM = /^\s{0,3}(?:[-*+]|\d+[.)])\s+/u;
const FIRST_LINK = /\[[^\]]*\]\(([^)]*)\)/u;
const FENCE = /^\s{0,3}(?:```|~~~)/u;

/** The link target's file name, with a title, a fragment, a query and `<>` stripped off. */
function targetFileName(raw: string): string {
  const first = raw.trim().split(/\s+/u)[0] ?? "";
  const bare = first.startsWith("<") && first.endsWith(">") ? first.slice(1, -1) : first;
  const withoutFragment = bare.split("#")[0]?.split("?")[0] ?? "";
  return basename(withoutFragment);
}

/**
 * The `MEMORY.md` rewrite, verbatim (08 §2): drop every list item whose first markdown link
 * target's basename equals the removed file's name (any hook shape: ` — `, `: `, none); write
 * every other byte back unchanged — order, headings, plain items, code fences, line endings and
 * the trailing newline; never regenerate a line from frontmatter; write nothing when no line
 * matched. Lines inside a fenced code block are never touched.
 */
export function rewriteMemoryIndex(text: string, factFileName: string): string | null {
  const wanted = basename(factFileName);
  const lines = text.split(/(?<=\n)/u);
  const kept: string[] = [];
  let fenced = false;
  let dropped = 0;
  for (const line of lines) {
    if (FENCE.test(line)) {
      fenced = !fenced;
      kept.push(line);
      continue;
    }
    if (fenced || !LIST_ITEM.test(line)) {
      kept.push(line);
      continue;
    }
    const link = FIRST_LINK.exec(line)?.[1];
    if (link === undefined) {
      kept.push(line);
      continue;
    }
    const name = targetFileName(link);
    let decoded = name;
    try {
      decoded = decodeURIComponent(name);
    } catch {
      decoded = name;
    }
    if (name === wanted || decoded === wanted) {
      dropped += 1;
      continue;
    }
    kept.push(line);
  }
  return dropped === 0 ? null : kept.join("");
}
