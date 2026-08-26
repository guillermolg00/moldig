/* oxlint-disable no-await-in-loop -- sequential on purpose: bounded disk IO and a stable emit order */
/**
 * MCP servers (research 02, Gemini MCP; spec §7): `mcpServers.<name>` in the user settings file,
 * in every present member's `<member>/.gemini/settings.json`, in the system settings file and in
 * a plugin's `gemini-extension.json`. Only documented key names decide anything: `command` →
 * stdio, else `httpUrl` → http, else `url` → sse — `type` is not a Gemini key and stays in
 * `rawKeys`. `mcp.allowed[]` is an allow-list (D71): a server absent from a non-empty list is
 * disabled. Values never enter the index: key names, the sanitised URL and the command do.
 */
import { join } from "node:path";
import type { DuplicatesEdge, McpServer, ShadowsEdge } from "../../index/types.js";
import { warning } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { ageDays, byteLength, isRecord, isStringArray, statOrNull, toIso } from "../../scan/fs.js";
import { edgeId } from "../../scan/paths.js";
import {
  addEdge,
  addEntity,
  baseEntity,
  evidence,
  HARNESS,
  loadedBy,
  loadedByEdgeId,
  providedBy,
  settingsFor,
  trustOf,
  type GeminiScan,
} from "./model.js";
import { nested, readLayer, redactString, stringList } from "./settings.js";

const SECRET_ENV = /token|secret|password|credential|apikey|api_key/i;
const INTERPOLATION = /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*/;

interface EntryInput {
  file: string;
  name: string;
  entry: Record<string, unknown>;
  scope: "user" | "project" | "system";
  project: DiscoveredProject | null;
  removal: McpServer["removal"];
  protection: McpServer["protection"];
  enabled: boolean | null;
}

function sanitiseUrl(raw: string): { url: string; endpoint: string } {
  try {
    const parsed = new URL(raw);
    parsed.search = "";
    parsed.hash = "";
    parsed.username = "";
    parsed.password = "";
    return {
      url: parsed.toString(),
      endpoint: `${parsed.host}${parsed.pathname}`.replace(/\/$/, ""),
    };
  } catch {
    return { url: raw, endpoint: raw };
  }
}

function usesInterpolation(value: unknown): boolean {
  if (typeof value === "string") return INTERPOLATION.test(value);
  if (Array.isArray(value)) return value.some((item) => usesInterpolation(item));
  if (isRecord(value)) return Object.values(value).some((item) => usesInterpolation(item));
  return false;
}

/** Keys of a map whose value is a literal (non-interpolated) string. */
function literalKeys(map: unknown, keep: (key: string) => boolean): string[] {
  if (!isRecord(map)) return [];
  return Object.entries(map)
    .filter(
      ([key, value]) =>
        typeof value === "string" && value !== "" && !value.includes("${") && keep(key),
    )
    .map(([key]) => key);
}

async function mcpEntity(scan: GeminiScan, input: EntryInput): Promise<McpServer> {
  const { entry } = input;
  const command = typeof entry["command"] === "string" ? entry["command"] : null;
  const httpUrl = typeof entry["httpUrl"] === "string" ? entry["httpUrl"] : null;
  const rawUrl = typeof entry["url"] === "string" ? entry["url"] : null;
  const args = isStringArray(entry["args"])
    ? entry["args"].map((item) => redactString(item, null))
    : [];
  let transport: McpServer["transport"] = "unknown";
  let invalid: string | null = null;
  if (command !== null) transport = "stdio";
  else if (httpUrl !== null) transport = "http";
  else if (rawUrl !== null) transport = "sse";
  else invalid = "no command, url or httpUrl";
  // research 02: a Gemini MCP server name never contains an underscore.
  if (invalid === null && input.name.includes("_")) invalid = "server name contains _";
  const target = httpUrl ?? rawUrl;
  const sanitised = target === null ? null : sanitiseUrl(target);
  const envKeys = isRecord(entry["env"]) ? Object.keys(entry["env"]) : [];
  const headerKeys = isRecord(entry["headers"]) ? Object.keys(entry["headers"]) : [];
  const oauth = entry["oauth"];
  const secretKeys = [
    ...literalKeys(entry["headers"], () => true),
    ...literalKeys(entry["env"], (key) => SECRET_ENV.test(key)),
    ...literalKeys(oauth, (key) => key === "clientSecret"),
  ];
  const endpointKey =
    transport === "stdio"
      ? `stdio:${[command ?? "", ...args].join(" ").trim()}`
      : `${transport}:${sanitised?.endpoint ?? ""}`;
  const stats = await statOrNull(input.file);
  const base = baseEntity(scan, {
    kind: "mcp-server",
    path: input.file,
    keyPath: ["mcpServers", input.name],
    scope: input.scope === "system" ? "system" : input.scope,
    project: input.project,
    ownership: "human",
    locator: {
      type: "entry",
      file: input.file,
      format: "json",
      keyPath: ["mcpServers", input.name],
    },
    format: "json",
    label: input.name,
    sensitive: envKeys.length > 0 || headerKeys.length > 0 || "oauth" in entry,
    protection: input.protection,
    removal: input.removal,
    metrics: {
      bytes: byteLength(JSON.stringify(entry)),
      files: null,
      lines: null,
      mtime: stats === null ? null : toIso(stats.mtimeMs),
      ageDays: stats === null ? null : ageDays(stats.mtimeMs, scan.ctx.options.now),
      tokens: null,
      lastUsed: null,
    },
  });
  const entity: McpServer = {
    ...base,
    kind: "mcp-server",
    name: input.name,
    transport,
    command: command === null ? null : redactString(command, null),
    args,
    url: sanitised?.url ?? null,
    envKeys,
    headerKeys,
    secretKeys,
    hasOauth: "oauth" in entry,
    usesInterpolation: usesInterpolation(entry),
    enabled: input.enabled,
    // Gemini has no per-server approval prompt (`trust` governs confirmations, not loading).
    approval: "not-applicable",
    invalid,
    endpointKey,
    rawKeys: Object.keys(entry),
  };
  return addEntity(scan, entity);
}

