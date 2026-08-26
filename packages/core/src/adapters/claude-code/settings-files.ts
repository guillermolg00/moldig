/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * Settings files Claude Code reads (research 01 §3, ticket 08 §1): `~/.claude.json` (state,
 * sensitive: it carries `oauthAccount`; stat and top-level key names only), `settings.json` /
 * `settings.local.json` at user, project and local scope, `<repo>/.mcp.json`, and the
 * undocumented `projects/<slug>/sessions-index.json` (size-only). None is ever cleaned.
 */
import { basename, join } from "node:path";
import type { SettingsFile } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isFile, isRecord, readJsonObject, readText } from "../../scan/fs.js";
import { warning } from "../../scan/context.js";
import { addEntity, baseEntity, type ClaudeScan } from "./model.js";
import { hooksOf } from "./state.js";

export interface Input {
  path: string;
  role: SettingsFile["role"];
  scope: SettingsFile["scope"];
  project: DiscoveredProject | null;
  ownership: SettingsFile["ownership"];
  protection: SettingsFile["protection"];
  removal: SettingsFile["removal"];
  entries: number | null;
  sensitiveKeys: readonly string[];
  /** `null` for a store several harnesses share (a skill lock): the file belongs to none. */
  harness?: SettingsFile["harness"];
}

export async function settingsEntity(scan: ClaudeScan, input: Input): Promise<SettingsFile | null> {
  if (!(await isFile(input.path))) return null;
  const text = await readText(input.path);
  const data = await readJsonObject(input.path);
  if (text !== null && text.trim() !== "" && data === null) {
    scan.ctx.warn(
      warning(
        "parse-error",
        `${basename(input.path)} is not valid JSON`,
        "claude-code",
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
    project: input.project,
    ownership: input.ownership,
    locator: { type: "file", path: input.path },
    format: "json",
    sensitive: keys.some((key) => input.sensitiveKeys.includes(key)),
    protection: input.protection,
    removal: input.removal,
    metrics: await scan.ctx.fileMetrics(input.path, null),
  });
  const entity: SettingsFile = {
    ...base,
    harness: input.harness === undefined ? base.harness : input.harness,
    kind: "settings-file",
    role: input.role,
    topLevelKeys: keys,
    entries: input.entries,
    hooks: data === null ? [] : hooksOf(data),
  };
  return addEntity(scan, entity);
}

const SETTINGS_SENSITIVE = ["env", "apiKeyHelper", "awsCredentialExport"];

export async function collectSettingsFiles(
  scan: ClaudeScan,
  projects: DiscoveredProject[],
): Promise<void> {
  const { paths, claudeJson } = scan;
  const localEntries = claudeJson.projects.reduce(
    (sum, entry) => sum + Object.keys(entry.mcpServers).length,
    0,
  );
  await settingsEntity(scan, {
    path: claudeJson.path,
    role: "state",
    scope: "user",
    project: null,
    ownership: "harness",
    protection: "never",
    removal: { method: "none" },
    entries: Object.keys(claudeJson.mcpServers).length + localEntries,
    sensitiveKeys: ["oauthAccount", "userID", "machineID"],
  });
  for (const name of ["settings.json", "settings.local.json"]) {
    await settingsEntity(scan, {
      path: join(paths.configDir, name),
      role: "settings",
      scope: "user",
      project: null,
      ownership: "human",
      protection: "never",
      removal: { method: "none" },
      entries: null,
      sensitiveKeys: SETTINGS_SENSITIVE,
    });
  }
  // `~/.claude/.mcp.json`: a name Claude Code never reads (research 01 §4). D106 parses its entry
  // key names and endpoints — nothing else — and D53 files the Orphan finding that explains it.
  const userMcp = join(paths.configDir, ".mcp.json");
  const userMcpData = await readJsonObject(userMcp);
  await settingsEntity(scan, {
    path: userMcp,
    role: "mcp-config",
    scope: "user",
    project: null,
    ownership: "human",
    protection: "never",
    removal: { method: "none" },
    entries:
      userMcpData !== null && isRecord(userMcpData["mcpServers"])
        ? Object.keys(userMcpData["mcpServers"]).length
        : null,
    sensitiveKeys: [],
  });
  // The skill locks: shared stores, so they belong to no harness (ticket 07). Backup-edited by
  // the Delete flow, never removed (14 §1).
  for (const lock of scan.locks) {
    await settingsEntity(scan, {
      path: lock.path,
      role: "skill-lock",
      scope: lock.scope,
      project: lock.project,
      ownership: "human",
      protection: "never",
      removal: { method: "none" },
      entries: lock.entries.length,
      sensitiveKeys: [],
      harness: null,
    });
  }
  for (const { slug } of scan.slugs) {
    await settingsEntity(scan, {
      path: join(slug.dir, "sessions-index.json"),
      role: "state",
      scope: "user",
      project: null,
      ownership: "harness",
      protection: "undocumented",
      removal: { method: "none" },
      entries: null,
      sensitiveKeys: [],
    });
  }
  for (const project of projects) {
    if (project.reachability !== "present") continue;
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      await settingsEntity(scan, {
        path: join(member.path, ".claude", "settings.json"),
        role: "settings",
        scope: "project",
        project,
        ownership: "human",
        protection: "never",
        removal: { method: "none" },
        entries: null,
        sensitiveKeys: SETTINGS_SENSITIVE,
      });
      await settingsEntity(scan, {
        path: join(member.path, ".claude", "settings.local.json"),
        role: "settings",
        scope: "local",
        project,
        ownership: "human",
        protection: "never",
        removal: { method: "none" },
        entries: null,
        sensitiveKeys: SETTINGS_SENSITIVE,
      });
      const mcpFile = join(member.path, ".mcp.json");
      const mcp = await readJsonObject(mcpFile);
      await settingsEntity(scan, {
        path: mcpFile,
        role: "mcp-config",
        scope: "project",
        project,
        ownership: "human",
        // D142, ticket 14 §1: a settings file is never deleted — its entries are edited out.
        protection: "never",
        removal: { method: "none" },
        entries:
          mcp !== null && isRecord(mcp["mcpServers"])
            ? Object.keys(mcp["mcpServers"]).length
            : null,
        sensitiveKeys: [],
      });
    }
  }
}
