/* oxlint-disable no-await-in-loop -- sequential on purpose: the merge order of the layers decides the shadows */
/**
 * MCP servers (research 02 §OpenCode MCP): one entity per key of the `mcp` object of every
 * configuration file read — user, `$OPENCODE_CONFIG`, project. A `type: "local"` entry carries
 * its whole command line in `command[]`; a `type: "remote"` entry a `url`. Values never survive
 * beyond key names, the sanitised URL and the redacted command (D64/D65: moldig parses MCP
 * configuration, and never keeps its values).
 *
 * Same name inside one Project: project > `$OPENCODE_CONFIG` > user > system (`shadows`).
 * Same endpoint anywhere: `duplicates` (D133 — `high` for a URL, `medium` for a stdio command).
 */
import type { DuplicatesEdge, McpServer, ShadowsEdge } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { ageDays, byteLength, isRecord, isStringArray, statOrNull, toIso } from "../../scan/fs.js";
import { edgeId } from "../../scan/paths.js";
import { redactString } from "../claude-code/state.js";
import { formatOfConfig, mcpEntriesOf, type ConfigFile } from "./config.js";
import {
  addEdge,
  addEntity,
  baseEntity,
  evidence,
  loadedBy,
  loadedByEdgeId,
  type OpenCodeScan,
} from "./model.js";

const SECRET_ENV = /token|secret|password|credential|apikey|api_key|auth/i;

/** Where a layer sits in OpenCode's documented merge order; higher wins. */
export type LayerRank = 0 | 1 | 2 | 3;

export interface McpLayer {
  layer: ConfigFile;
  project: DiscoveredProject | null;
  rank: LayerRank;
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
  if (typeof value === "string") return value.includes("${") || /\{env:[^}]+\}/.test(value);
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

interface EntryInput {
  file: string;
  name: string;
  entry: Record<string, unknown>;
  scope: McpServer["scope"];
  project: DiscoveredProject | null;
  removal: McpServer["removal"];
}

