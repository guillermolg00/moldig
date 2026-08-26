/* oxlint-disable no-await-in-loop -- sequential on purpose: the layer order decides which entry shadows which */
/**
 * `[mcp_servers.<id>]` tables, in every `config.toml` layer this adapter reads: the user file, the
 * selected profile file and each `<dir>/.codex/config.toml` from the project root down to the
 * session directory (D56 leaves `/etc/codex` unread in v1). Codex has no project `.mcp.json`.
 *
 * D65 draws the line the whole scanner obeys here: MCP **configuration** is parsed — that is how
 * an entry becomes visible at all — and what leaves the parser is key names, a sanitised endpoint
 * and nothing else. Values never reach the index. The file itself is never written either: ticket
 * 14 §1 removes a user entry by delegating to `codex mcp remove`, and D60 refuses every other
 * scope because moldig does not edit TOML.
 */
import type { DuplicatesEdge, McpServer, ShadowsEdge } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { ageDays, byteLength, isRecord, isStringArray, statOrNull, toIso } from "../../scan/fs.js";
import { edgeId } from "../../scan/paths.js";
import {
  addEdge,
  addEntity,
  baseEntity,
  evidence,
  loadedBy,
  loadedByEdgeId,
  trustOf,
  type CodexScan,
  type ProjectLayer,
} from "./model.js";
import { tablesOf } from "./toml.js";

const SECRET_ENV = /token|secret|password|credential|apikey|api_key|auth/i;

