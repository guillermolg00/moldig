/* oxlint-disable no-await-in-loop -- sequential on purpose: bounded disk IO and a stable order */
/**
 * The configuration files Copilot reads on either surface (research 02 [78]; ticket 08 §1
 * "never"): `~/.copilot/{config.json, settings.json, lsp-config.json, permissions-config.json,
 * mcp-config.json}`, the credential stores beside them, VS Code's `settings.json`, `mcp.json`
 * and `globalStorage/storage.json`, and each member's `.vscode/settings.json` and MCP files.
 *
 * D142: a settings file is always `protection: "never"` with `removal.method: "none"` — its
 * *entries* are deletable, the file never is. The credential stores (`mcp-oauth-config/`,
 * `mcp-secrets/`) are stat'ed and nothing more: `topLevelKeys: []`, no parse, no read.
 */
import { basename, join } from "node:path";
import type { EntityBase, Format, SettingsFile } from "../../index/types.js";
import { warning } from "../../scan/context.js";
import { isDirectory, isFile, readText, treeStats } from "../../scan/fs.js";
import { ageDays, toIso } from "../../scan/fs.js";
import { parseJsoncObject } from "./parse.js";
import { memberMcpFiles, userMcpFiles } from "./mcp.js";
import { addEntity, baseEntity, HARNESS, type CopilotScan, type MemberScope } from "./model.js";

export interface SettingsInput {
  path: string;
  role: SettingsFile["role"];
  scope: SettingsFile["scope"];
  project: MemberScope | null;
  ownership: SettingsFile["ownership"];
  format: Format;
  entries: number | null;
  sensitiveKeys: readonly string[];
  producer?: EntityBase["producer"];
}

async function settingsEntity(
  scan: CopilotScan,
  input: SettingsInput,
): Promise<SettingsFile | null> {
  if (!(await isFile(input.path))) return null;
  const text = await readText(input.path);
  const data = text === null || text.trim() === "" ? null : parseJsoncObject(text);
  if (text !== null && text.trim() !== "" && data === null) {
    scan.ctx.warn(
      warning(
        "parse-error",
        `${basename(input.path)} is not valid ${input.format === "jsonc" ? "JSONC" : "JSON"}`,
        HARNESS,
        input.path,
        "partial",
      ),
    );
  }
  const keys = data === null ? [] : Object.keys(data);
  const base = baseEntity(scan, {
    kind: "settings-file",
    path: input.path,
    scope: input.scope,
    project: input.project?.project ?? null,
    ownership: input.ownership,
    locator: { type: "file", path: input.path },
    format: input.format,
    sensitive: keys.some((key) => input.sensitiveKeys.includes(key)),
    protection: "never",
    removal: { method: "none" },
    ...(input.producer === undefined ? {} : { producer: input.producer }),
    metrics: await scan.ctx.fileMetrics(input.path, null),
  });
  const entity: SettingsFile = {
    ...base,
    kind: "settings-file",
    role: input.role,
    topLevelKeys: keys,
    entries: input.entries,
    hooks: [],
  };
  return addEntity(scan, entity);
}

/**
 * D65: a credential store is never opened at all. The row exists so the megabytes are honest
 * and the UI can say what it is; `topLevelKeys` stays empty because nothing was parsed.
 */
async function credentialStore(scan: CopilotScan, path: string): Promise<void> {
  if (!(await isDirectory(path))) return;
  const stats = await treeStats(path);
  const base = baseEntity(scan, {
    kind: "settings-file",
    path,
    scope: "user",
    project: null,
    ownership: "harness",
    locator: { type: "dir", path },
    format: "dir",
    sensitive: true,
    protection: "never",
    removal: { method: "none" },
    metrics: {
      bytes: stats.bytes,
      files: stats.files,
      lines: null,
      mtime: stats.newestMs === null ? null : toIso(stats.newestMs),
      ageDays: stats.newestMs === null ? null : ageDays(stats.newestMs, scan.ctx.options.now),
      tokens: null,
      lastUsed: null,
    },
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

function entriesOf(scan: CopilotScan, path: string): number | null {
  return scan.mcpEntries.get(scan.ctx.identity.fold(path)) ?? null;
}

const VSCODE_PRODUCER: EntityBase["producer"] = { harness: "other-app", surface: "vscode" };

export async function collectSettingsFiles(
  scan: CopilotScan,
  members: readonly MemberScope[],
): Promise<void> {
  const { paths } = scan;
  await settingsEntity(scan, {
    path: scan.config.path,
    role: "settings",
    scope: "user",
    project: null,
    // The CLI writes this file itself (the banner, the logged-in users, the trusted folders).
    ownership: "harness",
    format: "json",
    entries: null,
    sensitiveKeys: ["logged_in_users", "last_logged_in_user"],
  });
  for (const name of ["settings.json", "lsp-config.json"]) {
    await settingsEntity(scan, {
      path: join(paths.cliHome, name),
      role: "settings",
      scope: "user",
      project: null,
      ownership: "human",
      format: "json",
      entries: null,
      sensitiveKeys: [],
    });
  }
  await settingsEntity(scan, {
    path: join(paths.cliHome, "permissions-config.json"),
    role: "policy",
    scope: "user",
    project: null,
    ownership: "human",
    format: "json",
    entries: null,
    sensitiveKeys: [],
  });
  for (const store of ["mcp-oauth-config", "mcp-secrets"]) {
    await credentialStore(scan, join(paths.cliHome, store));
  }
  for (const file of userMcpFiles(scan)) {
    await settingsEntity(scan, {
      path: file.path,
      role: "mcp-config",
      scope: "user",
      project: null,
      ownership: "human",
      format: file.jsonc ? "jsonc" : "json",
      entries: entriesOf(scan, file.path),
      sensitiveKeys: [],
      ...(file.surface === "vscode" ? { producer: VSCODE_PRODUCER } : {}),
    });
  }
  await settingsEntity(scan, {
    path: join(paths.vscodeUser, "settings.json"),
    role: "settings",
    scope: "user",
    project: null,
    ownership: "human",
    format: "jsonc",
    entries: null,
    sensitiveKeys: [],
    producer: VSCODE_PRODUCER,
  });
  // `storage.json` carries VS Code's own path maps. D29 lists them as a `workspace-record`
  // source with `readInV1: false`: the row is here, the rows inside it are not read.
  await settingsEntity(scan, {
    path: join(paths.globalStorage, "storage.json"),
    role: "state",
    scope: "user",
    project: null,
    ownership: "harness",
    format: "json",
    entries: null,
    sensitiveKeys: ["telemetry.machineId", "telemetry.devDeviceId", "telemetry.sqmId"],
    producer: VSCODE_PRODUCER,
  });

  for (const scope of members) {
    await settingsEntity(scan, {
      path: join(scope.path, ".vscode", "settings.json"),
      role: "settings",
      scope: "project",
      project: scope,
      ownership: "human",
      format: "jsonc",
      entries: null,
      sensitiveKeys: [],
    });
    for (const file of memberMcpFiles(scope.path)) {
      await settingsEntity(scan, {
        path: file.path,
        role: "mcp-config",
        scope: "project",
        project: scope,
        ownership: "human",
        format: file.jsonc ? "jsonc" : "json",
        entries: entriesOf(scan, file.path),
        sensitiveKeys: [],
      });
    }
  }
}