async function mcpEntity(scan: OpenCodeScan, input: EntryInput): Promise<McpServer> {
  const { entry } = input;
  const type = typeof entry["type"] === "string" ? entry["type"] : null;
  const commandLine = isStringArray(entry["command"]) ? entry["command"] : [];
  const rawUrl = typeof entry["url"] === "string" ? entry["url"] : null;
  let transport: McpServer["transport"] = "unknown";
  let invalid: string | null = null;
  if (type === "local") transport = "stdio";
  else if (type === "remote") transport = "remote";
  else invalid = type === null ? "missing type" : `unknown type ${type}`;
  const sanitised = rawUrl === null ? null : sanitiseUrl(rawUrl);
  const command = commandLine[0] === undefined ? null : redactString(commandLine[0], null);
  const args = commandLine.slice(1).map((arg) => redactString(arg, null));
  const envKeys = isRecord(entry["environment"]) ? Object.keys(entry["environment"]) : [];
  const headerKeys = isRecord(entry["headers"]) ? Object.keys(entry["headers"]) : [];
  const secretKeys = [
    ...literalKeys(entry["headers"], () => true),
    ...literalKeys(entry["environment"], (key) => SECRET_ENV.test(key)),
  ];
  const endpointKey =
    transport === "stdio"
      ? `stdio:${commandLine.join(" ").trim()}`
      : `remote:${sanitised?.endpoint ?? ""}`;
  const stats = await statOrNull(input.file);
  const format = formatOfConfig(input.file);
  const base = baseEntity(scan, {
    kind: "mcp-server",
    path: input.file,
    keyPath: ["mcp", input.name],
    scope: input.scope,
    project: input.project,
    ownership: "human",
    locator: { type: "entry", file: input.file, format, keyPath: ["mcp", input.name] },
    format,
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
    url: sanitised === null ? null : redactString(sanitised.url, null),
    envKeys,
    headerKeys,
    secretKeys,
    hasOauth: "oauth" in entry,
    usesInterpolation: containsInterpolation(entry),
    enabled: typeof entry["enabled"] === "boolean" ? entry["enabled"] : true,
    // No per-server approval prompt exists on disk (research 02 §OpenCode MCP).
    approval: "not-applicable",
    invalid,
    endpointKey,
    rawKeys: Object.keys(entry),
  };
  return addEntity(scan, entity);
}

function verdictOf(scan: OpenCodeScan, entity: McpServer, projectId: string | null): void {
  const mode: "full" | "never" | "disabled" =
    entity.invalid !== null ? "never" : entity.enabled === false ? "disabled" : "full";
  const reason =
    entity.invalid !== null
      ? `${entity.invalid}: the harness skips this entry`
      : entity.enabled === false
        ? "enabled: false"
        : entity.scope === "project"
          ? "project scope: sessions started in this Project"
          : "user scope: available in every session";
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

/**
 * Removal (14 §1): an entry of a file moldig can edit is a `backup-edit`; a system-scope entry,
 * which lies outside the home directory and is not read in v1, would be `none`.
 */
function removalOf(scope: McpServer["scope"]): McpServer["removal"] {
  return scope === "system" ? { method: "none" } : { method: "backup-edit" };
}

export async function collectMcp(scan: OpenCodeScan, layers: readonly McpLayer[]): Promise<void> {
  const emitted: { entity: McpServer; rank: LayerRank; project: string | null }[] = [];
  for (const { layer, project, rank } of layers) {
    for (const [name, entry] of mcpEntriesOf(layer)) {
      const scope: McpServer["scope"] = layer.scope === "project" ? "project" : layer.scope;
      const entity = await mcpEntity(scan, {
        file: layer.path,
        name,
        entry,
        scope,
        project,
        removal: removalOf(scope),
      });
      verdictOf(scan, entity, project?.id ?? null);
      emitted.push({ entity, rank, project: project?.id ?? null });
    }
  }

  // Shadows: within one Project, along the merge order. A user entry loses to a project entry
  // of the same name only inside that Project, which is what the per-Project edge id records.
  const projects = new Set(emitted.map((item) => item.project).filter((id) => id !== null));
  for (const projectId of projects) {
    const candidates = emitted.filter(
      (item) => item.project === projectId || item.project === null,
    );
    const byName = new Map<string, typeof emitted>();
    for (const item of candidates)
      byName.set(item.entity.name, [...(byName.get(item.entity.name) ?? []), item]);
    for (const [, group] of byName) {
      const sorted = group.toSorted(
        (a, b) => b.rank - a.rank || a.entity.id.localeCompare(b.entity.id),
      );
      const winner = sorted[0];
      if (winner === undefined) continue;
      for (const loser of sorted.slice(1)) {
        if (loser.rank === winner.rank) continue;
        const edge: ShadowsEdge = {
          id: edgeId("shadows", winner.entity.id, loser.entity.id),
          kind: "shadows",
          from: winner.entity.id,
          to: loser.entity.id,
          confidence: "certain",
          evidence: [
            evidence(
              "precedence-rule",
              `${winner.entity.scope} scope wins over ${loser.entity.scope} scope for the name ${winner.entity.name}`,
            ),
          ],
          rule: "project > OPENCODE_CONFIG > user > system",
        };
        addEdge(scan, edge);
        const shadowed = scan.edges.get(loadedByEdgeId(loser.entity.id, loser.project));
        if (shadowed?.kind === "loaded-by" && loser.project !== null && shadowed.mode === "full") {
          shadowed.mode = "shadowed";
          shadowed.reason = `a ${winner.entity.scope}-scope entry of the same name wins`;
        }
      }
    }
  }

  // Duplicates: the same endpoint configured at more than one place (D79/D133).
  const fold = scan.ctx.identity.fold;
  const byEndpoint = new Map<string, McpServer[]>();
  for (const { entity } of emitted) {
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
