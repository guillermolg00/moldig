/* oxlint-disable no-await-in-loop -- sequential on purpose: bounded, ordered disk IO */
/**
 * The Orphan findings that need a registry, a lock or a settings key rather than an entity —
 * D48's four rows plus D11's two, and D53's `~/.claude/.mcp.json`. They run in `audit` (like the
 * memory read signal) because they re-read a handful of small files the index already points at;
 * `scan` stays the pure inventory pass. Ticket 23 owns the general detectors: this file is the
 * Claude adapter's own supplement and the audit calls it in one line.
 */
import { basename, join } from "node:path";
import type { Finding, Index, Locator, Plugin, Skill } from "../../index/types.js";
import { isDirectory, isRecord, readJsonObject } from "../../scan/fs.js";
import { readSkillLock, storeOf } from "./locks.js";
import { readMarketplaces, readRegistry } from "./plugins.js";

function finding(input: {
  id: string;
  container: string | null;
  targets: Finding["targets"];
  message: string;
  evidence: Finding["evidence"];
  severity?: Finding["severity"];
  action?: Finding["action"];
  impact?: Finding["impact"];
}): Finding {
  return {
    id: input.id,
    category: "orphan",
    severity: input.severity ?? "low",
    container: input.container,
    targets: input.targets,
    message: input.message,
    evidence: input.evidence,
    confidence: "certain",
    impact: input.impact ?? { bytes: 0, tokens: null, files: 0 },
    flags: [],
    action: input.action ?? { kind: "open", preselect: false, locator: null },
  };
}

/**
 * Every `settings-file` with the given role that this adapter emitted — a skill lock belongs to
 * no harness (`harness: null`), so both are accepted.
 */
function settingsFiles(index: Index, role: string): { id: string; path: string }[] {
  return index.entities
    .filter(
      (entity) =>
        entity.kind === "settings-file" &&
        entity.role === role &&
        (entity.harness === "claude-code" || entity.harness === null),
    )
    .map((entity) => ({ id: entity.id, path: entity.path }));
}

/** A plugin the registry records whose install directory is gone (D48, D11). */
async function missingPlugins(index: Index): Promise<Finding[]> {
  const out: Finding[] = [];
  const plugins = index.entities.filter(
    (entity): entity is Plugin => entity.kind === "plugin" && entity.harness === "claude-code",
  );
  for (const plugin of plugins) {
    if (plugin.origin === null || (await isDirectory(plugin.path))) continue;
    out.push(
      finding({
        id: `finding:orphan:${plugin.id}`,
        container: plugin.project ?? `harness:${plugin.harness ?? "claude-code"}`,
        severity: "medium",
        targets: [
          { id: plugin.id, role: "subject" },
          { locator: plugin.origin.lock, role: "state" },
        ],
        message: `${plugin.pluginId}: the plugin's install directory is gone; the registry still records it`,
        evidence: [{ kind: "path-missing", detail: plugin.path }],
        action: {
          kind: "delete",
          preselect: false,
          locator: plugin.origin.lock,
        },
      }),
    );
  }
  return out;
}

/** A marketplace `known_marketplaces.json` names whose clone is gone (D48). */
async function missingMarketplaces(index: Index): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const file of settingsFiles(index, "plugin-registry")) {
    if (basename(file.path) !== "known_marketplaces.json") continue;
    const marketplaces = await readMarketplaces(file.path);
    for (const row of marketplaces.rows) {
      const clone = row.installLocation ?? join(file.path, "..", "marketplaces", row.name);
      if (await isDirectory(clone)) continue;
      const locator: Locator = {
        type: "entry",
        file: file.path,
        format: "json",
        keyPath: [row.name],
      };
      out.push(
        finding({
          id: `finding:orphan:marketplace:${row.name}`,
          container: "harness:claude-code",
          targets: [{ locator, role: "subject" }],
          message: `marketplace ${row.name} is registered but its clone is gone`,
          evidence: [{ kind: "path-missing", detail: clone }],
        }),
      );
    }
  }
  return out;
}

/**
 * An `enabledPlugins` key naming a plugin no registry row installs (D48). Only reported when the
 * registry file itself exists: without it moldig cannot say the plugin is not installed, and
 * fail-closed means showing nothing rather than a wall of false rows.
 */
async function unknownEnabledPlugins(index: Index): Promise<Finding[]> {
  const registryFile = settingsFiles(index, "plugin-registry").find(
    (file) => basename(file.path) === "installed_plugins.json",
  );
  if (registryFile === undefined) return [];
  const registry = await readRegistry(registryFile.path);
  const installed = new Set(registry.pluginIds);
  const out: Finding[] = [];
  for (const file of settingsFiles(index, "settings")) {
    const data = await readJsonObject(file.path);
    const enabled = data === null ? null : data["enabledPlugins"];
    if (!isRecord(enabled)) continue;
    const entity = index.entities.find((item) => item.id === file.id);
    for (const pluginId of Object.keys(enabled)) {
      if (installed.has(pluginId)) continue;
      const locator: Locator = {
        type: "entry",
        file: file.path,
        format: "json",
        keyPath: ["enabledPlugins", pluginId],
      };
      out.push(
        finding({
          id: `finding:orphan:enabled-plugin:${file.path}:${pluginId}`,
          container: entity?.project ?? "harness:claude-code",
          targets: [{ locator, role: "subject" }],
          message: `enabledPlugins names ${pluginId}, which no plugin registry entry installs`,
          evidence: [
            { kind: "manifest", detail: `installed_plugins.json does not record ${pluginId}` },
          ],
        }),
      );
    }
  }
  return out;
}

