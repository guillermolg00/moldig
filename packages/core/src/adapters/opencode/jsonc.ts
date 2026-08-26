/**
 * JSON with comments, the way OpenCode reads `opencode.json` and `opencode.jsonc`: `//` and
 * `/* *\/` comments and trailing commas are legal, everything else is JSON. The spec names
 * `jsonc-parser` for this; ticket 21 added no dependency, so the tolerant reader below blanks
 * comments and trailing commas in place — offsets are preserved, so nothing shifts — and hands
 * the result to `JSON.parse`. moldig never writes these files: the actions engine edits entries
 * with `jsonc-parser` (ticket 14 §1).
 *
 * Follow-up: ticket 24 landed `jsonc-parser` as a dependency of `@moldig/core` for exactly that
 * edit path, so once both slices sit on one branch this module can become a call to its `parse`.
 */

/** Comments and trailing commas replaced by spaces; string literals untouched. */
export function stripJsonc(text: string): string {
  // oxlint-disable-next-line typescript/no-misused-spread -- JSON(C) syntax is ASCII; only
  // comment and comma positions are rewritten, and every other code unit is joined back verbatim.
  const out = text.split("");
  let index = 0;
  let comma = -1;
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) if (out[i] !== "\n") out[i] = " ";
  };
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      index += 1;
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2;
          continue;
        }
        if (text[index] === '"') break;
        index += 1;
      }
      index += 1;
      comma = -1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      blank(index, end === -1 ? text.length : end);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (char === ",") {
      comma = index;
      index += 1;
      continue;
    }
    if (char !== undefined && /\s/.test(char)) {
      index += 1;
      continue;
    }
    // The first non-blank token after a comma: `}` or `]` makes that comma a trailing one.
    if ((char === "}" || char === "]") && comma !== -1) out[comma] = " ";
    comma = -1;
    index += 1;
  }
  return out.join("");
}

/** The parsed value, or `undefined` when the text is not valid JSON(C). */
export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(stripJsonc(text)) as unknown;
  } catch {
    return undefined;
  }
}
