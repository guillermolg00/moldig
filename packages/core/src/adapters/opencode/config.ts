/**
 * OpenCode's configuration layers (research 02 §OpenCode; 06 rule 10): the user file
 * `~/.config/opencode/opencode.json[c]`, the extra file `$OPENCODE_CONFIG` and the project file
 * `<member>/opencode.json[c]`, merged in that order (later wins per key, objects merged). The
 * remote `.well-known/opencode` layer and `instructions[]` URLs are never fetched (ADR-0001)
 * and `OPENCODE_CONFIG_CONTENT` is never parsed (D61/D110).
 *
 * `instructions[]` entries are paths or globs resolved against the directory of the file that
 * lists them; the expander below understands `*`, `**`, `?` and `{a,b}` and never follows a
 * symlinked directory.
 */
import { isAbsolute, join, resolve, sep } from "node:path";
import type { EntryFormat, Scope } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isFile, isRecord, listDir, readText } from "../../scan/fs.js";
import { redactString } from "../claude-code/state.js";
import { parseJsonc } from "./jsonc.js";
import { CONFIG_NAMES } from "./paths.js";

export interface ConfigFile {
  path: string;
  present: boolean;
  parseError: boolean;
  format: EntryFormat & ("json" | "jsonc");
  scope: Scope;
  project: DiscoveredProject | null;
  data: Record<string, unknown>;
}

export function formatOfConfig(path: string): "json" | "jsonc" {
  return path.endsWith(".jsonc") ? "jsonc" : "json";
}

export async function readConfigFile(
  path: string,
  scope: Scope,
  project: DiscoveredProject | null,
): Promise<ConfigFile> {
  const base: ConfigFile = {
    path,
    present: false,
    parseError: false,
    format: formatOfConfig(path),
    scope,
    project,
    data: {},
  };
  const text = await readText(path);
  if (text === null) return base;
  const parsed = parseJsonc(text);
  if (!isRecord(parsed)) return { ...base, present: true, parseError: true };
  return { ...base, present: true, data: parsed };
}

/** `<dir>/opencode.json`, else `<dir>/opencode.jsonc`; `null` when the directory has neither. */
export async function findConfigIn(dir: string): Promise<string | null> {
  for (const name of CONFIG_NAMES) {
    const path = join(dir, name);
    // oxlint-disable-next-line no-await-in-loop -- two candidates, in the order OpenCode reads them
    if (await isFile(path)) return path;
  }
  return null;
}

const SECRET_MAPS = new Set(["environment", "headers", "env"]);

/** D64 plus the spec's own rule: `mcp.*.environment` and `mcp.*.headers` values never survive. */
function redact(value: unknown, key: string | null): unknown {
  if (key !== null && SECRET_MAPS.has(key) && isRecord(value)) {
    return Object.fromEntries(Object.keys(value).map((name) => [name, "<redacted>"]));
  }
  if (typeof value === "string") return redactString(value, key);
  if (Array.isArray(value)) return value.map((item) => redact(item, null));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redact(item, name)]),
    );
  }
  return value;
}

function mergeInto(target: Record<string, unknown>, layer: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(layer)) {
    const current = target[key];
    if (isRecord(current) && isRecord(value)) {
      const nested = { ...current };
      mergeInto(nested, value);
      target[key] = nested;
    } else {
      target[key] = value;
    }
  }
}

/** The layers merged least specific first, `$schema` dropped, secrets redacted. */
export function effectiveConfig(layers: readonly ConfigFile[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) if (!layer.parseError) mergeInto(out, layer.data);
  delete out["$schema"];
  const redacted = redact(out, null);
  return isRecord(redacted) ? redacted : {};
}

/** The `mcp` map of one layer: name → entry, entries that are not objects skipped. */
export function mcpEntriesOf(layer: ConfigFile): [string, Record<string, unknown>][] {
  const map = layer.data["mcp"];
  if (!isRecord(map)) return [];
  return Object.entries(map).filter((pair): pair is [string, Record<string, unknown>] =>
    isRecord(pair[1]),
  );
}

/** `instructions[]` of one layer, in array order; non-string entries are ignored. */
export function instructionsOf(layer: ConfigFile): string[] {
  const value = layer.data["instructions"];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function isUrlEntry(entry: string): boolean {
  return /^https?:\/\//i.test(entry);
}

const GLOB_DEPTH = 8;
const PRUNED = new Set(["node_modules", ".git"]);

function hasMagic(pattern: string): boolean {
  return /[*?{[]/.test(pattern);
}

/** `a/{b,c}/d` → `a/b/d`, `a/c/d`; one level of alternation is all the docs promise. */
function expandBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (match === null) return [pattern];
  const [whole, inner = ""] = match;
  const start = match.index;
  return inner
    .split(",")
    .flatMap((choice) =>
      expandBraces(pattern.slice(0, start) + choice + pattern.slice(start + whole.length)),
    );
}

function segmentRegex(segment: string): RegExp {
  let source = "";
  for (const char of segment) {
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

async function walkGlob(
  dir: string,
  segments: readonly string[],
  depth: number,
): Promise<string[]> {
  const [head, ...rest] = segments;
  if (head === undefined || depth > GLOB_DEPTH) return [];
  const entries = await listDir(dir);
  if (head === "**") {
    const here = await walkGlob(dir, rest, depth);
    const below = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && !PRUNED.has(entry.name))
        .map((entry) => walkGlob(join(dir, entry.name), segments, depth + 1)),
    );
    return [...here, ...below.flat()];
  }
  const pattern = segmentRegex(head);
  const matched = entries.filter((entry) => pattern.test(entry.name));
  if (rest.length === 0) {
    return matched.filter((entry) => entry.isFile()).map((entry) => join(dir, entry.name));
  }
  const below = await Promise.all(
    matched
      .filter((entry) => entry.isDirectory() && !PRUNED.has(entry.name))
      .map((entry) => walkGlob(join(dir, entry.name), rest, depth + 1)),
  );
  return below.flat();
}

/**
 * Every regular file an `instructions[]` entry names, sorted. An entry without glob characters
 * is one path (`[]` when it does not exist); `~/` expands to the injected home, never the real
 * one, and a relative entry resolves against the directory of the file that listed it.
 */
export async function expandInstruction(
  entry: string,
  baseDir: string,
  home: string,
): Promise<string[]> {
  const expanded = entry.startsWith("~/") || entry === "~" ? join(home, entry.slice(1)) : entry;
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(baseDir, expanded);
  if (!hasMagic(absolute)) return (await isFile(absolute)) ? [absolute] : [];
  const found = await Promise.all(
    expandBraces(absolute).map(async (pattern) => {
      const parts = pattern.split(sep).join("/").split("/");
      const anchor = parts.findIndex((part) => hasMagic(part));
      const root = parts.slice(0, anchor).join("/") || "/";
      return walkGlob(root, parts.slice(anchor), 0);
    }),
  );
  return [...new Set(found.flat())].toSorted((a, b) => a.localeCompare(b));
}
