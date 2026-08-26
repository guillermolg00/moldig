/**
 * Gemini CLI's settings layers (research 02, Gemini settings): JSONC files (the harness tolerates
 * comments) read least-specific first — defaults < `system-defaults.json` < `~/.gemini/settings.json`
 * < `<project>/.gemini/settings.json` < `<SYSDIR>/settings.json`. Objects merge, scalars take the
 * most specific layer and **arrays replace** (D71). Legacy flat keys are normalised into the v2
 * shape before merging, and only when the nested key is absent. Secrets never enter the index (D64).
 *
 * The TOML reader below is the one custom commands and policy files share: it covers the shapes
 * those files use (top-level and `[table]` key/value pairs, strings, numbers, booleans, arrays)
 * and nothing more — moldig needs their key names, not a general TOML implementation.
 */
import type { HookDecl } from "../../index/types.js";
import { isRecord, isStringArray, readText } from "../../scan/fs.js";

// ---------- JSONC ----------

/**
 * JSON with line comments, block comments and trailing commas removed — what the harness accepts.
 * Comment markers inside strings are left alone.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += char;
  }
  // Trailing commas before `}` or `]`, outside strings (the string scan above kept them intact).
  return out.replaceAll(/,(\s*[}\]])/g, "$1");
}

export function parseJsonc(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stripJsonc(text));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

// ---------- TOML ----------

function tomlScalar(raw: string): unknown {
  const text = raw.trim();
  if (text === "") return "";
  if (text.startsWith('"""') && text.endsWith('"""') && text.length >= 6) {
    return text.slice(3, -3).replace(/^\r?\n/, "");
  }
  if (text.startsWith("'''") && text.endsWith("'''") && text.length >= 6) {
    return text.slice(3, -3).replace(/^\r?\n/, "");
  }
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) return text.slice(1, -1);
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "string" ? value : text.slice(1, -1);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^[+-]?\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text))
    return Number(text.replaceAll("_", ""));
  if (text.startsWith("[") && text.endsWith("]")) {
    const inner = text.slice(1, -1).trim();
    return inner === "" ? [] : splitTop(inner).map((item) => tomlScalar(item));
  }
  return text;
}

/** Splits a bracket body on top-level commas (quotes and nested brackets respected). */
function splitTop(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (quote !== null) {
      current += char;
      if (char === "\\") {
        current += text[i + 1] ?? "";
        i += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    if (char === "]" || char === "}") depth -= 1;
    if (char === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim() !== "") out.push(current);
  return out;
}

/**
 * The subset of TOML harness files use. A file whose first non-blank, non-comment line is not a
 * `key = value` pair or a `[table]` header yields `null`, which callers report as `parse-error`.
 */
export function parseToml(text: string): Record<string, unknown> | null {
  const root: Record<string, unknown> = {};
  let table = root;
  let buffer: { key: string; value: string; open: number } | null = null;
  let ok = true;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (buffer !== null) {
      buffer.value += "\n" + rawLine;
      buffer.open += countBrackets(rawLine);
      if (buffer.open <= 0) {
        table[buffer.key] = tomlScalar(buffer.value);
        buffer = null;
      }
      continue;
    }
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[{1,2}([^\]]+)\]{1,2}$/.exec(line);
    if (header !== null) {
      const name = (header[1] ?? "").trim();
      const section: Record<string, unknown> = {};
      root[name] = section;
      table = section;
      continue;
    }
    const pair = /^([A-Za-z0-9_"'.-]+)\s*=\s*(.*)$/.exec(line);
    if (pair === null) {
      ok = false;
      continue;
    }
    const key = (pair[1] ?? "").replace(/^["']|["']$/g, "");
    const value = pair[2] ?? "";
    const open = countBrackets(value);
    if (open > 0) buffer = { key, value, open };
    else table[key] = tomlScalar(value);
  }
  return ok ? root : null;
}

function countBrackets(text: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] ?? "";
    if (quote !== null) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
  }
  return depth;
}

// ---------- layers ----------

export interface Layer {
  path: string;
  present: boolean;
  parseError: boolean;
  /** Normalised into the v2 nested shape; unknown flat keys survive untouched. */
  data: Record<string, unknown>;
}

/** Legacy flat keys, normalised only when the nested key is absent (research 02). */
const LEGACY_KEYS: [string, string, string][] = [
  ["contextFileName", "context", "fileName"],
  ["theme", "ui", "theme"],
  ["checkpointing", "general", "checkpointing"],
];

export function normaliseLegacy(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const [flat, section, key] of LEGACY_KEYS) {
    if (!(flat in out)) continue;
    const current = out[section];
    if (isRecord(current) && current[key] !== undefined) continue;
    const base = isRecord(current) ? { ...current } : {};
    base[key] = out[flat];
    out[section] = base;
  }
  return out;
}

export async function readLayer(path: string): Promise<Layer> {
  const text = await readText(path);
  if (text === null) return { path, present: false, parseError: false, data: {} };
  if (text.trim() === "") return { path, present: true, parseError: false, data: {} };
  const parsed = parseJsonc(text);
  return {
    path,
    present: true,
    parseError: parsed === null,
    data: parsed === null ? {} : normaliseLegacy(parsed),
  };
}

/**
 * D71: objects merge, scalars take the most specific layer, arrays **replace** (the last tier
 * that names an array wins outright — `context.fileName` never accumulates across tiers).
 */
function mergeInto(target: Record<string, unknown>, layer: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(layer)) {
    const current = target[key];
    if (isRecord(current) && isRecord(value)) {
      const merged = { ...current };
      mergeInto(merged, value);
      target[key] = merged;
    } else {
      target[key] = value;
    }
  }
}

