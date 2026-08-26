/* oxlint-disable no-await-in-loop -- sequential on purpose: ordered, bounded disk IO */
/**
 * The files Codex reads its configuration from (§1.7): `config.toml` and its profile siblings,
 * `rules/*.rules` (Starlark approval policy), `hooks.json`, the desktop app's
 * `.codex-global-state.json`, and the credential material that is only ever stat'ed (D65).
 *
 * D142: a settings file is always `protection: "never"` with `removal.method: "none"` — its
 * *entries* are removable, the file never is.
 */
import { basename, join } from "node:path";
import type { AgentDefinition, HookDecl, SettingsFile } from "../../index/types.js";
import { warning } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import {
  isDirectory,
  isFile,
  isRecord,
  listDir,
  readJsonObject,
  readText,
  statOrNull,
} from "../../scan/fs.js";
import { addEntity, baseEntity, evidence, loadedBy, type CodexScan } from "./model.js";
import { CREDENTIAL_NAMES, CREDENTIAL_SHAPE } from "./paths.js";
import { configIsSensitive, hooksOf } from "./state.js";
import { tablesOf, type TomlFile } from "./toml.js";
import { redactString } from "../claude-code/state.js";

export interface SettingsInput {
  path: string;
  role: SettingsFile["role"];
  scope: SettingsFile["scope"];
  project: DiscoveredProject | null;
  ownership: SettingsFile["ownership"];
  format: SettingsFile["format"];
  topLevelKeys: string[];
  entries: number | null;
  hooks: HookDecl[];
  sensitive: boolean;
  producer?: SettingsFile["producer"];
}

async function settingsEntity(scan: CodexScan, input: SettingsInput): Promise<SettingsFile | null> {
  if ((await statOrNull(input.path)) === null) return null;
  const base = baseEntity(scan, {
    kind: "settings-file",
    path: input.path,
    scope: input.scope,
    project: input.project,
    ownership: input.ownership,
    locator:
      input.format === "dir"
        ? { type: "dir", path: input.path }
        : { type: "file", path: input.path },
    format: input.format,
    label: basename(input.path),
    sensitive: input.sensitive,
    protection: "never",
    removal: { method: "none" },
    metrics: await scan.ctx.fileMetrics(input.path, null),
    ...(input.producer === undefined ? {} : { producer: input.producer }),
  });
  const entity: SettingsFile = {
    ...base,
    kind: "settings-file",
    role: input.role,
    topLevelKeys: input.topLevelKeys,
    entries: input.entries,
    hooks: input.hooks,
  };
  return addEntity(scan, entity);
}

/** `prefix_rule(` occurrences — the entry count of a Starlark policy file (§1.7). */
function ruleCount(text: string): number {
  return text.split("prefix_rule(").length - 1;
}

async function rulesFiles(dir: string): Promise<string[]> {
  return (await listDir(dir))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".rules"))
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((entry) => join(dir, entry.name));
}

async function collectRules(
  scan: CodexScan,
  dir: string,
  scope: SettingsFile["scope"],
  project: DiscoveredProject | null,
): Promise<void> {
  for (const path of await rulesFiles(dir)) {
    const text = await readText(path);
    await settingsEntity(scan, {
      path,
      role: "policy",
      scope,
      project,
      ownership: "human",
      format: "starlark",
      topLevelKeys: [],
      entries: text === null ? null : ruleCount(text),
      hooks: [],
      sensitive: false,
    });
  }
}

/** How many hook objects a `hooks.json` declares (its `entries`), the decoded list beside it. */
async function collectHooks(
  scan: CodexScan,
  path: string,
  scope: SettingsFile["scope"],
  project: DiscoveredProject | null,
): Promise<void> {
  if (!(await isFile(path))) return;
  const text = await readText(path);
  const data = await readJsonObject(path);
  if (text !== null && text.trim() !== "" && data === null) {
    scan.ctx.warn(warning("parse-error", "hooks.json is not valid JSON", "codex", path, "partial"));
  }
  const hooks = data === null ? [] : hooksOf(data);
  await settingsEntity(scan, {
    path,
    role: "hooks",
    scope,
    project,
    ownership: "human",
    format: "json",
    topLevelKeys: data === null ? [] : Object.keys(data),
    entries: hooks.length,
    hooks,
    sensitive: false,
  });
}

/** Whether any `[mcp_servers.*]` table of a layer carries a literal secret (the `sensitive` rule). */
function hasSecretEntry(scan: CodexScan, file: string): boolean {
  const fold = scan.ctx.identity.fold;
  for (const entity of scan.entities.values()) {
    if (entity.kind !== "mcp-server") continue;
    if (fold(entity.path) !== fold(file)) continue;
    if (entity.secretKeys.length > 0) return true;
  }
  return false;
}