/** A Skill every placement of which dangles: the link survived its target (D11, D84). */
function danglingSkills(index: Index): Finding[] {
  const out: Finding[] = [];
  for (const entity of index.entities) {
    if (entity.kind !== "skill") continue;
    const dangling = entity.placements.filter((placement) => placement.dangling);
    if (dangling.length === 0) continue;
    out.push(
      finding({
        id: `finding:orphan:${entity.id}`,
        container: entity.project ?? `harness:${entity.harness ?? "claude-code"}`,
        targets: dangling.map((placement) => ({
          locator: { type: "dir", path: placement.path },
          role: "subject" as const,
        })),
        message: `${entity.name}: ${dangling.length === 1 ? "a link points" : "links point"} at a directory that is gone`,
        evidence: dangling.map((placement) => ({
          kind: "symlink-target",
          detail: placement.linkTarget ?? placement.path,
        })),
        action: {
          kind: "delete",
          preselect: false,
          locator: { type: "dir", path: dangling[0]?.path ?? entity.path },
        },
      }),
    );
  }
  return out;
}

/**
 * Lock entries no Skill claims: the directory is gone (D11 — a locator-only target the Delete
 * flow backup-edits out) or it exists and no agent directory links it (D48's last row).
 */
async function lockEntries(index: Index): Promise<Finding[]> {
  const claimed = new Set(
    index.entities
      .filter((entity): entity is Skill => entity.kind === "skill" && entity.origin !== null)
      .map((entity) => {
        const lock = entity.origin?.lock;
        return lock !== undefined && lock.type === "entry"
          ? `${lock.file}#${lock.keyPath.join("/")}`
          : "";
      }),
  );
  const out: Finding[] = [];
  for (const file of settingsFiles(index, "skill-lock")) {
    const lock = await readSkillLock(file.path, storeOf(file.path), "user", null);
    for (const entry of lock.entries) {
      if (claimed.has(`${entry.file}#skills/${entry.name}`)) continue;
      const locator: Locator = {
        type: "entry",
        file: entry.file,
        format: "json",
        keyPath: ["skills", entry.name],
      };
      const present = await isDirectory(entry.storeDir);
      out.push(
        finding({
          id: `finding:orphan:lock-entry:${entry.file}:${entry.name}`,
          container: "harness:claude-code",
          targets: present
            ? [
                { locator: { type: "dir", path: entry.storeDir }, role: "subject" },
                { locator, role: "state" },
              ]
            : [{ locator, role: "subject" }],
          message: present
            ? `${entry.name}: a skill directory in the store no agent directory links`
            : `${entry.name}: the lock records a skill directory that is gone`,
          evidence: [
            present
              ? { kind: "name-only", detail: entry.storeDir }
              : { kind: "path-missing", detail: entry.storeDir },
          ],
        }),
      );
    }
  }
  return out;
}

/** D53/D106: a file Claude Code does not read, holding MCP servers a user believes are live. */
function userMcpConfig(index: Index): Finding[] {
  const out: Finding[] = [];
  for (const entity of index.entities) {
    if (entity.kind !== "settings-file" || entity.role !== "mcp-config") continue;
    if (entity.scope !== "user" || entity.harness !== "claude-code") continue;
    const servers = index.entities.filter(
      (item) =>
        item.kind === "mcp-server" &&
        item.locator.type === "entry" &&
        item.locator.file === entity.path,
    );
    out.push(
      finding({
        id: `finding:orphan:${entity.id}`,
        container: "harness:claude-code",
        targets: [
          { id: entity.id, role: "subject" },
          ...servers.map((server) => ({ id: server.id, role: "counterpart" as const })),
        ],
        message: "Claude Code does not read this file; its MCP servers live in `~/.claude.json`",
        evidence: [
          { kind: "loading-rule", detail: "~/.claude/.mcp.json is not a configuration layer" },
        ],
        impact: { bytes: entity.metrics.bytes, tokens: null, files: 1 },
      }),
    );
  }
  return out;
}

/** Every Claude-specific Orphan row the general detectors cannot see from the index alone. */
export async function claudeOrphanFindings(index: Index): Promise<Finding[]> {
  return [
    ...(await missingPlugins(index)),
    ...(await missingMarketplaces(index)),
    ...(await unknownEnabledPlugins(index)),
    ...danglingSkills(index),
    ...(await lockEntries(index)),
    ...userMcpConfig(index),
  ];
}