export function mergeLayers(layers: readonly Layer[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) if (!layer.parseError) mergeInto(out, layer.data);
  return out;
}

// ---------- redaction (D64) ----------

const SECRET_KEY =
  /(token|secret|key|password|passwd|auth|credential|cookie|session[_-]?id|api[_-]?key)/i;
const SECRET_VALUE = /^[A-Za-z0-9_\-./+=]{24,}$/;
/** Maps whose values never enter the index, whatever their key names say. */
const SECRET_MAPS = new Set(["env", "headers", "oauth"]);

export function redactString(value: string, key: string | null): string {
  if (key !== null && SECRET_KEY.test(key)) return "<redacted>";
  return SECRET_VALUE.test(value) ? "<redacted>" : value;
}

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

export function redactSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const out = redact(settings, null);
  return isRecord(out) ? out : {};
}

// ---------- hooks ----------

/** `hooks.<Event>[{matcher?, hooks: [{type, command, name?, timeout?}]}]` (research 02). */
export function hooksOf(data: Record<string, unknown>): HookDecl[] {
  const hooks = data["hooks"];
  if (!isRecord(hooks)) return [];
  const out: HookDecl[] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!isRecord(group)) continue;
      const matcher = typeof group["matcher"] === "string" ? group["matcher"] : null;
      const list = group["hooks"];
      if (!Array.isArray(list)) continue;
      for (const hook of list) {
        if (!isRecord(hook)) continue;
        const type = typeof hook["type"] === "string" ? hook["type"] : "unknown";
        const raw = typeof hook["command"] === "string" ? hook["command"] : null;
        // D40: a hook command reaches the index through the shared secret rule, never verbatim.
        out.push({ event, type, command: raw === null ? null : redactString(raw, null), matcher });
      }
    }
  }
  return out;
}

// ---------- the few keys moldig models ----------

export function nested(settings: Record<string, unknown>, ...path: string[]): unknown {
  let current: unknown = settings;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

export interface Retention {
  days: number | null;
  count: number | null;
  /** D120: the sweep is off (disabled, missing or unparseable) — every swept row falls back. */
  disabled: boolean;
}

const DURATION = /^(\d+)(d|h|w)$/;

export function parseDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = DURATION.exec(value.trim());
  if (match === null) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  return match[2] === "h" ? amount / 24 : match[2] === "w" ? amount * 7 : amount;
}

/**
 * `general.sessionRetention` (ticket 08 §1 Gemini header): `days = max(maxAge ?? "30d",
 * minRetention ?? "1d")`. D120 is fail-closed — `enabled: false` or a value that does not parse
 * leaves the harness sweeping nothing, so every `swept` row becomes `undocumented`.
 */
export function retentionOf(settings: Record<string, unknown>): Retention {
  const block = nested(settings, "general", "sessionRetention");
  const record = isRecord(block) ? block : {};
  if (record["enabled"] === false) return { days: null, count: null, disabled: true };
  const maxAge = record["maxAge"] === undefined ? 30 : parseDuration(record["maxAge"]);
  const minRetention =
    record["minRetention"] === undefined ? 1 : parseDuration(record["minRetention"]);
  const maxCount = record["maxCount"];
  const count = typeof maxCount === "number" && Number.isFinite(maxCount) ? maxCount : null;
  if (maxAge === null || minRetention === null) return { days: null, count, disabled: true };
  return { days: Math.max(maxAge, minRetention), count, disabled: false };
}

/** `context.fileName` (string or string[]); anything else is an `unsupported-shape`. */
export function contextFileNames(settings: Record<string, unknown>): {
  names: string[];
  unsupported: boolean;
} {
  const value = nested(settings, "context", "fileName");
  if (value === undefined) return { names: ["GEMINI.md"], unsupported: false };
  if (typeof value === "string") return { names: [value], unsupported: false };
  if (isStringArray(value)) return { names: [...value], unsupported: false };
  return { names: ["GEMINI.md"], unsupported: true };
}

export function stringList(value: unknown): string[] {
  return isStringArray(value) ? value : [];
}

export function boundaryMarkers(settings: Record<string, unknown>): string[] {
  const value = nested(settings, "context", "memoryBoundaryMarkers");
  return isStringArray(value) && value.length > 0 ? [...value] : [".git"];
}