/** D71: `mcp.allowed[]` is an allow-list; `mcp.excluded[]` always wins. */
function enabledOf(settings: Record<string, unknown>, name: string): boolean | null {
  const excluded = stringList(nested(settings, "mcp", "excluded"));
  if (excluded.includes(name)) return false;
  const allowed = stringList(nested(settings, "mcp", "allowed"));
  if (allowed.length > 0 && !allowed.includes(name)) return false;
  return null;
}

function verdict(
  scan: GeminiScan,
  entity: McpServer,
  projectId: string | null,
  settings: Record<string, unknown>,
  scopeReason: string,
  untrusted: boolean,
): void {
  const excluded = stringList(nested(settings, "mcp", "excluded")).includes(entity.name);
  const mode: "full" | "never" | "disabled" = untrusted
    ? "never"
    : entity.invalid !== null
      ? "never"
      : entity.enabled === false
        ? "disabled"
        : "full";
  const reason = untrusted
    ? "untrusted project: .gemini/settings.json is ignored"
    : entity.invalid !== null
      ? `${entity.invalid}: the harness skips this entry`
      : entity.enabled === false
        ? excluded
          ? "listed in mcp.excluded"
          : "not in mcp.allowed"
        : scopeReason;
  loadedBy(scan, {
    from: entity.id,
    project: projectId,
    mode,
    reason,
    placement: null,
    effectiveName: entity.name,
    ordered: false,
    charsLoaded: null,
    importsResolved: null,
    tokensLoaded: null,
    disableModelInvocation: null,
    countsTowardHeadline: false,
    evidence: [evidence("loading-rule", reason)],
  });
}

function rank(entity: McpServer): number {
  return entity.scope === "project" ? 3 : entity.scope === "user" ? 2 : 1;
}

