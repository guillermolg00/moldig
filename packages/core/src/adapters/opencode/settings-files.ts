/* oxlint-disable no-await-in-loop -- sequential on purpose: one row per file, bounded disk IO */
/**
 * The configuration files themselves (§2.7): every `opencode.json[c]` layer as a `settings`
 * file whose `entries` count is its `mcp` keys, the plugin workspace's `package.json` as a
 * harness-owned `manifest` (D62), and `auth.json` / `mcp-auth.json` as `credentials` rows that
 * are stat'ed and never opened (§0). D142: a settings file is always `protection: "never"` with
 * `removal.method: "none"` — its entries are deletable, the file never is. The workspace
 * lockfiles and `.gitignore` are not modelled (D62).
 */
import { basename, join } from "node:path";
import type { SettingsFile } from "../../index/types.js";
import { warning } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isFile, isRecord, readJsonObject } from "../../scan/fs.js";
import { formatOfConfig, mcpEntriesOf, type ConfigFile } from "./config.js";
import { addEntity, baseEntity, type OpenCodeScan } from "./model.js";

export const CREDENTIAL_FILES: readonly string[] = ["auth.json", "mcp-auth.json"];

/** One `opencode.json[c]` layer, plus the `parse-error` warning when it could not be read. */
export async function configSettingsEntity(
  scan: OpenCodeScan,
  layer: ConfigFile,
  project: DiscoveredProject | null,
): Promise<SettingsFile | null> {
  if (!layer.present) return null;
  if (layer.parseError) {
    scan.ctx.warn(
      warning(
        "parse-error",
        `${basename(layer.path)} is not valid JSON(C): its instructions, MCP servers and agents are skipped`,
        "opencode",
        layer.path,
        "partial",
      ),
    );
  }
  const entries = mcpEntriesOf(layer);
  const sensitive = entries.some(
    ([, entry]) => isRecord(entry["headers"]) || isRecord(entry["environment"]),
  );
  const base = baseEntity(scan, {
    kind: "settings-file",
    path: layer.path,
    scope: layer.scope,
    project,
    ownership: "human",
    locator: { type: "file", path: layer.path },
    format: formatOfConfig(layer.path),
    sensitive,
    protection: "never",
    removal: { method: "none" },
    metrics: await scan.ctx.fileMetrics(layer.path, null),
  });
  const entity: SettingsFile = {
    ...base,
    kind: "settings-file",
    role: "settings",
    topLevelKeys: Object.keys(layer.data),
    entries: entries.length,
    hooks: [],
  };
  return addEntity(scan, entity);
}

/** The plugin workspace `package.json` OpenCode writes (fixture edge case 9). */
async function manifestEntity(
  scan: OpenCodeScan,
  path: string,
  scope: "user" | "project",
  project: DiscoveredProject | null,
): Promise<void> {
  if (!(await isFile(path))) return;
  const data = await readJsonObject(path);
  const dependencies = data === null ? null : data["dependencies"];
  const base = baseEntity(scan, {
    kind: "settings-file",
    path,
    scope,
    project,
    ownership: "harness",
    locator: { type: "file", path },
    format: "json",
    sensitive: false,
    protection: "never",
    removal: { method: "none" },
    metrics: await scan.ctx.fileMetrics(path, null),
  });
  const entity: SettingsFile = {
    ...base,
    kind: "settings-file",
    role: "manifest",
    topLevelKeys: data === null ? [] : Object.keys(data),
    entries: isRecord(dependencies) ? Object.keys(dependencies).length : null,
    hooks: [],
  };
  addEntity(scan, entity);
}

/** §0: a credential store is stat'ed and never opened, whatever its size. */
async function credentialEntity(scan: OpenCodeScan, path: string): Promise<void> {
  if (!(await isFile(path))) return;
  const base = baseEntity(scan, {
    kind: "settings-file",
    path,
    scope: "user",
    project: null,
    ownership: "harness",
    locator: { type: "file", path },
    format: "json",
    sensitive: true,
    protection: "never",
    removal: { method: "none" },
    metrics: await scan.ctx.fileMetrics(path, null),
  });
  const entity: SettingsFile = {
    ...base,
    kind: "settings-file",
    role: "credentials",
    topLevelKeys: [],
    entries: null,
    hooks: [],
  };
  addEntity(scan, entity);
}

export async function collectSettingsFiles(
  scan: OpenCodeScan,
  projects: readonly DiscoveredProject[],
): Promise<void> {
  for (const layer of scan.layers) await configSettingsEntity(scan, layer, null);
  await manifestEntity(scan, join(scan.paths.configDir, "package.json"), "user", null);
  for (const name of CREDENTIAL_FILES) {
    await credentialEntity(scan, join(scan.paths.dataDir, name));
  }
  for (const project of projects) {
    if (project.reachability !== "present") continue;
    for (const layer of scan.projectLayers.get(project.id) ?? []) {
      await configSettingsEntity(scan, layer, project);
    }
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      await manifestEntity(
        scan,
        join(member.path, ".opencode", "package.json"),
        "project",
        project,
      );
    }
  }
}
