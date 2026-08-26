/**
 * The two settings files whose *values* Cursor's adapter reads — `~/.cursor/cli-config.json`
 * (JSON) and `<app-support>/User/settings.json` (JSONC) — plus the one redaction rule every
 * adapter shares (D64). Every other settings file contributes key names only (§1.7).
 *
 * JSONC is read with a small tolerant pass (line and block comments outside strings, trailing
 * commas) rather than a new dependency: `packages/core` ships `gpt-tokenizer` alone.
 */
import { isRecord, readText } from "../../scan/fs.js";

const SECRET_MAPS = new Set(["env", "headers"]);
const SECRET_KEY =
  /(token|secret|key|password|passwd|auth|credential|cookie|session[_-]?id|api[_-]?key)/i;
const SECRET_VALUE = /^[A-Za-z0-9_\-./+=]{24,}$/;

/**
 * D64: a value becomes `"<redacted>"` when its key looks secret **or** the value is a bare token
 * — 24 characters or more of `[A-Za-z0-9_-./+=]` with no spaces.
 */
export function redactString(value: string, key: string | null): string {
  if (key !== null && SECRET_KEY.test(key)) return "<redacted>";
  return SECRET_VALUE.test(value) ? "<redacted>" : value;
}

/** D64 over a whole settings tree: `env`/`headers` maps keep their key names, never their values. */
export function redactValue(value: unknown, key: string | null): unknown {
  if (key !== null && SECRET_MAPS.has(key) && isRecord(value)) {
    return Object.fromEntries(Object.keys(value).map((name) => [name, "<redacted>"]));
  }
  if (typeof value === "string") return redactString(value, key);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, key));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redactValue(item, name)]),
    );
  }
  return value;
}

/** Comments and trailing commas removed; every other byte kept so offsets stay meaningful. */
export function stripJsonc(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (inString) {
      out += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
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
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out.replaceAll(/,(\s*[}\]])/g, "$1");
}

export interface SettingsLayer {
  path: string;
  present: boolean;
  parseError: boolean;
  data: Record<string, unknown>;
}

/** Reads a JSON or JSONC object; an empty file is present-but-unreadable, never a parse error. */
export async function readSettingsLayer(path: string, jsonc = false): Promise<SettingsLayer> {
  const text = await readText(path);
  if (text === null) return { path, present: false, parseError: false, data: {} };
  if (text.trim() === "") return { path, present: true, parseError: false, data: {} };
  try {
    const value: unknown = JSON.parse(jsonc ? stripJsonc(text) : text);
    return isRecord(value)
      ? { path, present: true, parseError: false, data: value }
      : { path, present: true, parseError: true, data: {} };
  } catch {
    return { path, present: true, parseError: true, data: {} };
  }
}

/** The keys of `User/settings.json` moldig models: Cursor's worktree retention (research 10 §1.1). */
export const IDE_SETTINGS_KEYS: readonly string[] = [
  "cursor.worktreeMaxCount",
  "cursor.worktreeCleanupIntervalHours",
];

/**
 * `Harness.effectiveSettings`: every `cli-config.json` key (secrets redacted) plus the two
 * `User/settings.json` keys above when they are set (§1.2).
 */
export function effectiveSettings(
  cliConfig: Record<string, unknown>,
  ideSettings: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cliConfig)) out[key] = redactValue(value, key);
  for (const key of IDE_SETTINGS_KEYS) {
    const value = ideSettings[key];
    if (value !== undefined) out[key] = redactValue(value, key);
  }
  return out;
}

/**
 * `cursor.worktreeMaxCount` as the retention of the worktree units: the documented default is 25
 * (research 10 §1.1). A value that is not a positive whole number is unusable, and D120's
 * fail-closed rule turns the harness's swept rows into `undocumented` ones.
 */
export function worktreeMaxCount(settings: Record<string, unknown>): {
  count: number | null;
  invalid: boolean;
} {
  const value = settings["cursor.worktreeMaxCount"];
  if (value === undefined) return { count: 25, invalid: false };
  if (typeof value === "number" && Number.isInteger(value) && value >= 1)
    return { count: value, invalid: false };
  return { count: null, invalid: true };
}