async function collectConfig(
  scan: CodexScan,
  file: TomlFile,
  scope: SettingsFile["scope"],
  project: DiscoveredProject | null,
): Promise<void> {
  if (!file.present) return;
  if (file.parseError) {
    scan.ctx.warn(
      warning(
        "parse-error",
        `${basename(file.path)} is not valid TOML: its entries are skipped (${file.errorMessage ?? "unknown error"})`,
        "codex",
        file.path,
        "partial",
      ),
    );
  }
  await settingsEntity(scan, {
    path: file.path,
    role: "settings",
    scope,
    project,
    ownership: "human",
    format: "toml",
    topLevelKeys: file.topLevelKeys,
    entries: tablesOf(file.data, "mcp_servers").length,
    // §1.7: the `[hooks]` table inside `config.toml` is not decoded into `HookDecl`s — its shape
    // (`[hooks.<id>.<id>] trusted_hash`) is a trust ledger, not a hook declaration.
    hooks: [],
    sensitive: configIsSensitive(file.data, hasSecretEntry(scan, file.path)),
  });
}

/** `[agents.<name>]` tables: an agent definition whose loading rule Codex does not publish. */
async function collectAgents(
  scan: CodexScan,
  file: TomlFile,
  scope: SettingsFile["scope"],
  project: DiscoveredProject | null,
): Promise<void> {
  for (const [name, table] of tablesOf(file.data, "agents")) {
    const frontmatter: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(table)) {
      frontmatter[key] = typeof value === "string" ? redactString(value, key) : value;
    }
    const base = baseEntity(scan, {
      kind: "agent-definition",
      path: file.path,
      keyPath: ["agents", name],
      scope,
      project,
      ownership: "human",
      locator: { type: "entry", file: file.path, format: "toml", keyPath: ["agents", name] },
      format: "toml",
      label: name,
      sensitive: false,
      protection: "none",
      // D60: outside the user config `codex mcp remove` has no counterpart, and TOML is never
      // edited — the row is shown and refused.
      removal: { method: "none" },
      metrics: await scan.ctx.fileMetrics(file.path, null),
    });
    const entity: AgentDefinition = {
      ...base,
      kind: "agent-definition",
      name,
      form: "toml-table",
      frontmatter,
      hooks: [],
    };
    const added = addEntity(scan, entity);
    const reason = "Codex documents no loading rule for [agents] tables";
    loadedBy(scan, {
      from: added.id,
      project: project?.id ?? null,
      mode: "unknown",
      reason,
      placement: null,
      effectiveName: name,
      ordered: false,
      charsLoaded: null,
      importsResolved: null,
      tokensLoaded: null,
      disableModelInvocation: null,
      // D39: an agent definition never enters the Headline number, for any harness.
      countsTowardHeadline: false,
      confidence: "medium",
      evidence: [evidence("loading-rule", reason)],
    });
  }
}

/** Credential material: stat only, never opened, never actionable (§0, D65). */
export async function credentialEntity(scan: CodexScan, path: string): Promise<void> {
  const directory = await isDirectory(path);
  await settingsEntity(scan, {
    path,
    role: "credentials",
    scope: "user",
    project: null,
    ownership: "harness",
    format: directory ? "dir" : "json",
    topLevelKeys: [],
    entries: null,
    hooks: [],
    sensitive: true,
  });
}

/** `true` when a top-level entry of `$CODEX_HOME` is credential material and must not be opened. */
export function isCredentialName(name: string): boolean {
  return CREDENTIAL_NAMES.includes(name) || CREDENTIAL_SHAPE.test(name);
}

export async function collectSettingsFiles(
  scan: CodexScan,
  projects: readonly DiscoveredProject[],
): Promise<void> {
  await collectConfig(scan, scan.config, "user", null);
  await collectAgents(scan, scan.config, "user", null);
  for (const profile of scan.profileFiles) {
    await collectConfig(scan, profile, "user", null);
    await collectAgents(scan, profile, "user", null);
  }
  await collectRules(scan, join(scan.paths.dir, "rules"), "user", null);
  await collectHooks(scan, join(scan.paths.dir, "hooks.json"), "user", null);

  // The desktop app's own state: harness-owned, never edited, and its `local-projects` map is a
  // breadcrumb source moldig does not read in v1 (§1.3).
  const stateData = await readJsonObject(scan.paths.globalState);
  const localProjects = stateData?.["local-projects"];
  await settingsEntity(scan, {
    path: scan.paths.globalState,
    role: "state",
    scope: "user",
    project: null,
    ownership: "harness",
    format: "json",
    topLevelKeys: stateData === null ? [] : Object.keys(stateData),
    entries: isRecord(localProjects) ? Object.keys(localProjects).length : null,
    hooks: [],
    sensitive: false,
    producer: { harness: "codex", surface: "desktop" },
  });

  for (const name of CREDENTIAL_NAMES) {
    await credentialEntity(scan, join(scan.paths.dir, name));
  }

  for (const project of projects) {
    for (const layer of scan.projectLayers.get(project.id) ?? []) {
      await collectConfig(scan, layer.file, "project", project);
      await collectAgents(scan, layer.file, "project", project);
      await collectRules(scan, join(layer.dir, ".codex", "rules"), "project", project);
      await collectHooks(scan, join(layer.dir, ".codex", "hooks.json"), "project", project);
    }
  }
}
