/**
 * TOML, read-only (D63): `smol-toml`, pinned exact, parsing **only** — moldig never writes TOML
 * (ticket 14 §1), which is why a Codex MCP entry is removed by delegating to `codex mcp remove`
 * instead of editing the file. A document that does not parse yields one `parse-error` warning
 * and an empty table: its `settings-file` row is still emitted, with `topLevelKeys: []`.
 */
import { parse } from "smol-toml";
import { isRecord, readText } from "../../scan/fs.js";

export interface TomlFile {
  path: string;
  present: boolean;
  parseError: boolean;
  /** The parser's own message, for the warning; `null` when the file parsed. */
  errorMessage: string | null;
  data: Record<string, unknown>;
  /** Top-level keys and table names, in declaration order (ticket 07 `topLevelKeys`). */
  topLevelKeys: string[];
}

function absent(path: string): TomlFile {
  return {
    path,
    present: false,
    parseError: false,
    errorMessage: null,
    data: {},
    topLevelKeys: [],
  };
}

export async function readToml(path: string): Promise<TomlFile> {
  const text = await readText(path);
  if (text === null) return absent(path);
  try {
    const value: unknown = parse(text);
    if (!isRecord(value)) {
      return { ...absent(path), present: true, parseError: true, errorMessage: "not a table" };
    }
    return {
      path,
      present: true,
      parseError: false,
      errorMessage: null,
      data: value,
      topLevelKeys: Object.keys(value),
    };
  } catch (error) {
    return {
      ...absent(path),
      present: true,
      parseError: true,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The sub-tables of `parent` (`[mcp_servers.<id>]`, `[projects."<path>"]`, `[agents.<name>]`). */
export function tablesOf(
  data: Record<string, unknown>,
  parent: string,
): [string, Record<string, unknown>][] {
  const table = data[parent];
  if (!isRecord(table)) return [];
  const out: [string, Record<string, unknown>][] = [];
  for (const [key, value] of Object.entries(table)) if (isRecord(value)) out.push([key, value]);
  return out;
}

export function stringAt(data: Record<string, unknown>, ...keyPath: string[]): string | null {
  const value = valueAt(data, ...keyPath);
  return typeof value === "string" ? value : null;
}

export function numberAt(data: Record<string, unknown>, ...keyPath: string[]): number | null {
  const value = valueAt(data, ...keyPath);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function booleanAt(data: Record<string, unknown>, ...keyPath: string[]): boolean | null {
  const value = valueAt(data, ...keyPath);
  return typeof value === "boolean" ? value : null;
}

export function valueAt(data: Record<string, unknown>, ...keyPath: string[]): unknown {
  let current: unknown = data;
  for (const key of keyPath) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}
