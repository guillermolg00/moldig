/* oxlint-disable no-await-in-loop -- sequential on purpose: emission order and bounded disk IO depend on it */
/**
 * The settings files Cursor reads (research 02 §Cursor; spec §1.7): `mcp.json` at user and
 * project scope, `cli-config.json`, `argv.json`, `ide_state.json`, `hooks.json`,
 * `permissions.json`, the project's `worktrees.json` / `environment.json` / `cli.json`, the IDE's
 * `User/settings.json` and `User/globalStorage/storage.json`, plus the MDM `hooks.json` on macOS.
 *
 * D142: a settings file is never deleted — its **entries** are edited out — so every row here is
 * `protection: "never"`, `removal: {method: "none"}`. Only `cli-config.json` and
 * `User/settings.json` contribute values (§1.2); every other file contributes key names.
 */
import { join } from "node:path";
import type { HookDecl, SettingsFile } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isFile, isRecord } from "../../scan/fs.js";
import { warning } from "../../scan/context.js";
import { addEntity, baseEntity, HARNESS, type CursorScan } from "./model.js";
import { readSettingsLayer, redactString } from "./settings.js";

export interface Input {
  path: string;
  role: SettingsFile["role"];
  scope: SettingsFile["scope"];
  project: DiscoveredProject | null;
  ownership: SettingsFile["ownership"];
  sensitive: boolean;
  entries?: number | null;
  jsonc?: boolean;
}

/**
 * Cursor's hook shape (research 02 [25]): `{"version":1,"hooks":{"<event>":[{command,type,…}]}}`
 * — one level flatter than Claude Code's. D40 sends the command through the shared secret rule.
 */
export function hooksOf(data: Record<string, unknown>): HookDecl[] {
  const hooks = data["hooks"];
  if (!isRecord(hooks)) return [];
  const out: HookDecl[] = [];
  for (const [event, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (!isRecord(entry)) continue;
      const command = typeof entry["command"] === "string" ? entry["command"] : null;
      out.push({
        event,
        type: typeof entry["type"] === "string" ? entry["type"] : "command",
        command: command === null ? null : redactString(command, null),
        matcher: typeof entry["matcher"] === "string" ? entry["matcher"] : null,
      });
    }
  }
  return out;
}

export async function settingsEntity(scan: CursorScan, input: Input): Promise<SettingsFile | null> {
  if (!(await isFile(input.path))) return null;
  const layer = await readSettingsLayer(input.path, input.jsonc === true);
  if (layer.parseError) {
    scan.ctx.warn(
      warning("parse-error", "settings file is not valid JSON", HARNESS, input.path, "partial"),
    );
  }
  const base = baseEntity(scan, {
    kind: "settings-file",
    path: input.path,
    scope: input.scope,
    project: input.project,
    ownership: input.ownership,
    locator: { type: "file", path: input.path },
    format: input.jsonc === true ? "jsonc" : "json",
    sensitive: input.sensitive,
    // D142: the file itself is never removable, whatever moldig can do with its entries.
    protection: "never",
    removal: { method: "none" },
    metrics: await scan.ctx.fileMetrics(input.path, null),
  });
  const entity: SettingsFile = {
    ...base,
    kind: "settings-file",
    role: input.role,
    topLevelKeys: Object.keys(layer.data),
    entries: input.entries ?? null,
    hooks: input.role === "hooks" ? hooksOf(layer.data) : [],
  };
  return addEntity(scan, entity);
}

async function serverCount(path: string): Promise<number | null> {
  const layer = await readSettingsLayer(path);
  if (!layer.present) return null;
  const servers = layer.data["mcpServers"];
  return isRecord(servers) ? Object.keys(servers).length : null;
}

export async function collectSettingsFiles(
  scan: CursorScan,
  projects: readonly DiscoveredProject[],
): Promise<void> {
  const { configDir, userDir, globalStorage } = scan.paths;
  const userMcp = join(configDir, "mcp.json");
  await settingsEntity(scan, {
    path: userMcp,
    role: "mcp-config",
    scope: "user",
    project: null,
    ownership: "human",
    sensitive: true,
    entries: await serverCount(userMcp),
  });
  for (const name of ["cli-config.json", "argv.json"]) {
    await settingsEntity(scan, {
      path: join(configDir, name),
      role: "settings",
      scope: "user",
      project: null,
      ownership: "human",
      sensitive: false,
    });
  }
  await settingsEntity(scan, {
    path: join(configDir, "permissions.json"),
    role: "policy",
    scope: "user",
    project: null,
    ownership: "human",
    sensitive: false,
  });
  await settingsEntity(scan, {
    path: join(configDir, "hooks.json"),
    role: "hooks",
    scope: "user",
    project: null,
    ownership: "human",
    sensitive: false,
  });
  // Harness-owned state: read for its key names only (research 09 §1 — not a breadcrumb source).
  await settingsEntity(scan, {
    path: join(configDir, "ide_state.json"),
    role: "state",
    scope: "user",
    project: null,
    ownership: "harness",
    sensitive: false,
  });
  await settingsEntity(scan, {
    path: join(userDir, "settings.json"),
    role: "settings",
    scope: "user",
    project: null,
    ownership: "human",
    sensitive: false,
    jsonc: true,
  });
  await settingsEntity(scan, {
    path: join(globalStorage, "storage.json"),
    role: "state",
    scope: "user",
    project: null,
    ownership: "harness",
    sensitive: false,
  });
  // The MDM layer of a managed Mac (`/Library/Application Support/Cursor/hooks.json`, research 02
  // [25]) is a system layer outside `~`: D56 leaves those unread in v1, as the Claude Code slice
  // leaves its managed layer unread — and a scan over a fixture must not reach the real machine.

  for (const project of projects) {
    if (project.reachability !== "present") continue;
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      const dir = join(member.path, ".cursor");
      const mcp = join(dir, "mcp.json");
      await settingsEntity(scan, {
        path: mcp,
        role: "mcp-config",
        scope: "project",
        project,
        ownership: "human",
        sensitive: true,
        entries: await serverCount(mcp),
      });
      for (const name of ["worktrees.json", "environment.json"]) {
        await settingsEntity(scan, {
          path: join(dir, name),
          role: "settings",
          scope: "project",
          project,
          ownership: "human",
          sensitive: false,
        });
      }
      for (const name of ["cli.json", "permissions.json"]) {
        await settingsEntity(scan, {
          path: join(dir, name),
          role: "policy",
          scope: "project",
          project,
          ownership: "human",
          sensitive: false,
        });
      }
      await settingsEntity(scan, {
        path: join(dir, "hooks.json"),
        role: "hooks",
        scope: "project",
        project,
        ownership: "human",
        sensitive: false,
      });
    }
  }
}