export async function collectMcp(
  scan: GeminiScan,
  projects: readonly DiscoveredProject[],
): Promise<void> {
  const fold = scan.ctx.identity.fold;
  const byProject = new Map<string, McpServer[]>();
  const remember = (entity: McpServer, projectId: string | null): void => {
    scan.mcp.push(entity);
    if (projectId === null) return;
    byProject.set(projectId, [...(byProject.get(projectId) ?? []), entity]);
  };

  const userServers = nested(scan.userSettings.data, "mcpServers");
  if (isRecord(userServers)) {
    for (const [name, entry] of Object.entries(userServers)) {
      if (!isRecord(entry)) continue;
      const entity = await mcpEntity(scan, {
        file: scan.userSettings.path,
        name,
        entry,
        scope: "user",
        project: null,
        removal: { method: "backup-edit" },
        protection: "none",
        enabled: enabledOf(scan.harnessSettings, name),
      });
      verdict(
        scan,
        entity,
        null,
        scan.harnessSettings,
        "user scope: available in every session",
        false,
      );
      remember(entity, null);
    }
  }

  const systemServers = nested(scan.systemSettings.data, "mcpServers");
  if (isRecord(systemServers)) {
    for (const [name, entry] of Object.entries(systemServers)) {
      if (!isRecord(entry)) continue;
      const entity = await mcpEntity(scan, {
        file: scan.systemSettings.path,
        name,
        entry,
        scope: "system",
        project: null,
        removal: { method: "none" },
        protection: "never",
        enabled: enabledOf(scan.harnessSettings, name),
      });
      verdict(
        scan,
        entity,
        null,
        scan.harnessSettings,
        "system scope: available in every session",
        false,
      );
      remember(entity, null);
    }
  }

  for (const extension of scan.extensions) {
    const servers = extension.manifest["mcpServers"];
    if (!isRecord(servers)) continue;
    for (const [name, entry] of Object.entries(servers)) {
      if (!isRecord(entry)) continue;
      const entity = await mcpEntity(scan, {
        file: join(extension.dir, "gemini-extension.json"),
        name,
        entry,
        scope: "user",
        project: null,
        // Provided by the plugin: removable only through it (ticket 14 §1).
        removal: { method: "none" },
        protection: "none",
        enabled: enabledOf(scan.harnessSettings, name),
      });
      providedBy(scan, entity.id, extension.entity);
      verdict(
        scan,
        entity,
        null,
        scan.harnessSettings,
        `plugin ${extension.name}: available while the plugin is enabled`,
        false,
      );
      remember(entity, null);
    }
  }

  for (const project of projects) {
    if (project.reachability !== "present") continue;
    const untrusted = trustOf(scan, project) === false;
    const settings = settingsFor(scan, project);
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      const file = join(member.path, ".gemini", "settings.json");
      const layer = await readLayer(file);
      if (!layer.present) continue;
      const servers = nested(layer.data, "mcpServers");
      if (!isRecord(servers)) continue;
      for (const [name, entry] of Object.entries(servers)) {
        if (!isRecord(entry)) continue;
        const entity = await mcpEntity(scan, {
          file,
          name,
          entry,
          scope: "project",
          project,
          removal: { method: "backup-edit" },
          protection: "none",
          enabled: untrusted ? null : enabledOf(settings, name),
        });
        verdict(
          scan,
          entity,
          project.id,
          settings,
          `project scope: sessions started in ${project.path}`,
          untrusted,
        );
        remember(entity, project.id);
      }
    }
  }

  // Shadows: project > user > extension by name, per Project (spec §7).
  const global = scan.mcp.filter((entity) => entity.project === null);
  for (const [, servers] of byProject) {
    const byName = new Map<string, McpServer[]>();
    for (const entity of [...servers, ...global])
      byName.set(entity.name, [...(byName.get(entity.name) ?? []), entity]);
    for (const [, group] of byName) {
      const sorted = group.toSorted((a, b) => rank(b) - rank(a) || a.id.localeCompare(b.id));
      const winner = sorted[0];
      if (winner === undefined) continue;
      for (const loser of sorted.slice(1)) {
        if (rank(loser) === rank(winner)) continue;
        const edge: ShadowsEdge = {
          id: edgeId("shadows", winner.id, loser.id),
          kind: "shadows",
          from: winner.id,
          to: loser.id,
          confidence: "certain",
          evidence: [
            evidence(
              "precedence-rule",
              "a settings.json server beats a same-named plugin server; project beats user",
            ),
          ],
          rule: "project > user > extension",
        };
        addEdge(scan, edge);
        const shadowed = scan.edges.get(loadedByEdgeId(loser.id, loser.project));
        if (shadowed?.kind === "loaded-by" && shadowed.mode === "full") {
          shadowed.mode = "shadowed";
          shadowed.reason = `a ${winner.scope}-scope entry of the same name wins`;
        }
      }
    }
  }

  // D133: the same endpoint configured at more than one place is a `duplicates` pair.
  const byEndpoint = new Map<string, McpServer[]>();
  for (const entity of scan.mcp) {
    if (entity.invalid !== null || entity.endpointKey.endsWith(":")) continue;
    byEndpoint.set(entity.endpointKey, [...(byEndpoint.get(entity.endpointKey) ?? []), entity]);
  }
  for (const [, group] of byEndpoint) {
    const sorted = group.toSorted((a, b) => (fold(a.id) < fold(b.id) ? -1 : 1));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const from = sorted[i];
        const to = sorted[j];
        if (from === undefined || to === undefined) continue;
        const edge: DuplicatesEdge = {
          id: edgeId("duplicates", from.id, to.id),
          kind: "duplicates",
          from: from.id,
          to: to.id,
          confidence: from.transport === "stdio" ? "medium" : "high",
          evidence: [evidence("endpoint", from.endpointKey)],
          same: "endpoint",
        };
        addEdge(scan, edge);
      }
    }
  }
}

/** The MCP entry count of a settings object, for `SettingsFile.entries`. */
export function mcpEntryCount(data: Record<string, unknown>): number | null {
  const servers = data["mcpServers"];
  return isRecord(servers) ? Object.keys(servers).length : null;
}

/** Reported when a settings layer cannot be parsed at all. */
export function parseWarning(path: string, what: string): ReturnType<typeof warning> {
  return warning("parse-error", `${what} is not valid JSON`, HARNESS, path, "partial");
}
