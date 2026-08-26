/* oxlint-disable no-await-in-loop -- sequential on purpose: bounded disk IO and a stable order */
/**
 * The two MCP schemas Copilot reads side by side (research 02 [71][76]): the CLI's
 * `mcpServers` map (`~/.copilot/mcp-config.json`, `<repo>/.github/mcp.json`, `<repo>/.mcp.json`,
 * with `type: local | stdio | http | sse`) and VS Code's `servers` map plus `inputs[]`
 * (`<Code/User>/mcp.json`, `<repo>/.vscode/mcp.json`). The CLI explicitly does not read
 * `.vscode/mcp.json`, so the two never shadow each other — they are different surfaces; where
 * one endpoint is configured in both, a `duplicates` edge says so.
 *
 * D65: these are configuration files, not credentials. moldig parses them for key names and the
 * sanitised endpoint and never keeps the value of an `env`, `headers` or `auth` entry. `inputs`
 * are never entries of their own.
 */
import { join } from "node:path";
import type { DuplicatesEdge, McpServer, Surface } from "../../index/types.js";
import { warning } from "../../scan/context.js";
import {
  ageDays,
  byteLength,
  isRecord,
  isStringArray,
  readJsonObject,
  readText,
  statOrNull,
  toIso,
} from "../../scan/fs.js";
import { edgeId } from "../../scan/paths.js";
import { parseJsoncObject } from "./parse.js";
import { sanitiseUrl } from "./redact.js";
import {
  addEdge,
  addEntity,
  baseEntity,
  evidence,
  HARNESS,
  loadedBy,
  surfaceName,
  type CopilotScan,
  type MemberScope,
} from "./model.js";

const SECRET_ENV = /token|secret|password|credential|apikey|api_key|auth/i;

export type McpSchema = "mcpServers" | "servers";

export interface McpFile {
  path: string;
  schema: McpSchema;
  surface: Surface;
  scope: "user" | "project";
  jsonc: boolean;
}

