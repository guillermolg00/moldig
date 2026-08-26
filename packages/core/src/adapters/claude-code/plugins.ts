/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * Plugins, marketplaces and the plugin cache (research 01 §7, tickets 07/08 §1, §3, 14 §1).
 * Identity is the **install directory**: one `plugin` entity per `installed_plugins.json`
 * `installPath`, whatever the number of registry rows pointing at it. Everything the plugin
 * ships — skills, commands, agent definitions, MCP servers, hooks — is an entity of its own with
 * a `provided-by` edge back to it, and is never deletable alone (14 §1): the plugin falls whole,
 * through `claude plugin uninstall <plugin>@<marketplace>` (D93). What the registry does not
 * reference is harness cache: an unused cache version, a clone no `known_marketplaces.json`
 * names, a backup clone, a marketplace's `node_modules/` (D51).
 */
import { join } from "node:path";
import type {
  HookDecl,
  Locator,
  Origin,
  Plugin,
  ProvidedByEdge,
  Scope,
  SettingsFile,
} from "../../index/types.js";
import { warning } from "../../scan/context.js";
import type { DiscoveredProject, Located } from "../../scan/discovery.js";
import {
  ageDays,
  isDirectory,
  isFile,
  isRecord,
  listDir,
  readJsonObject,
  toIso,
  treeStats,
} from "../../scan/fs.js";
import { edgeId } from "../../scan/paths.js";
import { mcpEntity } from "./mcp.js";
import { cacheEntity, type UnitInput } from "./cache.js";
import {
  addEdge,
  addEntity,
  baseEntity,
  evidence,
  loadedBy,
  loadedByEdgeId,
  type ClaudeScan,
} from "./model.js";
import { settingsEntity } from "./settings-files.js";
import { collectFrom, skillDirEntity, type SkillSource } from "./skills.js";
import { hooksOf, lastUsedOf } from "./state.js";

/** One element of `installed_plugins.json` — the scope/project the plugin was installed for. */
export interface RegistryEntry {
  pluginId: string;
  plugin: string;
  marketplace: string | null;
  /** Position inside the plugin's array, as the entry locator spells it. */
  index: number;
  scope: Scope;
  projectPath: string | null;
  installPath: string;
  version: string | null;
  installedAt: string | null;
  lastUpdated: string | null;
  gitCommitSha: string | null;
}

export interface PluginRegistry {
  path: string;
  present: boolean;
  parseError: boolean;
  /** Neither the v2 shape nor the documented legacy one: an `unsupported-shape` warning. */
  unknownShape: boolean;
  pluginIds: string[];
  entries: RegistryEntry[];
}

export interface MarketplaceRow {
  name: string;
  installLocation: string | null;
  source: unknown;
  lastUpdated: string | null;
}

export interface Marketplaces {
  path: string;
  present: boolean;
  parseError: boolean;
  rows: MarketplaceRow[];
}

