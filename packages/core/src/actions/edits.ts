/**
 * The two edits moldig performs, both as pure `string → string | null` functions so they are
 * tested on strings before they are tested through `apply()` on a tree: removing an Entry from
 * a JSON / JSONC settings file, and the `MEMORY.md` index rewrite of ticket 08 §2.
 *
 * `null` means "nothing matched": the caller writes nothing and records why (08 §2, D98).
 * moldig never edits TOML (14 §1) — there is deliberately no function for it here.
 */
import { applyEdits, findNodeAtLocation, modify, parseTree, type Edit } from "jsonc-parser";

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
