/* oxlint-disable no-await-in-loop -- sequential on purpose: emission order and bounded disk IO depend on it */
/**
 * MCP servers Cursor loads (research 02 [19]; spec §1.6): `~/.cursor/mcp.json` at user scope and
 * `<member>/.cursor/mcp.json` at project scope, both `{"mcpServers": {"<name>": {…}}}`. The files
 * are parsed — D65: the never-open rule is about credentials, not about MCP configuration — and
 * nothing but key names, the sanitised URL and the command reaches the index.
 *
 * No `shadows` edge: Cursor documents no precedence between a user and a project entry of the
 * same name, and a project entry's approval lives in `state.vscdb`, which moldig never opens, so
 * it stays `unknown` (D68). Entries that share an endpoint are `duplicates` (D133).
 */
import { join } from "node:path";
import type { DuplicatesEdge, McpServer } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import {
  ageDays,
  byteLength,
  isRecord,
  isStringArray,
  readJsonObject,
  statOrNull,
  toIso,
} from "../../scan/fs.js";
import { edgeId } from "../../scan/paths.js";
import { addEdge, addEntity, baseEntity, evidence, loadedBy, type CursorScan } from "./model.js";
import { redactString } from "./settings.js";

const SECRET_ENV = /token|secret|password|credential|apikey|api_key|auth/i;

export interface EntryInput {
  file: string;
  name: string;
  entry: Record<string, unknown>;
  scope: "user" | "project";
  project: DiscoveredProject | null;
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

/** `${env:NAME}`, `${userHome}`, `${workspaceFolder}`, `${pathSeparator}`, `${/}` (research 02 [19]). */
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

export async function mcpEntity(scan: CursorScan, input: EntryInput): Promise<McpServer> {
  const { entry } = input;
  const rawType = typeof entry["type"] === "string" ? entry["type"] : null;
  const command = typeof entry["command"] === "string" ? entry["command"] : null;
  const rawUrl = typeof entry["url"] === "string" ? entry["url"] : null;
  // D64: an argument whose name part looks like a secret never reaches the index verbatim.
  const args = (isStringArray(entry["args"]) ? entry["args"] : []).map((arg) =>
    redactString(arg, arg),
  );
  const type = rawType === "streamable-http" ? "http" : rawType;
  let transport: McpServer["transport"] = "unknown";
  let invalid: string | null = null;
  if (type === null) {
    // Cursor accepts a bare `{url}` entry (research 02 [126]).
    if (command !== null) transport = "stdio";
    else if (rawUrl !== null) transport = "remote";
    else invalid = "neither command nor url";
  } else if (type === "stdio" || type === "http" || type === "sse" || type === "ws") {
    transport = type;
  } else {
    invalid = `unknown type ${type}`;
  }
  const sanitised = rawUrl === null ? null : sanitiseUrl(rawUrl);
  const envKeys = isRecord(entry["env"]) ? Object.keys(entry["env"]) : [];
  const headerKeys = isRecord(entry["headers"]) ? Object.keys(entry["headers"]) : [];
  const auth = entry["auth"];
  const secretKeys = [
    ...literalKeys(entry["headers"], () => true),
    ...literalKeys(entry["env"], (key) => SECRET_ENV.test(key)),
    ...literalKeys(auth, (key) => SECRET_ENV.test(key)),
  ];
  const endpointKey =
    transport === "stdio"
      ? `stdio:${[command ?? "", ...args].join(" ").trim()}`
      : `${transport}:${sanitised?.endpoint ?? command ?? ""}`;
  const stats = await statOrNull(input.file);
  const keyPath = ["mcpServers", input.name];
  const base = baseEntity(scan, {
    kind: "mcp-server",
    path: input.file,
    keyPath,
    scope: input.scope,
    project: input.project,
    ownership: "human",
    locator: { type: "entry", file: input.file, format: "json", keyPath },
    format: "json",
    label: input.name,
    sensitive: envKeys.length > 0 || headerKeys.length > 0 || auth !== undefined,
    protection: "none",
    // Ticket 14 §1: an entry is edited out of its file with a backup, never trashed.
    removal: { method: "backup-edit" },
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
    hasOauth: auth !== undefined,
    usesInterpolation: containsInterpolation(entry),
    enabled: null,
    // Cursor records project approvals in `state.vscdb` `cursor/approvedProjectMcpServers`, a
    // database moldig never opens (D68, D104).
    approval: input.scope === "user" ? "not-applicable" : "unknown",
    invalid,
    endpointKey,
    rawKeys: Object.keys(entry),
  };
  return addEntity(scan, entity);
}

function loadVerdict(scan: CursorScan, entity: McpServer, project: string | null): void {
  const mode = entity.invalid !== null ? "never" : entity.scope === "user" ? "full" : "unknown";
  const reason =
    entity.invalid !== null
      ? `${entity.invalid}: the harness skips this entry`
      : entity.scope === "user"
        ? "user scope: available in every workspace"
        : "project scope: approval recorded in state.vscdb, which moldig never opens";
  loadedBy(scan, {
    from: entity.id,
    project,
    mode,
    reason,
    placement: null,
    effectiveName: entity.name,
    ordered: false,
    charsLoaded: null,
    tokensLoaded: null,
    countsTowardHeadline: false,
    evidence: [evidence("loading-rule", reason)],
  });
}

async function entriesOf(file: string): Promise<[string, Record<string, unknown>][]> {
  const data = await readJsonObject(file);
  const servers = data === null ? null : data["mcpServers"];
  if (!isRecord(servers)) return [];
  return Object.entries(servers).filter((pair): pair is [string, Record<string, unknown>] =>
    isRecord(pair[1]),
  );
}

export async function collectMcp(
  scan: CursorScan,
  projects: readonly DiscoveredProject[],
): Promise<void> {
  const all: McpServer[] = [];
  for (const [name, entry] of await entriesOf(join(scan.paths.configDir, "mcp.json"))) {
    const entity = await mcpEntity(scan, {
      file: join(scan.paths.configDir, "mcp.json"),
      name,
      entry,
      scope: "user",
      project: null,
    });
    loadVerdict(scan, entity, null);
    all.push(entity);
  }
  for (const project of projects) {
    if (project.reachability !== "present") continue;
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      const file = join(member.path, ".cursor", "mcp.json");
      for (const [name, entry] of await entriesOf(file)) {
        const entity = await mcpEntity(scan, {
          file,
          name,
          entry,
          scope: "project",
          project,
        });
        loadVerdict(scan, entity, project.id);
        all.push(entity);
      }
    }
  }

  // D133: entries that share an endpoint file a duplicate; an equal URL is stronger evidence
  // than two stdio commands that match.
  const byEndpoint = new Map<string, McpServer[]>();
  for (const entity of all) {
    if (entity.invalid !== null || entity.endpointKey.endsWith(":")) continue;
    byEndpoint.set(entity.endpointKey, [...(byEndpoint.get(entity.endpointKey) ?? []), entity]);
  }
  for (const [, group] of byEndpoint) {
    const sorted = group.toSorted((a, b) => a.id.localeCompare(b.id));
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