/** A registry row that names a Project directory: a Breadcrumb of kind `project-row` (D49). */
export interface PluginRow {
  entry: RegistryEntry;
  locator: Locator;
  located: Located | null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function scopeOf(value: unknown): Scope {
  return value === "project" || value === "local" || value === "system" ? value : "user";
}

function entryOf(
  pluginId: string,
  index: number,
  raw: Record<string, unknown>,
  scopeHint: Scope | null,
): RegistryEntry | null {
  const installPath = text(raw["installPath"]);
  if (installPath === null) return null;
  const at = pluginId.lastIndexOf("@");
  return {
    pluginId,
    plugin: at === -1 ? pluginId : pluginId.slice(0, at),
    marketplace: at === -1 ? null : pluginId.slice(at + 1),
    index,
    scope: scopeHint ?? scopeOf(raw["scope"]),
    projectPath: text(raw["projectPath"]),
    installPath,
    version: text(raw["version"]),
    installedAt: text(raw["installedAt"]),
    lastUpdated: text(raw["lastUpdated"]),
    gitCommitSha: text(raw["gitCommitSha"]),
  };
}

/**
 * `{version: 2, plugins: {"<plugin>@<marketplace>": [row, …]}}` as observed, and the documented
 * older `{user: {…}, project: {…}, local: {…}}` shape (research 01 Open 4). Exported for its own
 * test: no fixture carries the legacy file.
 */
export function parseRegistry(path: string, raw: unknown): PluginRegistry {
  const empty: PluginRegistry = {
    path,
    present: true,
    parseError: false,
    unknownShape: false,
    pluginIds: [],
    entries: [],
  };
  if (!isRecord(raw)) return { ...empty, parseError: true };
  const entries: RegistryEntry[] = [];
  const plugins = raw["plugins"];
  if (isRecord(plugins)) {
    for (const [pluginId, rows] of Object.entries(plugins)) {
      const list = Array.isArray(rows) ? rows : [rows];
      list.forEach((row, index) => {
        if (!isRecord(row)) return;
        const entry = entryOf(pluginId, index, row, null);
        if (entry !== null) entries.push(entry);
      });
    }
    return { ...empty, pluginIds: Object.keys(plugins), entries };
  }
  const legacyScopes = (["user", "project", "local"] as const).filter((scope) =>
    isRecord(raw[scope]),
  );
  if (legacyScopes.length === 0) return { ...empty, unknownShape: true };
  const ids = new Set<string>();
  for (const scope of legacyScopes) {
    const group = raw[scope];
    if (!isRecord(group)) continue;
    for (const [pluginId, row] of Object.entries(group)) {
      if (!isRecord(row)) continue;
      ids.add(pluginId);
      const entry = entryOf(pluginId, 0, row, scope);
      if (entry !== null) entries.push(entry);
    }
  }
  return { ...empty, pluginIds: [...ids], entries };
}

export async function readRegistry(path: string): Promise<PluginRegistry> {
  const raw = await readJsonObject(path);
  if (raw === null) {
    const present = await isFile(path);
    return {
      path,
      present,
      parseError: present,
      unknownShape: false,
      pluginIds: [],
      entries: [],
    };
  }
  return parseRegistry(path, raw);
}

export async function readMarketplaces(path: string): Promise<Marketplaces> {
  const raw = await readJsonObject(path);
  if (raw === null) {
    const present = await isFile(path);
    return { path, present, parseError: present, rows: [] };
  }
  const rows: MarketplaceRow[] = [];
  for (const [name, row] of Object.entries(raw)) {
    if (!isRecord(row)) continue;
    rows.push({
      name,
      installLocation: text(row["installLocation"]),
      source: row["source"],
      lastUpdated: text(row["lastUpdated"]),
    });
  }
  return { path, present: true, parseError: false, rows };
}

/** A marketplace source as `Origin.source` / `Origin.sourceUrl` (a relative string, or a record). */
function sourceOf(value: unknown): { source: string; sourceUrl: string | null } {
  if (typeof value === "string") return { source: value, sourceUrl: null };
  if (!isRecord(value)) return { source: "", sourceUrl: null };
  const url = text(value["repo"]) ?? text(value["url"]) ?? text(value["path"]);
  return { source: JSON.stringify(value), sourceUrl: url };
}

/** `hooks/hooks.json` and `plugin.json`'s own `hooks` map, redacted like any hook (D40). */
async function pluginHooks(
  installPath: string,
  manifest: Record<string, unknown>,
): Promise<HookDecl[]> {
  const file = await readJsonObject(join(installPath, "hooks", "hooks.json"));
  return [...(file === null ? [] : hooksOf(file)), ...hooksOf(manifest)];
}

/** `.in_use/<pid>` markers: the harness's own "this version is running" guard (never opened). */
async function inUse(scan: ClaudeScan, dir: string): Promise<boolean> {
  const entries = await listDir(join(dir, ".in_use"));
  return entries.some((entry) => {
    const pid = Number(entry.name);
    return Number.isInteger(pid) && pid > 0 && scan.ctx.options.isProcessAlive(pid);
  });
}

interface PluginInstall {
  installPath: string;
  entries: RegistryEntry[];
}

function enabledOf(
  scan: ClaudeScan,
  entry: RegistryEntry,
  project: DiscoveredProject | null,
): boolean | null {
  const settings =
    entry.scope === "user" || project === null
      ? scan.harnessSettings
      : (scan.projectFacts.get(project.id)?.effectiveSettings ?? {});
  const map = settings["enabledPlugins"];
  if (!isRecord(map)) return null;
  const value = map[entry.pluginId];
  return typeof value === "boolean" ? value : null;
}

interface Verdict {
  mode: "full" | "disabled" | "unknown" | "never";
  reason: string;
}

function verdictOf(
  scan: ClaudeScan,
  entry: RegistryEntry,
  project: DiscoveredProject | null,
  enabled: boolean | null,
): Verdict {
  if (enabled === false) return { mode: "disabled", reason: "enabledPlugins: false" };
  if (entry.scope === "user") {
    return { mode: "full", reason: "installed at user scope: loaded in every session" };
  }
  const trusted = project === null ? null : (scan.projectFacts.get(project.id)?.trusted ?? null);
  if (trusted === false) return { mode: "never", reason: "untrusted project" };
  if (trusted === null) {
    return {
      mode: "unknown",
      reason: "workspace trust not recorded: a project-scope plugin loads only after the dialog",
    };
  }
  return { mode: "full", reason: `installed at ${entry.scope} scope of a trusted project` };
}

async function pluginEntity(
  scan: ClaudeScan,
  install: PluginInstall,
  marketplaceSources: Map<string, { source: string; sourceUrl: string | null }>,
): Promise<Plugin | null> {
  const first = install.entries[0];
  if (first === undefined) return null;
  const projectOf = (entry: RegistryEntry): DiscoveredProject | null =>
    entry.projectPath === null
      ? null
      : (scan.pluginRows.find((row) => row.entry === entry)?.located?.project ?? null);
  const project = projectOf(first);
  const tree = await treeStats(install.installPath);
  const manifest =
    (await readJsonObject(join(install.installPath, ".claude-plugin", "plugin.json"))) ?? {};
  const marketplaceSource = marketplaceSources.get(first.pluginId) ?? {
    source: "",
    sourceUrl: null,
  };
  const origin: Origin = {
    installer: "claude-plugin",
    sourceType: "marketplace",
    source: marketplaceSource.source,
    sourceUrl: marketplaceSource.sourceUrl,
    ref: first.gitCommitSha,
    skillPath: null,
    recordedHash: null,
    installedAt: first.installedAt,
    updatedAt: first.lastUpdated,
    lock: {
      type: "entry",
      file: scan.registry.path,
      format: "json",
      keyPath: ["plugins", first.pluginId, String(first.index)],
    },
  };
  const live = await inUse(scan, install.installPath);
  const base = baseEntity(scan, {
    kind: "plugin",
    path: install.installPath,
    scope: first.scope,
    project,
    ownership: "human",
    locator: { type: "dir", path: install.installPath },
    format: "dir",
    label: first.pluginId,
    sensitive: false,
    // Ticket 08 §3: a version a running session marked `.in_use` is live, whatever its age.
    protection: live ? "live" : "none",
    removal: {
      method: "delegate",
      command: `claude plugin uninstall ${first.pluginId}`,
    },
    metrics: {
      bytes: tree.bytes,
      files: tree.files,
      lines: null,
      mtime: tree.newestMs === null ? null : toIso(tree.newestMs),
      ageDays: tree.newestMs === null ? null : ageDays(tree.newestMs, scan.ctx.options.now),
      tokens: null,
      lastUsed: lastUsedOf(scan.claudeJson.usage.plugins, first.pluginId),
    },
  });
  const entity: Plugin = {
    ...base,
    kind: "plugin",
    pluginId: first.pluginId,
    version: first.version ?? text(manifest["version"]),
    marketplace: first.marketplace,
    installs: install.entries.map((entry) => {
      const entryProject = projectOf(entry);
      return {
        scope: entry.scope,
        project: entryProject?.id ?? null,
        enabled: enabledOf(scan, entry, entryProject),
      };
    }),
    origin,
    hooks: await pluginHooks(install.installPath, manifest),
  };
  const added = addEntity(scan, entity);
  const enabled = enabledOf(scan, first, project);
  const verdict = verdictOf(scan, first, project, enabled);
  loadedBy(scan, {
    from: added.id,
    project: project?.id ?? null,
    mode: verdict.mode,
    reason: verdict.reason,
    placement: install.installPath,
    effectiveName: first.pluginId,
    ordered: false,
    charsLoaded: null,
    importsResolved: null,
    tokensLoaded: null,
    disableModelInvocation: null,
    countsTowardHeadline: false,
    evidence: [evidence("manifest", `installed_plugins.json records ${first.pluginId}`)],
  });
  return added;
}

/** Every item a plugin ships carries this edge; nothing under a plugin is removable on its own. */
export function providedBy(scan: ClaudeScan, from: string, plugin: Plugin): void {
  const edge: ProvidedByEdge = {
    id: edgeId("provided-by", from, plugin.id),
    kind: "provided-by",
    from,
    to: plugin.id,
    confidence: "certain",
    evidence: [evidence("manifest", `shipped by ${plugin.pluginId}`)],
  };
  addEdge(scan, edge);
}

async function pluginPayload(scan: ClaudeScan, plugin: Plugin, dir: string): Promise<void> {
  const project = scan.ctx.discovery.projects().find((item) => item.id === plugin.project) ?? null;
  const edge = scan.edges.get(loadedByEdgeId(plugin.id, plugin.project));
  const mode = edge?.kind === "loaded-by" ? edge.mode : "full";
  const source: SkillSource = {
    scope: plugin.scope === "user" ? "user" : "project",
    project,
    dir,
    plugin: {
      entity: plugin,
      name: plugin.pluginId.split("@")[0] ?? plugin.pluginId,
      mode: mode === "full" ? "description-only" : mode,
      reason:
        mode === "full"
          ? `provided by the plugin ${plugin.pluginId}`
          : `the plugin ${plugin.pluginId} does not load here`,
    },
  };
  await collectFrom(scan, source);
}

/**
 * The plugin's own MCP servers: `<root>/.mcp.json` and `plugin.json`'s `mcpServers` map (where a
 * `transport` key may stand in for `type`). They fall with the plugin — `removal: none` (14 §1) —
 * and are exposed as `plugin:<plugin>:<server>`.
 */
async function pluginMcp(scan: ClaudeScan, plugin: Plugin, dir: string): Promise<void> {
  const name = plugin.pluginId.split("@")[0] ?? plugin.pluginId;
  const project = scan.ctx.discovery.projects().find((item) => item.id === plugin.project) ?? null;
  const edge = scan.edges.get(loadedByEdgeId(plugin.id, plugin.project));
  const loads = edge?.kind !== "loaded-by" || edge.mode === "full";
  const manifest = (await readJsonObject(join(dir, ".claude-plugin", "plugin.json"))) ?? {};
  const sources: [string, unknown][] = [
    [join(dir, ".mcp.json"), (await readJsonObject(join(dir, ".mcp.json")))?.["mcpServers"]],
    [join(dir, ".claude-plugin", "plugin.json"), manifest["mcpServers"]],
  ];
  for (const [file, servers] of sources) {
    if (!isRecord(servers)) continue;
    for (const [server, entry] of Object.entries(servers)) {
      if (!isRecord(entry)) continue;
      // `plugin.json` may spell the transport `transport` instead of `type` (research 01 §4).
      const normalised =
        entry["type"] === undefined && typeof entry["transport"] === "string"
          ? { ...entry, type: entry["transport"] }
          : entry;
      const entity = await mcpEntity(scan, {
        file,
        keyPath: ["mcpServers", server],
        name: server,
        entry: normalised,
        scope: plugin.scope === "user" ? "user" : "project",
        project,
        removal: { method: "none" },
        approval: "not-applicable",
        enabled: null,
      });
      providedBy(scan, entity.id, plugin);
      scan.extraMcp.push(entity);
      loadedBy(scan, {
        from: entity.id,
        project: plugin.project,
        mode: loads ? "full" : "disabled",
        reason: loads
          ? `provided by the plugin ${plugin.pluginId}`
          : `the plugin ${plugin.pluginId} does not load here`,
        placement: file,
        effectiveName: `plugin:${name}:${server}`,
        ordered: false,
        charsLoaded: null,
        importsResolved: null,
        tokensLoaded: null,
        disableModelInvocation: null,
        countsTowardHeadline: false,
        evidence: [evidence("manifest", `shipped by ${plugin.pluginId}`)],
      });
    }
  }
}

export async function collectPlugins(scan: ClaudeScan): Promise<void> {
  const pluginsDir = join(scan.paths.configDir, "plugins");
  const { registry, marketplaces } = scan;
  if (registry.unknownShape) {
    scan.ctx.warn(
      warning(
        "unsupported-shape",
        "installed_plugins.json is neither the v2 nor the documented legacy shape: no plugin is read",
        "claude-code",
        registry.path,
        "partial",
      ),
    );
  }

  // The marketplace manifests name each plugin's source; a clone that is gone contributes none.
  const marketplaceSources = new Map<string, { source: string; sourceUrl: string | null }>();
  const knownClones = new Set<string>();
  for (const row of marketplaces.rows) {
    const clone = row.installLocation ?? join(pluginsDir, "marketplaces", row.name);
    knownClones.add(scan.ctx.identity.fold(clone));
    const manifest = await readJsonObject(join(clone, ".claude-plugin", "marketplace.json"));
    const list = manifest === null ? null : manifest["plugins"];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isRecord(item)) continue;
      const name = text(item["name"]);
      if (name === null) continue;
      marketplaceSources.set(`${name}@${row.name}`, sourceOf(item["source"]));
    }
  }

  // One Plugin per install directory, whatever the number of registry rows naming it.
  const installs = new Map<string, PluginInstall>();
  for (const entry of registry.entries) {
    const key = scan.ctx.identity.fold(entry.installPath);
    const install = installs.get(key) ?? { installPath: entry.installPath, entries: [] };
    install.entries.push(entry);
    installs.set(key, install);
  }
  const referenced = new Set(installs.keys());
  for (const [, install] of [...installs].toSorted((a, b) => a[0].localeCompare(b[0]))) {
    const plugin = await pluginEntity(scan, install, marketplaceSources);
    if (plugin === null) continue;
    if (await isDirectory(install.installPath)) {
      await pluginPayload(scan, plugin, install.installPath);
      await pluginMcp(scan, plugin, install.installPath);
    }
    await settingsEntity(scan, {
      path: join(install.installPath, ".claude-plugin", "plugin.json"),
      role: "manifest",
      scope: plugin.scope,
      project: null,
      ownership: "harness",
      protection: "never",
      removal: { method: "none" },
      entries: null,
      sensitiveKeys: [],
    });
  }

  // A skills-dir plugin: `~/.claude/skills/<name>/.claude-plugin/plugin.json` beside a `SKILL.md`.
  // It loads as `<name>@skills-dir`; its `SKILL.md` is the plugin's single skill (research 01 §1).
  const userSkills = join(scan.paths.configDir, "skills");
  for (const entry of (await listDir(userSkills)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const dir = join(userSkills, entry.name);
    if (!(await isFile(join(dir, ".claude-plugin", "plugin.json")))) continue;
    const plugin = await skillsDirPlugin(scan, dir, entry.name);
    if (plugin === null) continue;
    await skillDirEntity(
      scan,
      dir,
      {
        scope: "user",
        project: null,
        dir: userSkills,
        plugin: {
          entity: plugin,
          name: entry.name,
          mode: "description-only",
          reason: `provided by the plugin ${plugin.pluginId}`,
        },
      },
      { effectiveName: `/${entry.name}` },
    );
  }

  await collectPluginCache(scan, pluginsDir, referenced, knownClones);
  await collectPluginState(scan, pluginsDir);
}