interface EntryInput extends McpFile {
  name: string;
  entry: Record<string, unknown>;
  project: MemberScope | null;
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

/**
 * The transport of an entry, per schema. `local` is the CLI's spelling of stdio; an entry with a
 * `url` and no `type` is `remote` rather than invalid (D69), and an unknown `type` is invalid —
 * the harness would skip it, so moldig says so instead of guessing.
 */
function transportOf(
  entry: Record<string, unknown>,
  schema: McpSchema,
): { transport: McpServer["transport"]; invalid: string | null } {
  const raw = typeof entry["type"] === "string" ? entry["type"] : null;
  const type =
    raw === "streamable-http" ? "http" : raw === "local" && schema === "mcpServers" ? "stdio" : raw;
  const command = typeof entry["command"] === "string" ? entry["command"] : null;
  const url = typeof entry["url"] === "string" ? entry["url"] : null;
  if (type === null) {
    if (command !== null) return { transport: "stdio", invalid: null };
    if (url !== null) return { transport: "remote", invalid: null };
    return { transport: "unknown", invalid: "entry names neither a command nor a url" };
  }
  if (type === "stdio" || type === "http" || type === "sse" || type === "ws") {
    return { transport: type, invalid: null };
  }
  return { transport: "unknown", invalid: `unknown type ${type}` };
}

async function mcpEntity(scan: CopilotScan, input: EntryInput): Promise<McpServer> {
  const { entry } = input;
  const { transport, invalid } = transportOf(entry, input.schema);
  const command = typeof entry["command"] === "string" ? entry["command"] : null;
  const rawUrl = typeof entry["url"] === "string" ? entry["url"] : null;
  const args = isStringArray(entry["args"]) ? entry["args"] : [];
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
  const keyPath = [input.schema, input.name];
  const stats = await statOrNull(input.path);
  const base = baseEntity(scan, {
    kind: "mcp-server",
    path: input.path,
    keyPath,
    scope: input.scope,
    project: input.project?.project ?? null,
    ownership: "human",
    locator: {
      type: "entry",
      file: input.path,
      format: input.jsonc ? "jsonc" : "json",
      keyPath,
    },
    format: input.jsonc ? "jsonc" : "json",
    label: input.name,
    sensitive: envKeys.length > 0 || headerKeys.length > 0 || "auth" in entry,
    protection: "none",
    // Ticket 14 §1: an MCP entry is removed by editing its file with a backup, never by trashing it.
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
    url: sanitised?.url ?? null,
    envKeys,
    headerKeys,
    secretKeys,
    hasOauth: "auth" in entry,
    usesInterpolation: containsInterpolation(entry),
    enabled: null,
    approval: input.scope === "user" ? "not-applicable" : "unknown",
    invalid,
    endpointKey,
    rawKeys: Object.keys(entry),
  };
  return addEntity(scan, entity);
}

function verdictOf(
  scan: CopilotScan,
  entity: McpServer,
  input: EntryInput,
  trusted: boolean | null,
): void {
  const where = surfaceName(input.surface);
  let mode: McpServer["invalid"] extends never ? never : "full" | "never" | "unknown";
  let reason: string;
  if (entity.invalid !== null) {
    mode = "never";
    reason = `${entity.invalid}: the harness skips this entry`;
  } else if (input.scope === "user") {
    mode = "full";
    reason = `user scope (${where}): available in every session`;
  } else if (input.surface === "vscode") {
    // VS Code's workspace trust lives in `state.vscdb`, which moldig never opens.
    mode = "unknown";
    reason = "VS Code workspace trust recorded in state.vscdb, which moldig never opens";
  } else if (trusted === true) {
    mode = "full";
    reason = `project scope (${where}): trusted folder`;
  } else if (trusted === false) {
    // D69: fail closed — an untrusted directory's servers are not read.
    mode = "never";
    reason = "untrusted project";
  } else {
    mode = "unknown";
    reason = "trust unknown: config.json is absent or unreadable";
  }
  loadedBy(scan, {
    from: entity.id,
    project: input.project?.project.id ?? null,
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

/** Server entries of one file; `null` when the file is absent. */
export async function readMcpFile(
  scan: CopilotScan,
  file: McpFile,
): Promise<Record<string, unknown> | null> {
  if (file.jsonc) {
    const text = await readText(file.path);
    if (text === null) return null;
    if (text.trim() === "") return {};
    const data = parseJsoncObject(text);
    if (data === null) {
      scan.ctx.warn(
        warning("parse-error", "mcp.json is not valid JSONC", HARNESS, file.path, "partial"),
      );
      return {};
    }
    return data;
  }
  const data = await readJsonObject(file.path);
  if (data === null) {
    const text = await readText(file.path);
    if (text === null) return null;
    if (text.trim() !== "") {
      scan.ctx.warn(
        warning(
          "parse-error",
          "MCP configuration is not valid JSON",
          HARNESS,
          file.path,
          "partial",
        ),
      );
    }
    return {};
  }
  return data;
}

async function collectFile(
  scan: CopilotScan,
  file: McpFile,
  scope: MemberScope | null,
  trusted: boolean | null,
  all: McpServer[],
): Promise<void> {
  const data = await readMcpFile(scan, file);
  if (data === null) return;
  const servers = data[file.schema];
  if (!isRecord(servers)) {
    scan.mcpEntries.set(scan.ctx.identity.fold(file.path), 0);
    return;
  }
  let count = 0;
  for (const [name, entry] of Object.entries(servers)) {
    if (!isRecord(entry)) {
      scan.ctx.warn(
        warning(
          "unsupported-shape",
          `MCP entry ${name} is not an object: skipped`,
          HARNESS,
          file.path,
          "skipped",
        ),
      );
      continue;
    }
    count += 1;
    const input: EntryInput = { ...file, name, entry, project: scope };
    const entity = await mcpEntity(scan, input);
    verdictOf(scan, entity, input, trusted);
    all.push(entity);
  }
  scan.mcpEntries.set(scan.ctx.identity.fold(file.path), count);
}

/** Every MCP file of the user scope and of one member, in the order they are read. */
export function userMcpFiles(scan: CopilotScan): McpFile[] {
  return [
    {
      path: join(scan.paths.cliHome, "mcp-config.json"),
      schema: "mcpServers",
      surface: "cli",
      scope: "user",
      jsonc: false,
    },
    {
      path: join(scan.paths.vscodeUser, "mcp.json"),
      schema: "servers",
      surface: "vscode",
      scope: "user",
      jsonc: true,
    },
  ];
}

export function memberMcpFiles(member: string): McpFile[] {
  return [
    {
      path: join(member, ".github", "mcp.json"),
      schema: "mcpServers",
      surface: "cli",
      scope: "project",
      jsonc: false,
    },
    // The Claude Code adapter owns this entity; Copilot's CLI reads it too, so it adds its edge
    // and — until that adapter is in the run — the row itself (D38 merges them).
    {
      path: join(member, ".mcp.json"),
      schema: "mcpServers",
      surface: "cli",
      scope: "project",
      jsonc: false,
    },
    {
      path: join(member, ".vscode", "mcp.json"),
      schema: "servers",
      surface: "vscode",
      scope: "project",
      jsonc: true,
    },
  ];
}

export async function collectMcp(
  scan: CopilotScan,
  members: readonly MemberScope[],
): Promise<void> {
  const all: McpServer[] = [];
  for (const file of userMcpFiles(scan)) await collectFile(scan, file, null, null, all);
  for (const scope of members) {
    const trusted = scan.projectFacts.get(scope.project.id)?.trusted ?? null;
    for (const file of memberMcpFiles(scope.path)) {
      await collectFile(scan, file, scope, trusted, all);
    }
  }

  // D133: one endpoint configured twice is a `duplicates` edge — high confidence for a URL,
  // medium for a stdio command that happens to match.
  const byEndpoint = new Map<string, McpServer[]>();
  for (const entity of all) {
    if (entity.invalid !== null || entity.endpointKey.endsWith(":")) continue;
    byEndpoint.set(entity.endpointKey, [...(byEndpoint.get(entity.endpointKey) ?? []), entity]);
  }
  const fold = scan.ctx.identity.fold;
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
