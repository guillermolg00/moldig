/**
 * The Codex configuration layers and the few values moldig models: trust levels, `[features]`,
 * `project_doc_max_bytes`, `project_root_markers`, `[history]`, `[skills]` and `[[skills.config]]`.
 * Values that may hold secrets never reach the index unredacted: D64's one rule runs over every
 * layer, and the three maps Codex fills with environment material (`env`, `http_headers`,
 * `env_http_headers`) plus `shell_environment_policy.set` lose their values by key name first.
 */
import type { HookDecl } from "../../index/types.js";
import { isRecord, isStringArray } from "../../scan/fs.js";
import {
  effectiveSettings as mergeLayers,
  hooksOf as jsonHooksOf,
  type SettingsLayer,
} from "../claude-code/state.js";
import { numberAt, valueAt, type TomlFile } from "./toml.js";

/** Ticket 07's default: 32 KiB of instruction files per session (research 02, research 05). */
export const DEFAULT_DOC_MAX_BYTES = 32_768;

/** Codex's own default project root marker set (`config.project_root_markers`). */
export const DEFAULT_ROOT_MARKERS: readonly string[] = [".git"];

/** Maps whose values are environment material, redacted per key before anything else (§1.2). */
const VALUE_MAPS = new Set(["env", "http_headers", "env_http_headers"]);

function blankMapValues(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).map((key) => [key, "<redacted>"]));
}

/**
 * A layer with its environment maps emptied of values. Runs before D64 so a header or a shell
 * variable whose name looks harmless (`entry-1`) cannot carry its value into the index.
 */
function blankValueMaps(value: unknown, key: string | null): unknown {
  if (key !== null && VALUE_MAPS.has(key)) return blankMapValues(value);
  if (Array.isArray(value)) return value.map((item) => blankValueMaps(item, null));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, blankValueMaps(item, name)]),
    );
  }
  return value;
}

function withPolicySet(data: Record<string, unknown>): Record<string, unknown> {
  const policy = data["shell_environment_policy"];
  if (!isRecord(policy) || !isRecord(policy["set"])) return data;
  return { ...data, shell_environment_policy: { ...policy, set: blankMapValues(policy["set"]) } };
}

function layerOf(file: TomlFile): SettingsLayer {
  return {
    path: file.path,
    present: file.present,
    parseError: file.parseError,
    data: file.data,
  };
}

/** Every layer merged, unredacted: what the adapter's own logic reads (paths, numbers, flags). */
export function rawSettings(layers: readonly TomlFile[]): Record<string, unknown> {
  return mergeLayersRaw(layers.map(layerOf));
}

function mergeLayersRaw(layers: readonly SettingsLayer[]): Record<string, unknown> {
  // `mergeLayers` redacts; the raw merge is the same precedence with nothing removed, which is
  // what `sqlite_home`, `log_dir` and `project_doc_max_bytes` need before D64 rewrites them.
  const out: Record<string, unknown> = {};
  for (const layer of layers) if (!layer.parseError) mergeInto(out, layer.data);
  return out;
}

function mergeInto(target: Record<string, unknown>, layer: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(layer)) {
    const current = target[key];
    if (Array.isArray(current) && Array.isArray(value)) {
      target[key] = value;
    } else if (isRecord(current) && isRecord(value)) {
      const nested = { ...current };
      mergeInto(nested, value);
      target[key] = nested;
    } else {
      target[key] = value;
    }
  }
}

/** The same layers as `Harness.effectiveSettings` sees them: secrets gone (D64 + §1.2's maps). */
export function effectiveSettings(layers: readonly TomlFile[]): Record<string, unknown> {
  return mergeLayers(
    layers.map((file) => {
      const blanked = blankValueMaps(file.data, null);
      const data = isRecord(blanked) ? withPolicySet(blanked) : {};
      return { ...layerOf(file), data };
    }),
  );
}

/** `[features] <name>`: `true`, `false`, or `null` when the flag is not set at all. */
export function featureFlag(settings: Record<string, unknown>, name: string): boolean | null {
  const value = valueAt(settings, "features", name);
  return typeof value === "boolean" ? value : null;
}

/** The instruction-chain cap in force: `project_doc_max_bytes`, else 32 KiB (research 05). */
export function docMaxBytes(settings: Record<string, unknown>): number {
  const value = numberAt(settings, "project_doc_max_bytes");
  return value === null || value <= 0 ? DEFAULT_DOC_MAX_BYTES : value;
}

/** `project_doc_fallback_filenames`: extra instruction file names, in order, after `AGENTS.md`. */
export function fallbackDocNames(settings: Record<string, unknown>): string[] {
  const value = settings["project_doc_fallback_filenames"];
  return isStringArray(value) ? value : [];
}

/** `project_root_markers`: what makes a directory the project root of the chain (default `.git`). */
export function rootMarkers(settings: Record<string, unknown>): string[] {
  const value = settings["project_root_markers"];
  return isStringArray(value) && value.length > 0 ? value : [...DEFAULT_ROOT_MARKERS];
}

/** `[history] max_bytes` — the only retention number Codex publishes (ticket 08 §1). */
export function historyMaxBytes(settings: Record<string, unknown>): number | null {
  return numberAt(settings, "history", "max_bytes");
}

/** `[skills] bundled = false` switches the whole `.system/` tier off (research 02 config shape). */
export function bundledSkillsEnabled(settings: Record<string, unknown>): boolean {
  const value = valueAt(settings, "skills", "bundled");
  return value !== false;
}

export interface SkillConfigEntry {
  path: string | null;
  name: string | null;
  enabled: boolean | null;
}

/** `[[skills.config]]` — per-skill switches, matched by folded realpath or by name (§1.5). */
export function skillConfig(settings: Record<string, unknown>): SkillConfigEntry[] {
  const value = valueAt(settings, "skills", "config");
  if (!Array.isArray(value)) return [];
  const out: SkillConfigEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    out.push({
      path: typeof item["path"] === "string" ? item["path"] : null,
      name: typeof item["name"] === "string" ? item["name"] : null,
      enabled: typeof item["enabled"] === "boolean" ? item["enabled"] : null,
    });
  }
  return out;
}

/** `[projects."<path>"] trust_level` as a tri-state; an unknown level is "no answer", not false. */
export function trustedFrom(level: string | null): boolean | null {
  if (level === "trusted") return true;
  if (level === "untrusted") return false;
  return null;
}

/**
 * `hooks.json` as `HookDecl`s. Codex's file has exactly the shape Claude Code's settings use
 * (`{"hooks": {"<Event>": [{matcher, hooks: [{type, command, …}]}]}}`), so the one decoder
 * serves both and commands pass through D40's redaction on the way.
 */
export function hooksOf(data: Record<string, unknown>): HookDecl[] {
  return jsonHooksOf(data);
}

/** `sensitive` of a `config.toml`: an MCP entry with a literal secret, or a shell env policy. */
export function configIsSensitive(data: Record<string, unknown>, hasSecretKeys: boolean): boolean {
  return hasSecretKeys || isRecord(valueAt(data, "shell_environment_policy", "set"));
}