async function skillsDirPlugin(
  scan: ClaudeScan,
  dir: string,
  name: string,
): Promise<Plugin | null> {
  const manifest = (await readJsonObject(join(dir, ".claude-plugin", "plugin.json"))) ?? {};
  const tree = await treeStats(dir);
  const pluginId = `${name}@skills-dir`;
  const map = scan.harnessSettings["enabledPlugins"];
  const enabled = isRecord(map) && typeof map[pluginId] === "boolean" ? map[pluginId] : null;
  const base = baseEntity(scan, {
    kind: "plugin",
    path: dir,
    scope: "user",
    project: null,
    ownership: "human",
    locator: { type: "dir", path: dir },
    format: "dir",
    label: pluginId,
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: {
      bytes: tree.bytes,
      files: tree.files,
      lines: null,
      mtime: tree.newestMs === null ? null : toIso(tree.newestMs),
      ageDays: tree.newestMs === null ? null : ageDays(tree.newestMs, scan.ctx.options.now),
      tokens: null,
      lastUsed: lastUsedOf(scan.claudeJson.usage.plugins, pluginId),
    },
  });
  const entity: Plugin = {
    ...base,
    kind: "plugin",
    pluginId,
    version: text(manifest["version"]),
    // Not installed from a marketplace: the skills directory is the whole provenance.
    marketplace: null,
    installs: [{ scope: "user", project: null, enabled }],
    origin: null,
    hooks: hooksOf(manifest),
  };
  const added = addEntity(scan, entity);
  loadedBy(scan, {
    from: added.id,
    project: null,
    mode: enabled === false ? "disabled" : "full",
    reason:
      enabled === false
        ? "enabledPlugins: false"
        : "a plugin manifest in the skills directory: loaded in every session",
    placement: dir,
    effectiveName: pluginId,
    ordered: false,
    charsLoaded: null,
    importsResolved: null,
    tokensLoaded: null,
    disableModelInvocation: null,
    countsTowardHeadline: false,
    evidence: [evidence("manifest", ".claude-plugin/plugin.json beside SKILL.md")],
  });
  return added;
}

