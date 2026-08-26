/**
 * The two readers this adapter needs and no dependency provides: JSON with comments (VS Code
 * writes `settings.json` and `mcp.json` as JSONC) and the flat `key: value` YAML of a Copilot
 * session's `workspace.yaml`. Both fail closed: a shape richer than the one documented is
 * reported (`unsupported-shape`) rather than guessed at, and no value ever leaves them except
 * through the caller's own allowlist.
 */

/** Strips `//` and block comments and trailing commas, leaving string literals untouched. */
export function stripJsonc(text: string): string {
  let out = "";
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[index + 1] ?? "";
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 2;
      continue;
    }
    out += char;
    index += 1;
  }
  // Trailing commas: `,` followed by whitespace and a closing bracket.
  return out.replaceAll(/,(\s*[}\]])/g, "$1");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parsed JSONC object; `null` when the text is not an object or does not parse. */
export function parseJsoncObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stripJsonc(text));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export interface FlatYaml {
  /** Only the keys the caller asked for; every other value is dropped, never stored. */
  data: Record<string, string>;
  /** A line the flat reader cannot represent (nesting, a list, a block scalar, an anchor). */
  unsupported: boolean;
  /** No `key: value` line at all — the file is not the documented shape. */
  empty: boolean;
}

function unquote(raw: string): string {
  const text = raw.trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return text.slice(1, -1);
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return text;
}

/**
 * The flat `key: value` YAML a `workspace.yaml` carries (research 09 §1). Deliberately not a
 * YAML parser: an indented line, a list item, a block scalar (`|`, `>`), an anchor or an alias
 * sets `unsupported` and is skipped, which the adapter turns into one `unsupported-shape`
 * warning. `keys` is the allowlist — a value outside it is never even returned.
 */
export function parseFlatYaml(text: string, keys: readonly string[]): FlatYaml {
  const allowed = new Set(keys);
  const data: Record<string, string> = {};
  let unsupported = false;
  let pairs = 0;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, "");
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (line.trim() === "---" || line.trim() === "...") continue;
    if (line.startsWith(" ") || line.startsWith("\t") || line.trimStart().startsWith("-")) {
      unsupported = true;
      continue;
    }
    const match = /^([A-Za-z_][\w.-]*):(.*)$/.exec(line);
    if (match === null) {
      unsupported = true;
      continue;
    }
    const key = match[1] ?? "";
    const value = (match[2] ?? "").trim();
    if (value === "" || value === "|" || value === ">" || value.startsWith("&")) {
      // An empty value opens a nested block or a block scalar: richer than this reader.
      unsupported = true;
      continue;
    }
    pairs += 1;
    if (allowed.has(key)) data[key] = unquote(value);
  }
  return { data, unsupported, empty: pairs === 0 };
}