export interface McpInput {
  file: string;
  name: string;
  entry: Record<string, unknown>;
  scope: "user" | "project" | "system";
  project: DiscoveredProject | null;
  approval: McpServer["approval"];
  removal: McpServer["removal"];
  /** How close this layer is to the session directory; higher wins a name (§1.6 shadows). */
  rank: number;
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

/** Names of environment variables an entry points at — never their values (§1.6). */
function envVarNames(entry: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (isStringArray(entry["env_vars"])) out.push(...entry["env_vars"]);
  if (typeof entry["bearer_token_env_var"] === "string") out.push(entry["bearer_token_env_var"]);
  const httpEnv = entry["env_http_headers"];
  if (isRecord(httpEnv)) {
    for (const value of Object.values(httpEnv)) if (typeof value === "string") out.push(value);
  }
  return out;
}

export async function mcpEntity(scan: CodexScan, input: McpInput): Promise<McpServer> {
  const { entry } = input;
  const command = typeof entry["command"] === "string" ? entry["command"] : null;
  const rawUrl = typeof entry["url"] === "string" ? entry["url"] : null;
  const args = isStringArray(entry["args"]) ? entry["args"] : [];
  let transport: McpServer["transport"] = "unknown";
  let invalid: string | null = null;
  if (command !== null) transport = "stdio";
  else if (rawUrl !== null) transport = "http";
  else invalid = "neither command nor url";
  const sanitised = rawUrl === null ? null : sanitiseUrl(rawUrl);
  const envKeys = [
    ...(isRecord(entry["env"]) ? Object.keys(entry["env"]) : []),
    ...envVarNames(entry),
  ];
  const headerKeys = isRecord(entry["http_headers"]) ? Object.keys(entry["http_headers"]) : [];
  const secretKeys = [
    ...literalKeys(entry["http_headers"], () => true),
    ...literalKeys(entry["env"], (key) => SECRET_ENV.test(key)),
  ];
  const auth = entry["auth"];
  const hasOauth = auth === "oauth" || auth === "chatgpt";
  const enabled = typeof entry["enabled"] === "boolean" ? entry["enabled"] : true;
  const endpointKey =
    transport === "stdio"
      ? `stdio:${[command ?? "", ...args].join(" ").trim()}`
      : `${transport}:${sanitised?.endpoint ?? ""}`;
  const stats = await statOrNull(input.file);
  const base = baseEntity(scan, {
    kind: "mcp-server",
    path: input.file,
    keyPath: ["mcp_servers", input.name],
    scope: input.scope,
    project: input.project,
    ownership: "human",
    locator: {
      type: "entry",
      file: input.file,
      format: "toml",
      keyPath: ["mcp_servers", input.name],
    },
    format: "toml",
    label: input.name,
    sensitive: envKeys.length > 0 || headerKeys.length > 0 || hasOauth,
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
    args: args.map((arg) => (/^[A-Za-z0-9_\-./+=]{24,}$/.test(arg) ? "<redacted>" : arg)),
    url: sanitised?.url ?? null,
    envKeys,
    headerKeys,
    secretKeys,
    hasOauth,
    usesInterpolation: containsInterpolation(entry),
    enabled,
    approval: input.approval,
    invalid,
    endpointKey,
    rawKeys: Object.keys(entry),
  };
  return addEntity(scan, entity);
}

function loadVerdict(
  scan: CodexScan,
  entity: McpServer,
  projectId: string | null,
  scopeReason: string,
): void {
  const mode: "full" | "never" | "disabled" | "unknown" =
    entity.invalid !== null
      ? "never"
      : entity.enabled === false
        ? "disabled"
        : entity.approval === "rejected"
          ? "never"
          : entity.approval === "pending"
            ? "unknown"
            : "full";
  const reason =
    entity.invalid !== null
      ? `${entity.invalid}: the harness skips this entry`
      : entity.enabled === false
        ? "enabled = false"
        : entity.approval === "rejected"
          ? "untrusted project"
          : entity.approval === "pending"
            ? "no trust entry: Codex asks before loading the project layer"
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

function approvalOf(trusted: boolean | null): McpServer["approval"] {
  if (trusted === true) return "approved";
  if (trusted === false) return "rejected";
  return "pending";
}

/** Every `[mcp_servers.*]` table of every layer, with its verdict, shadows and duplicates. */
export async function collectMcp(
  scan: CodexScan,
  projects: readonly DiscoveredProject[],
): Promise<void> {
  const fold = scan.ctx.identity.fold;
  const all: { entity: McpServer; rank: number }[] = [];
  const byProject = new Map<string, { entity: McpServer; rank: number }[]>();

  const emit = async (input: McpInput, scopeReason: string): Promise<void> => {
    const entity = await mcpEntity(scan, input);
    loadVerdict(scan, entity, input.project?.id ?? null, scopeReason);
    const row = { entity, rank: input.rank };
    all.push(row);
    if (input.project === null) return;
    byProject.set(input.project.id, [...(byProject.get(input.project.id) ?? []), row]);
  };

  // User scope, and the profile file when one is selected (rank 1 and 2 of §1.6's precedence).
  const userLayers: { file: string; rank: number }[] = [{ file: scan.config.path, rank: 1 }];
  if (scan.profile !== null) userLayers.push({ file: scan.profile.path, rank: 2 });
  for (const layer of userLayers) {
    const data = layer.rank === 1 ? scan.config.data : (scan.profile?.data ?? {});
    for (const [name, entry] of tablesOf(data, "mcp_servers")) {
      await emit(
        {
          file: layer.file,
          name,
          entry,
          scope: "user",
          project: null,
          approval: "not-applicable",
          // Ticket 14 §1: the file is copied to the run's backup dir, then the CLI does the edit.
          removal: { method: "delegate", command: `codex mcp remove ${name}` },
          rank: layer.rank,
        },
        "user scope: available in every session",
      );
    }
  }

  // Project scope: the `.codex/config.toml` layers, closest to the session directory last.
  for (const project of projects) {
    const layers = scan.projectLayers.get(project.id) ?? [];
    const trusted = trustOf(scan, project);
    for (const layer of layers) {
      for (const [name, entry] of tablesOf(layer.file.data, "mcp_servers")) {
        await emit(
          {
            file: layer.file.path,
            name,
            entry,
            scope: "project",
            project,
            approval: approvalOf(trusted),
            // D60: moldig never edits TOML and `codex mcp remove` targets the user configuration.
            removal: { method: "none" },
            rank: 10 + layer.depth,
          },
          "project scope: trusted project",
        );
      }
    }
  }

  // Shadows by name inside one Project: the closest `.codex/config.toml` wins over shallower
  // ones, which win over the profile file and the user file (§1.6).
  const userRows = all.filter((row) => row.entity.scope === "user");
  for (const [, rows] of byProject) {
    const byName = new Map<string, { entity: McpServer; rank: number }[]>();
    for (const row of [...rows, ...userRows]) {
      byName.set(row.entity.name, [...(byName.get(row.entity.name) ?? []), row]);
    }
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
              `a closer layer defines ${winner.entity.name} for this project`,
            ),
          ],
          rule: "closest .codex/config.toml > user > system",
        };
        addEdge(scan, edge);
        const shadowed = scan.edges.get(loadedByEdgeId(loser.entity.id, loser.entity.project));
        if (shadowed?.kind === "loaded-by" && shadowed.mode === "full") {
          shadowed.mode = "shadowed";
          shadowed.reason = "a closer entry of the same name wins";
        }
      }
    }
  }

  // Duplicates by endpoint, across files, scopes and (through the merge) harnesses — D133 keeps
  // ticket 07's confidence split: an equal URL is strong evidence, two stdio commands weaker.
  const byEndpoint = new Map<string, McpServer[]>();
  for (const { entity } of all) {
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

/** How many `[mcp_servers.*]` tables a layer holds — the `entries` count of its settings row. */
export function mcpEntryCount(
  layer: ProjectLayer | { file: { data: Record<string, unknown> } },
): number {
  return tablesOf(layer.file.data, "mcp_servers").length;
}
