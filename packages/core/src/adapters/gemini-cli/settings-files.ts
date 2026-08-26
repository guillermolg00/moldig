/* oxlint-disable no-await-in-loop -- sequential on purpose: bounded disk IO and a stable emit order */
/**
 * The files Gemini CLI reads for configuration and state (research 02; spec §9). D142: a
 * `settings-file` is always `protection: "never"` with `removal.method: "none"` — its entries are
 * deletable, the file never is. Credentials are **stat only** (D65): moldig records that they
 * exist and nothing else, so a test can spy on `readFile` and prove no path matching the secret
 * names was ever opened.
 */
import { basename, join } from "node:path";
import type { SettingsFile } from "../../index/types.js";
import { formatOf } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isFile, listDir, readText } from "../../scan/fs.js";
import { addEntity, baseEntity, providedBy, type GeminiScan } from "./model.js";
import { hooksOf, parseJsonc, parseToml } from "./settings.js";
import { mcpEntryCount } from "./mcp.js";

export interface FileInput {
  path: string;
  role: SettingsFile["role"];
  scope: SettingsFile["scope"];
  project: DiscoveredProject | null;
  ownership: SettingsFile["ownership"];
  entries?: number | null;
  sensitiveKeys?: readonly string[];
  /** `true` for a credential store: stat only, never opened. */
  credentials?: boolean;
  format?: SettingsFile["format"];
}

export async function settingsFileEntity(
  scan: GeminiScan,
  input: FileInput,
): Promise<SettingsFile | null> {
  if (!(await isFile(input.path))) return null;
  const credentials = input.credentials === true;
  const text = credentials ? null : await readText(input.path);
  const data =
    text === null || text.trim() === ""
      ? null
      : input.path.endsWith(".toml")
        ? parseToml(text)
        : parseJsonc(text);
  const keys = data === null ? [] : Object.keys(data);
  const base = baseEntity(scan, {
    kind: "settings-file",
    path: input.path,
    scope: input.scope,
    project: input.project,
    ownership: input.ownership,
    locator: { type: "file", path: input.path },
    format: input.format ?? formatOf(input.path),
    label: basename(input.path),
    sensitive: credentials || keys.some((key) => (input.sensitiveKeys ?? []).includes(key)),
    protection: "never",
    removal: { method: "none" },
    metrics: await scan.ctx.fileMetrics(input.path, null),
  });
  // `entries` counts what the file configures: MCP servers, for the files that hold them.
  const entries =
    input.entries !== undefined
      ? input.entries
      : data !== null && (input.role === "settings" || input.role === "manifest")
        ? mcpEntryCount(data)
        : null;
  const entity: SettingsFile = {
    ...base,
    kind: "settings-file",
    role: input.role,
    topLevelKeys: keys,
    entries,
    hooks: data === null ? [] : hooksOf(data),
  };
  return addEntity(scan, entity);
}

/** The credential stores moldig lists but never opens (D65; fixture from-docs edge 13). */
const CREDENTIALS = [
  "oauth_creds.json",
  "google_accounts.json",
  "mcp-oauth-tokens.json",
  "a2a-oauth-tokens.json",
  ".env",
];

export async function collectSettingsFiles(
  scan: GeminiScan,
  projects: readonly DiscoveredProject[],
): Promise<void> {
  const { paths } = scan;
  for (const path of [paths.systemDefaults, paths.systemSettings]) {
    await settingsFileEntity(scan, {
      path,
      role: "settings",
      scope: "system",
      project: null,
      ownership: "human",
      entries: null,
    });
  }
  await settingsFileEntity(scan, {
    path: join(paths.geminiDir, "settings.json"),
    role: "settings",
    scope: "user",
    project: null,
    ownership: "human",
    entries: mcpEntryCount(scan.userSettings.data),
    sensitiveKeys: ["mcpServers"],
  });
  for (const [name, role, ownership] of [
    ["projects.json", "state", "harness"],
    ["trustedFolders.json", "state", "harness"],
    ["keybindings.json", "settings", "human"],
    ["policy_integrity.json", "policy", "harness"],
  ] as const) {
    await settingsFileEntity(scan, {
      path: join(paths.geminiDir, name),
      role,
      scope: "user",
      project: null,
      ownership,
    });
  }
  await settingsFileEntity(scan, {
    path: join(paths.geminiDir, "acknowledgments", "agents.json"),
    role: "state",
    scope: "user",
    project: null,
    ownership: "harness",
  });
  // `installation_id` holds an opaque id, not a document: no keys, no format.
  await settingsFileEntity(scan, {
    path: join(paths.geminiDir, "installation_id"),
    role: "state",
    scope: "user",
    project: null,
    ownership: "harness",
    format: "other",
  });
  for (const entry of (await listDir(paths.policiesDir)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
    await settingsFileEntity(scan, {
      path: join(paths.policiesDir, entry.name),
      role: "policy",
      scope: "user",
      project: null,
      ownership: entry.name === "auto-saved.toml" ? "harness" : "human",
    });
  }
  await settingsFileEntity(scan, {
    path: join(paths.extensionsDir, "extension-enablement.json"),
    role: "state",
    scope: "user",
    project: null,
    ownership: "harness",
  });
  for (const name of CREDENTIALS) {
    await settingsFileEntity(scan, {
      path: join(paths.geminiDir, name),
      role: "credentials",
      scope: "user",
      project: null,
      ownership: "human",
      credentials: true,
    });
  }

  for (const extension of scan.extensions) {
    const manifest = await settingsFileEntity(scan, {
      path: join(extension.dir, "gemini-extension.json"),
      role: "manifest",
      scope: "user",
      project: null,
      ownership: "human",
      entries: mcpEntryCount(extension.manifest),
    });
    if (manifest !== null) providedBy(scan, manifest.id, extension.entity);
    const install = await settingsFileEntity(scan, {
      path: join(extension.dir, ".gemini-extension-install.json"),
      role: "plugin-registry",
      scope: "user",
      project: null,
      ownership: "harness",
    });
    if (install !== null) providedBy(scan, install.id, extension.entity);
    const hooks = await settingsFileEntity(scan, {
      path: join(extension.dir, "hooks", "hooks.json"),
      role: "hooks",
      scope: "user",
      project: null,
      ownership: "human",
    });
    if (hooks !== null) providedBy(scan, hooks.id, extension.entity);
    const env = await settingsFileEntity(scan, {
      path: join(extension.dir, ".env"),
      role: "credentials",
      scope: "user",
      project: null,
      ownership: "human",
      credentials: true,
    });
    if (env !== null) providedBy(scan, env.id, extension.entity);
    for (const entry of (await listDir(join(extension.dir, "policies"))).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
      const policy = await settingsFileEntity(scan, {
        path: join(extension.dir, "policies", entry.name),
        role: "policy",
        scope: "user",
        project: null,
        ownership: "human",
      });
      if (policy !== null) providedBy(scan, policy.id, extension.entity);
    }
  }

  for (const project of projects) {
    if (project.reachability !== "present") continue;
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      const dir = join(member.path, ".gemini");
      // An untrusted Project's settings file is still listed; only its layer is ignored (D72).
      await settingsFileEntity(scan, {
        path: join(dir, "settings.json"),
        role: "settings",
        scope: "project",
        project,
        ownership: "human",
        sensitiveKeys: ["mcpServers"],
      });
      await settingsFileEntity(scan, {
        path: join(dir, ".env"),
        role: "credentials",
        scope: "project",
        project,
        ownership: "human",
        credentials: true,
      });
    }
  }
}