const NO_RETENTION: UnitInput["retention"] = {
  days: null,
  bytes: null,
  count: null,
  source: null,
};

/**
 * Ticket 08 §1's plugin rows: an unreferenced `cache/<m>/<p>/<v>/` (its `.in_use` markers are the
 * only thing that can keep it), a clone `known_marketplaces.json` does not name, a backup clone,
 * a marketplace's `node_modules/` (D51), and the keep-by-default names beside them.
 */
async function collectPluginCache(
  scan: ClaudeScan,
  pluginsDir: string,
  referenced: ReadonlySet<string>,
  knownClones: ReadonlySet<string>,
): Promise<void> {
  const fold = scan.ctx.identity.fold;
  const cacheDir = join(pluginsDir, "cache");
  for (const market of (await listDir(cacheDir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!market.isDirectory()) continue;
    const marketDir = join(cacheDir, market.name);
    for (const plugin of (await listDir(marketDir)).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (!plugin.isDirectory()) continue;
      const pluginDir = join(marketDir, plugin.name);
      for (const version of (await listDir(pluginDir)).toSorted((a, b) =>
        a.name.localeCompare(b.name),
      )) {
        if (!version.isDirectory()) continue;
        const dir = join(pluginDir, version.name);
        if (referenced.has(fold(dir))) continue;
        await cacheEntity(scan, {
          paths: [dir],
          cacheKind: "plugin-cache-version",
          unit: "version",
          session: null,
          slug: null,
          project: null,
          rule: "undocumented",
          retention: NO_RETENTION,
          // `install-path` is what made it unreferenced; only a live `.in_use` marker holds it.
          liveGuard: { kind: "in-use-marker", alive: await inUse(scan, dir) },
          userContent: false,
          protection: "none",
          removal: { method: "trash" },
          sensitive: false,
          label: `${plugin.name}@${market.name} ${version.name}`,
        });
      }
    }
  }

  const marketplacesDir = join(pluginsDir, "marketplaces");
  for (const entry of (await listDir(marketplacesDir)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    const dir = join(marketplacesDir, entry.name);
    if (entry.name.endsWith(".bak")) {
      await cacheEntity(scan, {
        paths: [dir],
        cacheKind: "marketplace-backup",
        unit: "dir",
        session: null,
        slug: null,
        project: null,
        rule: "undocumented",
        retention: NO_RETENTION,
        liveGuard: null,
        userContent: false,
        protection: "none",
        removal: { method: "trash" },
        sensitive: false,
      });
      continue;
    }
    // D51: a marketplace's `node_modules/` is a unit of its own, so the clone above it never
    // counts those bytes twice and the sweep never reaches inside the clone.
    const modules = join(dir, "node_modules");
    const modulesStats = await treeStats(modules);
    if (modulesStats.files > 0) {
      await cacheEntity(scan, {
        paths: [modules],
        cacheKind: "marketplace-clone",
        unit: "dir",
        session: null,
        slug: null,
        project: null,
        rule: "undocumented",
        retention: NO_RETENTION,
        liveGuard: null,
        userContent: false,
        protection: "none",
        removal: { method: "trash" },
        sensitive: false,
        label: `${entry.name} node_modules`,
      });
    }
    const known = knownClones.has(fold(dir));
    await cacheEntity(scan, {
      paths: [dir],
      cacheKind: "marketplace-clone",
      unit: "clone",
      session: null,
      slug: null,
      project: null,
      // A clone the registry names is "must keep as a whole" (research 01 §8); an unknown one
      // is undocumented state: tickable, never preselected.
      rule: known ? "kept" : "undocumented",
      retention: NO_RETENTION,
      liveGuard: known ? null : { kind: "install-path", alive: false },
      userContent: false,
      protection: known ? "never" : "none",
      removal: known ? { method: "none" } : { method: "trash" },
      sensitive: false,
      exclude: [modules],
    });
    if (known) {
      await settingsEntity(scan, {
        path: join(dir, ".claude-plugin", "marketplace.json"),
        role: "manifest",
        scope: "user",
        project: null,
        ownership: "harness",
        protection: "never",
        removal: { method: "none" },
        entries: null,
        sensitiveKeys: [],
      });
    }
  }

  // Keep-by-default names beside the cache (research 01 §7, Open 5): size-only rows, no action.
  const sizeOnly: string[] = [join(pluginsDir, "repos"), join(pluginsDir, ".last_inuse_sweep")];
  for (const entry of (await listDir(join(pluginsDir, "data"))).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    sizeOnly.push(join(pluginsDir, "data", entry.name));
  }
  for (const path of sizeOnly) {
    const directory = await isDirectory(path);
    if (!directory && (await treeStats(path)).files === 0) continue;
    await cacheEntity(scan, {
      paths: [path],
      cacheKind: "undocumented",
      unit: directory ? "dir" : "file",
      session: null,
      slug: null,
      project: null,
      rule: "undocumented",
      retention: NO_RETENTION,
      liveGuard: null,
      userContent: false,
      protection: "undocumented",
      removal: { method: "none" },
      sensitive: false,
    });
  }
}

/** The plugin state files: never removed, never edited by moldig (ticket 08 §1 `never` row). */
async function collectPluginState(scan: ClaudeScan, pluginsDir: string): Promise<void> {
  const rows: [string, SettingsFile["role"], number | null][] = [
    ["installed_plugins.json", "plugin-registry", scan.registry.pluginIds.length],
    ["known_marketplaces.json", "plugin-registry", scan.marketplaces.rows.length],
    ["blocklist.json", "state", null],
    ["plugin-catalog-cache.json", "state", null],
    ["config.json", "state", null],
  ];
  for (const [name, role, entries] of rows) {
    await settingsEntity(scan, {
      path: join(pluginsDir, name),
      role,
      scope: "user",
      project: null,
      ownership: "harness",
      protection: "never",
      removal: { method: "none" },
      entries,
      sensitiveKeys: [],
    });
  }
}

/** `installed_plugins.json[].projectPath` rows, for the `project-row` breadcrumbs of D49. */
export function pluginRowsOf(
  registry: PluginRegistry,
  located: ReadonlyMap<string, Located>,
): PluginRow[] {
  return registry.entries
    .filter((entry) => entry.projectPath !== null)
    .map((entry) => ({
      entry,
      locator: {
        type: "entry" as const,
        file: registry.path,
        format: "json" as const,
        keyPath: ["plugins", entry.pluginId, String(entry.index), "projectPath"],
      },
      located: entry.projectPath === null ? null : (located.get(entry.projectPath) ?? null),
    }));
}
