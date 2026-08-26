/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * MCP server entries (research 01 §4): user scope in `~/.claude.json` `mcpServers`, local
 * scope in `~/.claude.json` `projects[<path>].mcpServers`, project scope in `<repo>/.mcp.json`
 * (approved per server through `enabledMcpjsonServers` / `disabledMcpjsonServers` /
 * `enableAllProjectMcpServers`). Same name: local > project > user (`shadows`); same endpoint
 * at two places: `duplicates`. Values are never kept beyond key names, the sanitised URL and
 * the command; `~/.claude.json` is never edited (removal delegates to `claude mcp remove`).
 */
import { join } from "node:path";
import type { DuplicatesEdge, McpServer, ShadowsEdge } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { byteLength, isRecord, isStringArray, statOrNull } from "../../scan/fs.js";
import { ageDays, readJsonObject, toIso } from "../../scan/fs.js";
import { edgeId } from "../../scan/paths.js";
import {
  addEdge,
  addEntity,
  baseEntity,
  evidence,
  loadedBy,
  loadedByEdgeId,
  type ClaudeScan,
} from "./model.js";
import type { ProjectEntry } from "./state.js";

const SECRET_ENV = /token|secret|password|credential|apikey|api_key|auth/i;

export interface EntryInput {
  file: string;
  keyPath: string[];
  name: string;
  entry: Record<string, unknown>;
  scope: "user" | "project" | "local";
  project: DiscoveredProject | null;
  removal: McpServer["removal"];
  approval: McpServer["approval"];
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

function containsInterpolation(value: unknown): boolean {
  if (typeof value === "string") return value.includes("${");
  if (Array.isArray(value)) return value.some((item) => containsInterpolation(item));
  if (isRecord(value)) return Object.values(value).some((item) => containsInterpolation(item));
  return false;
}

function literalKeys(map: unknown, keyFilter: (key: string) => boolean): string[] {
  if (!isRecord(map)) return [];
  return Object.entries(map)
    .filter(
      ([key, value]) =>
        typeof value === "string" && value !== "" && !value.includes("${") && keyFilter(key),
    )
    .map(([key]) => key);
}

export async function mcpEntity(scan: ClaudeScan, input: EntryInput): Promise<McpServer> {
  const { entry } = input;
  const rawType = typeof entry["type"] === "string" ? entry["type"] : null;
  const command = typeof entry["command"] === "string" ? entry["command"] : null;
  const rawUrl = typeof entry["url"] === "string" ? entry["url"] : null;
  const args = isStringArray(entry["args"]) ? entry["args"] : [];
  let transport: McpServer["transport"] = "unknown";
  let invalid: string | null = null;
  const type = rawType === "streamable-http" ? "http" : rawType;
  if (type === null) {
    if (rawUrl !== null && command === null) invalid = "url without type";
    else transport = "stdio";
  } else if (type === "stdio" || type === "http" || type === "sse" || type === "ws") {
    transport = type;
  } else {
    invalid = `unknown type ${type}`;
  }
  const sanitised = rawUrl === null ? null : sanitiseUrl(rawUrl);
  const envKeys = isRecord(entry["env"]) ? Object.keys(entry["env"]) : [];
  const headerKeys = isRecord(entry["headers"]) ? Object.keys(entry["headers"]) : [];
  const secretKeys = [
    ...literalKeys(entry["headers"], () => true),
    ...literalKeys(entry["env"], (key) => SECRET_ENV.test(key)),
  ];
  const endpointKey =
    transport === "stdio"
      ? `stdio:${[command ?? "", ...args].join(" ").trim()}`
      : `${transport}:${sanitised?.endpoint ?? command ?? ""}`;
  const stats = await statOrNull(input.file);
  const base = baseEntity(scan, {
    kind: "mcp-server",
    path: input.file,
    keyPath: input.keyPath,
    scope: input.scope,
    project: input.project,
    ownership: "human",
    locator: { type: "entry", file: input.file, format: "json", keyPath: input.keyPath },
    format: "json",
    label: input.name,
    sensitive: envKeys.length > 0 || headerKeys.length > 0 || "oauth" in entry,
    protection: "none",
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
    command,
    args,
    url: sanitised?.url ?? null,
    envKeys,
    headerKeys,
    secretKeys,
    hasOauth: "oauth" in entry,
    usesInterpolation: containsInterpolation(entry),
    enabled: input.enabled,
    approval: input.approval,
    invalid,
    endpointKey,
    rawKeys: Object.keys(entry),
  };
  return addEntity(scan, entity);
}

function toggle(entryOf: ProjectEntry | null, name: string): boolean | null {
  if (entryOf === null) return null;
  if (entryOf.disabledMcpServers.includes(name)) return false;
  if (entryOf.enabledMcpServers.includes(name)) return true;
  return null;
}

function approvalOf(
  name: string,
  entryOf: ProjectEntry | null,
  settings: Record<string, unknown>,
): McpServer["approval"] {
  const enabled = new Set([
    ...(entryOf?.enabledMcpjsonServers ?? []),
    ...(isStringArray(settings["enabledMcpjsonServers"]) ? settings["enabledMcpjsonServers"] : []),
  ]);
  const disabled = new Set([
    ...(entryOf?.disabledMcpjsonServers ?? []),
    ...(isStringArray(settings["disabledMcpjsonServers"])
      ? settings["disabledMcpjsonServers"]
      : []),
  ]);
  if (disabled.has(name)) return "rejected";
  if (enabled.has(name)) return "approved";
  if (settings["enableAllProjectMcpServers"] === true) return "approved";
  return "pending";
}

function loadVerdict(
  scan: ClaudeScan,
  entity: McpServer,
  projectId: string | null,
  scopeReason: string,
): void {
  const mode: "full" | "never" | "disabled" | "unknown" =
    entity.invalid !== null
      ? "never"
      : entity.enabled === false || entity.approval === "rejected"
        ? "disabled"
        : entity.approval === "pending"
          ? "unknown"
          : "full";
  const reason =
    entity.invalid !== null
      ? `${entity.invalid}: the harness skips this entry`
      : entity.approval === "rejected"
        ? "rejected in the project approval list"
        : entity.enabled === false
          ? "disabled with /mcp for this project"
          : entity.approval === "pending"
            ? "awaiting the per-server approval prompt"
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
  return entity.scope === "local" ? 3 : entity.scope === "project" ? 2 : 1;
}

export async function collectMcp(scan: ClaudeScan, projects: DiscoveredProject[]): Promise<void> {
  const fold = scan.ctx.identity.fold;
  const byProject = new Map<string, McpServer[]>();
  const all: McpServer[] = [];
  const remember = (entity: McpServer, projectId: string | null): void => {
    all.push(entity);
    if (projectId === null) return;
    const list = byProject.get(projectId) ?? [];
    list.push(entity);
    byProject.set(projectId, list);
  };

  // User scope.
  for (const [name, entry] of Object.entries(scan.claudeJson.mcpServers)) {
    const entity = await mcpEntity(scan, {
      file: scan.claudeJson.path,
      keyPath: ["mcpServers", name],
      name,
      entry,
      scope: "user",
      project: null,
      removal: { method: "delegate", command: `claude mcp remove ${name} -s user` },
      approval: "not-applicable",
      enabled: null,
    });
    loadVerdict(scan, entity, null, "user scope: available in every session");
    remember(entity, null);
  }

  // Local scope: inside the per-project entries of ~/.claude.json. `claude mcp remove -s local`
  // acts on the entry of the directory it runs in, so the exact command (ticket 08 §3) changes
  // into the key's directory first; a key whose directory is gone or unreachable has no
  // runnable command and `~/.claude.json` is never edited → no removal.
  for (const projectEntry of scan.claudeJson.projects) {
    const located = scan.keyLocated.get(projectEntry.key) ?? null;
    const project = located?.project ?? null;
    const removalOf = (name: string): McpServer["removal"] =>
      located?.reachability === "present"
        ? {
            method: "delegate",
            command: `cd "${projectEntry.key}" && claude mcp remove ${name} -s local`,
          }
        : { method: "none" };
    for (const [name, entry] of Object.entries(projectEntry.mcpServers)) {
      const entity = await mcpEntity(scan, {
        file: scan.claudeJson.path,
        keyPath: ["projects", projectEntry.key, "mcpServers", name],
        name,
        entry,
        scope: "local",
        project,
        removal: removalOf(name),
        approval: "not-applicable",
        enabled: toggle(projectEntry, name),
      });
      loadVerdict(
        scan,
        entity,
        project?.id ?? null,
        `local scope: sessions started in ${projectEntry.key}`,
      );
      remember(entity, project?.id ?? null);
    }
  }

  // `~/.claude/.mcp.json`: a file Claude Code never reads (research 01 §4). D106 parses it for
  // key names and sanitised endpoints — that is what makes its entries visible at all — and D53
  // files the Orphan finding that says the servers belong in `~/.claude.json`.
  const userMcpFile = join(scan.paths.configDir, ".mcp.json");
  const userMcp = await readJsonObject(userMcpFile);
  const userMcpServers = userMcp === null ? null : userMcp["mcpServers"];
  if (isRecord(userMcpServers)) {
    for (const [name, entry] of Object.entries(userMcpServers)) {
      if (!isRecord(entry)) continue;
      const entity = await mcpEntity(scan, {
        file: userMcpFile,
        keyPath: ["mcpServers", name],
        name,
        entry,
        scope: "user",
        project: null,
        removal: { method: "backup-edit" },
        approval: "not-applicable",
        enabled: false,
      });
      loadedBy(scan, {
        from: entity.id,
        project: null,
        mode: "never",
        reason: "Claude Code does not read this file",
        placement: null,
        effectiveName: entity.name,
        ordered: false,
        charsLoaded: null,
        importsResolved: null,
        tokensLoaded: null,
        disableModelInvocation: null,
        countsTowardHeadline: false,
        evidence: [
          evidence("loading-rule", "~/.claude/.mcp.json is not a configuration file the CLI reads"),
        ],
      });
      remember(entity, null);
    }
  }

  // Project scope: <member>/.mcp.json.
  for (const project of projects) {
    if (project.reachability !== "present") continue;
    const facts = scan.projectFacts.get(project.id);
    const settings = facts?.effectiveSettings ?? {};
    const entryOf =
      scan.claudeJson.projects.find((entry) => {
        const located = scan.keyLocated.get(entry.key);
        return located?.project?.id === project.id && located.relativePath === null;
      }) ?? null;
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      const file = join(member.path, ".mcp.json");
      const data = await readJsonObject(file);
      if (data === null) continue;
      const servers = data["mcpServers"];
      if (!isRecord(servers)) continue;
      for (const [name, entry] of Object.entries(servers)) {
        if (!isRecord(entry)) continue;
        const entity = await mcpEntity(scan, {
          file,
          keyPath: ["mcpServers", name],
          name,
          entry,
          scope: "project",
          project,
          removal: { method: "backup-edit" },
          approval: approvalOf(name, entryOf, settings),
          enabled: toggle(entryOf, name),
        });
        remember(entity, project.id);
        loadVerdict(scan, entity, project.id, "project scope: approved for this project");
      }
    }
  }

  // Shadows: local > project > user by name, per Project.
  const userServers = all.filter((entity) => entity.scope === "user");
  for (const [, servers] of byProject) {
    const candidates = [...servers, ...userServers];
    const byName = new Map<string, McpServer[]>();
    for (const entity of candidates)
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
              `${winner.scope} scope wins over ${loser.scope} scope for the name ${winner.name}`,
            ),
          ],
          rule: "local > project > user",
        };
        addEdge(scan, edge);
        const shadowedEdge = scan.edges.get(loadedByEdgeId(loser.id, loser.project));
        if (
          shadowedEdge?.kind === "loaded-by" &&
          loser.scope !== "user" &&
          shadowedEdge.mode === "full"
        ) {
          shadowedEdge.mode = "shadowed";
          shadowedEdge.reason = `a ${winner.scope}-scope entry of the same name wins`;
        }
      }
    }
  }

  // Duplicates: the same endpoint configured at more than one place — plugin-provided servers
  // included (the harness dedupes them by endpoint too, research 01 §4).
  const byEndpoint = new Map<string, McpServer[]>();
  for (const entity of [...all, ...scan.extraMcp]) {
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
          // D133: an equal URL is strong evidence; two stdio commands that match are weaker.
          confidence: from.transport === "stdio" ? "medium" : "high",
          evidence: [evidence("endpoint", from.endpointKey)],
          same: "endpoint",
        };
        addEdge(scan, edge);
      }
    }
  }
}
