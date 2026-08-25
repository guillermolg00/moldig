/**
 * Claude Code's settings layers and its `~/.claude.json` state file (research 01 §3): key
 * names and the few values moldig models (trust, MCP approvals, `cleanupPeriodDays`,
 * `autoMemoryEnabled`, plugin toggles). Values that may hold secrets (`env`) are redacted
 * before they enter the index; `oauthAccount` is never read beyond its key name.
 */
import { join } from "node:path";
import type { HookDecl } from "../../index/types.js";
import { isRecord, isStringArray, readJsonObject, readText } from "../../scan/fs.js";

export interface ProjectEntry {
  key: string;
  raw: Record<string, unknown>;
  trusted: boolean | null;
  lastSessionId: string | null;
  mcpServers: Record<string, Record<string, unknown>>;
  enabledMcpjsonServers: string[];
  disabledMcpjsonServers: string[];
  enabledMcpServers: string[];
  disabledMcpServers: string[];
}

export interface ClaudeJson {
  path: string;
  present: boolean;
  parseError: boolean;
  topLevelKeys: string[];
  mcpServers: Record<string, Record<string, unknown>>;
  projects: ProjectEntry[];
}

function serversOf(value: unknown): Record<string, Record<string, unknown>> {
  if (!isRecord(value)) return {};
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, entry] of Object.entries(value)) if (isRecord(entry)) out[name] = entry;
  return out;
}

function stringList(value: unknown): string[] {
  return isStringArray(value) ? value : [];
}

export async function readClaudeJson(path: string): Promise<ClaudeJson> {
  const text = await readText(path);
  if (text === null) {
    return {
      path,
      present: false,
      parseError: false,
      topLevelKeys: [],
      mcpServers: {},
      projects: [],
    };
  }
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      path,
      present: true,
      parseError: true,
      topLevelKeys: [],
      mcpServers: {},
      projects: [],
    };
  }
  if (!isRecord(raw)) {
    return {
      path,
      present: true,
      parseError: true,
      topLevelKeys: [],
      mcpServers: {},
      projects: [],
    };
  }
  const projects: ProjectEntry[] = [];
  const projectsMap = raw["projects"];
  if (isRecord(projectsMap)) {
    for (const [key, entry] of Object.entries(projectsMap)) {
      if (!isRecord(entry)) continue;
      const trust = entry["hasTrustDialogAccepted"];
      const lastSessionId = entry["lastSessionId"];
      projects.push({
        key,
        raw: entry,
        trusted: typeof trust === "boolean" ? trust : null,
        lastSessionId: typeof lastSessionId === "string" ? lastSessionId : null,
        mcpServers: serversOf(entry["mcpServers"]),
        enabledMcpjsonServers: stringList(entry["enabledMcpjsonServers"]),
        disabledMcpjsonServers: stringList(entry["disabledMcpjsonServers"]),
        enabledMcpServers: stringList(entry["enabledMcpServers"]),
        disabledMcpServers: stringList(entry["disabledMcpServers"]),
      });
    }
  }
  return {
    path,
    present: true,
    parseError: false,
    topLevelKeys: Object.keys(raw),
    mcpServers: serversOf(raw["mcpServers"]),
    projects,
  };
}

export interface SettingsLayer {
  path: string;
  present: boolean;
  parseError: boolean;
  data: Record<string, unknown>;
}

export async function readSettingsLayer(path: string): Promise<SettingsLayer> {
  const text = await readText(path);
  if (text === null) return { path, present: false, parseError: false, data: {} };
  const data = await readJsonObject(path);
  return { path, present: true, parseError: data === null, data: data ?? {} };
}

/** The `hooks` map of a settings file as `HookDecl`s (event, type, command, matcher). */
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
        const command = typeof hook["command"] === "string" ? hook["command"] : null;
        out.push({ event, type, command, matcher });
      }
    }
  }
  return out;
}

/** Keys whose values may hold secrets: redacted to `"<redacted>"` before entering the index. */
const SECRET_MAPS = new Set(["env"]);
const SECRET_KEY = /token|secret|password|credential|apikey|api_key/i;

function redact(value: unknown, key: string | null): unknown {
  if (key !== null && SECRET_MAPS.has(key) && isRecord(value)) {
    return Object.fromEntries(Object.keys(value).map((name) => [name, "<redacted>"]));
  }
  if (key !== null && SECRET_KEY.test(key) && typeof value === "string") return "<redacted>";
  if (Array.isArray(value)) return value.map((item) => redact(item, null));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, redact(item, name)]),
    );
  }
  return value;
}

/** Settings precedence (research 01): arrays merge deduped, objects merge, scalars take the most specific. */
function mergeInto(target: Record<string, unknown>, layer: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(layer)) {
    const current = target[key];
    if (Array.isArray(current) && Array.isArray(value)) {
      const merged = [...current];
      for (const item of value)
        if (!merged.some((existing) => JSON.stringify(existing) === JSON.stringify(item)))
          merged.push(item);
      target[key] = merged;
    } else if (isRecord(current) && isRecord(value)) {
      const nested = { ...current };
      mergeInto(nested, value);
      target[key] = nested;
    } else {
      target[key] = value;
    }
  }
}

/** Effective settings of the given layers, least specific first, secrets redacted. */
export function effectiveSettings(layers: readonly SettingsLayer[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) if (!layer.parseError) mergeInto(out, layer.data);
  const redacted = redact(out, null);
  return isRecord(redacted) ? redacted : {};
}

export interface SettingsFiles {
  user: SettingsLayer;
  userLocal: SettingsLayer;
}

export async function readUserSettings(configDir: string): Promise<SettingsFiles> {
  const [user, userLocal] = await Promise.all([
    readSettingsLayer(join(configDir, "settings.json")),
    readSettingsLayer(join(configDir, "settings.local.json")),
  ]);
  return { user, userLocal };
}

/**
 * `cleanupPeriodDays` as the harness validates it (whole number ≥ 1; default 30). `invalid`
 * pauses the sweep, which ticket 08 maps to `rule: undocumented` for the whole harness.
 */
export function cleanupPeriodDays(settings: Record<string, unknown>): {
  days: number | null;
  invalid: boolean;
} {
  const value = settings["cleanupPeriodDays"];
  if (value === undefined) return { days: 30, invalid: false };
  if (typeof value === "number" && Number.isInteger(value) && value >= 1)
    return { days: value, invalid: false };
  return { days: null, invalid: true };
}
