/**
 * Copilot's two configuration surfaces: `~/.copilot/config.json` (the CLI's own state — trusted
 * folders, the model, disabled skills; every identifying value redacted before it enters the
 * index) and the VS Code layers, whose `chat.*` keys widen where instructions, agents, prompt
 * files and skills are discovered (research 02 [70][72][73][74]). Also the rule that decides
 * when a `.github/` directory is Copilot's at all (ticket 06 §7).
 */
import { isDirectory, isFile, isRecord, isStringArray, readText } from "../../scan/fs.js";
import { pathEngine } from "../../scan/paths.js";
import { parseJsoncObject } from "./parse.js";
import { REDACTED, redactSettings } from "./redact.js";

/** Identifying, not configuration: replaced by `<redacted>` before `effectiveSettings`. */
const IDENTIFYING = ["banner", "last_logged_in_user", "logged_in_users", "allowed_urls"];

export interface CopilotConfig {
  path: string;
  present: boolean;
  parseError: boolean;
  topLevelKeys: string[];
  /** `model` when it is a string that survived redaction; a redacted value is not a model id. */
  model: string | null;
  trustedFolders: string[];
  disabledSkills: string[];
  /** Redacted, ready for `Harness.effectiveSettings`. */
  settings: Record<string, unknown>;
}

const ABSENT_CONFIG = {
  present: false,
  parseError: false,
  topLevelKeys: [],
  model: null,
  trustedFolders: [],
  disabledSkills: [],
  settings: {},
};

export async function readCopilotConfig(path: string): Promise<CopilotConfig> {
  const text = await readText(path);
  if (text === null) return { path, ...ABSENT_CONFIG };
  let raw: unknown = null;
  try {
    raw = JSON.parse(text);
  } catch {
    return { path, ...ABSENT_CONFIG, present: true, parseError: true };
  }
  if (!isRecord(raw)) return { path, ...ABSENT_CONFIG, present: true, parseError: true };
  const settings = redactSettings(raw, IDENTIFYING);
  const model = settings["model"];
  return {
    path,
    present: true,
    parseError: false,
    topLevelKeys: Object.keys(raw),
    model: typeof model === "string" && model !== REDACTED ? model : null,
    trustedFolders: isStringArray(raw["trusted_folders"]) ? raw["trusted_folders"] : [],
    disabledSkills: isStringArray(raw["disabled_skills"]) ? raw["disabled_skills"] : [],
    settings,
  };
}

export interface SettingsLayer {
  path: string;
  present: boolean;
  parseError: boolean;
  data: Record<string, unknown>;
}

/** A VS Code settings file (JSONC): present, parsed, and nothing more. */
export async function readJsoncLayer(path: string): Promise<SettingsLayer> {
  const text = await readText(path);
  if (text === null) return { path, present: false, parseError: false, data: {} };
  if (text.trim() === "") return { path, present: true, parseError: false, data: {} };
  const data = parseJsoncObject(text);
  return { path, present: true, parseError: data === null, data: data ?? {} };
}

/** The keys of a VS Code settings file this adapter models — nothing else is ever read. */
const COPILOT_SETTING = /^(chat\.|github\.copilot)/;

export function copilotKeysOf(layer: SettingsLayer): Record<string, unknown> {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(layer.data)) {
    if (COPILOT_SETTING.test(key)) kept[key] = value;
  }
  return redactSettings(kept);
}

/** Layers least specific first; a later layer wins per key (VS Code's own rule). */
export function mergeCopilotKeys(layers: readonly SettingsLayer[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) {
    if (layer.parseError) continue;
    for (const [key, value] of Object.entries(copilotKeysOf(layer))) out[key] = value;
  }
  return out;
}

export function booleanSetting(
  settings: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = settings[key];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * A `chat.*FilesLocations` map (path → boolean). Layers merge per entry, the most specific
 * layer winning — that is how a repository's `.vscode/settings.json` re-enables a directory the
 * user disabled.
 */
export function locationMap(
  settings: Record<string, unknown>,
  key: string,
): Record<string, boolean> {
  const value = settings[key];
  if (!isRecord(value)) return {};
  const out: Record<string, boolean> = {};
  for (const [path, enabled] of Object.entries(value)) {
    if (typeof enabled === "boolean") out[path] = enabled;
  }
  return out;
}

export interface Location {
  /** The entry as written in settings (`.github/instructions`, `~/.copilot/instructions`). */
  raw: string;
  path: string;
  enabled: boolean;
  /** `true` for a directory this adapter scans even without a settings entry. */
  isDefault: boolean;
  /** `~`-rooted entries belong to the user scope, never to a Project. */
  userScope: boolean;
}

/**
 * The directories one discovery kind covers for a base directory: the documented defaults plus
 * every entry of the settings map, `~` expanded to the home directory. A disabled entry is kept
 * (its files load with `mode: "disabled"`), a `~` entry is marked so the caller reads it once at
 * user scope instead of once per Project.
 */
export function locationsOf(
  map: Record<string, boolean>,
  defaults: readonly string[],
  base: string,
  home: string,
): Location[] {
  const engine = pathEngine(base);
  const out: Location[] = [];
  const seen = new Set<string>();
  const add = (raw: string, enabled: boolean, isDefault: boolean): void => {
    const userScope = raw === "~" || raw.startsWith("~/");
    const path = userScope
      ? engine.join(home, raw.slice(1).replace(/^[\\/]/, ""))
      : engine.isAbsolute(raw)
        ? engine.resolve(raw)
        : engine.join(base, raw);
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ raw, path, enabled, isDefault, userScope });
  };
  for (const raw of defaults) add(raw, true, true);
  for (const [raw, enabled] of Object.entries(map)) add(raw, enabled, false);
  return out;
}

/**
 * Ticket 06 §7: a `.github/` directory qualifies as Copilot's only through one of the named
 * markers. A repository whose `.github/` holds workflows, a CODEOWNERS file and a Dependabot
 * configuration carries no Copilot customisation at all, and `.vscode/settings.json` alone is
 * not a marker either — such a member is never read by this adapter.
 */
export const QUALIFYING_MARKERS: readonly string[] = [
  ".github/copilot-instructions.md",
  ".github/instructions",
  ".github/skills",
  ".github/agents",
  ".github/prompts",
  ".github/mcp.json",
  ".vscode/mcp.json",
];

export async function qualifiesAsCopilot(dir: string): Promise<boolean> {
  const engine = pathEngine(dir);
  const found = await Promise.all(
    QUALIFYING_MARKERS.map(async (marker) => {
      const path = engine.join(dir, ...marker.split("/"));
      return marker.endsWith(".md") || marker.endsWith(".json") ? isFile(path) : isDirectory(path);
    }),
  );
  return found.includes(true);
}
