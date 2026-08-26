/**
 * §7.9 exposure [D10; D83; D112]: a secret sitting where it should not — in a configuration
 * collaborators can read, or in one nothing reads. Only MCP server entries in v1; secrets in
 * `.env` files and in settings `env` maps that are not MCP are out of scope [D83].
 *
 * `McpServer.secretKeys` already holds only **literal** keys (a non-empty string without `${…}`
 * interpolation), so an interpolated value never reaches this detector. **Key names only ever
 * leave this file — never a value.**
 */
import { basename } from "node:path";
import type { Finding, Index, LoadedByEdge, McpServer } from "../index/types.js";
import { statOrNull } from "../scan/fs.js";
import { containerOf, flagsOf, harnessNameOf, loadedByOf } from "./shared.js";

/** `headers.Authorization` / `env.API_KEY`: where the key sits, never what it holds. */
function keyDetail(entity: McpServer, key: string): string {
  if (entity.headerKeys.includes(key)) return `headers.${key}`;
  if (entity.envKeys.includes(key)) return `env.${key}`;
  return key;
}

/**
 * A file inside a repository that anyone on the machine can read is reachable by someone else
 * even when git does not track it. Unreadable or unstattable → not claimed (fail closed: the
 * finding stays `medium` or is not filed at all). Windows reports a mode bit that says nothing
 * about who can read the file, so nothing is claimed from it there — a tracked entry is still
 * `high` on every platform.
 */
async function isWorldReadable(index: Index, entity: McpServer, path: string): Promise<boolean> {
  if (index.scan.platform === "win32") return false;
  const project = index.projects.find((item) => item.id === entity.project);
  if (project === undefined) return false;
  if (project.kind !== "repository" && project.kind !== "detached-worktree") return false;
  const stats = await statOrNull(path);
  return stats !== null && (stats.mode & 0o004) !== 0;
}

function neverLoadedBy(edges: LoadedByEdge[]): LoadedByEdge | null {
  return edges.find((edge) => edge.mode === "never" || edge.mode === "disabled") ?? null;
}

export async function exposureFindings(index: Index): Promise<Finding[]> {
  const out: Finding[] = [];
  const servers = index.entities.filter(
    (entity): entity is McpServer => entity.kind === "mcp-server" && entity.secretKeys.length > 0,
  );
  for (const entity of servers) {
    const key = entity.secretKeys[0] ?? "";
    const file = entity.locator.type === "entry" ? entity.locator.file : entity.path;
    const harnessName = harnessNameOf(index, entity.harness);
    const evidence: Finding["evidence"] = entity.secretKeys.map((secret) => ({
      kind: "secret-key",
      detail: keyDetail(entity, secret),
    }));

    // D112: reachable by someone else — the entry is git-tracked, or the file is world-readable
    // inside a repository. Only those are `secret-exposed`.
    const tracked = entity.shared === true;
    // oxlint-disable-next-line no-await-in-loop -- one stat per entry with a literal secret
    const readable = !tracked && (await isWorldReadable(index, entity, file));
    if (tracked || readable) {
      evidence.push({
        kind: "git-status",
        detail: tracked ? "tracked" : "world-readable inside a repository",
      });
      out.push({
        id: `finding:exposure:${entity.id}`,
        category: "exposure",
        severity: "high",
        container: containerOf(entity),
        targets: [{ id: entity.id, role: "subject" }],
        message: entity.headerKeys.includes(key)
          ? `${entity.name} carries an ${key} header in a ${tracked ? "git-tracked" : "world-readable"} ${basename(file)}`
          : `${entity.name} carries a literal ${key} in a ${tracked ? "git-tracked" : "world-readable"} ${basename(file)}`,
        evidence,
        confidence: "certain",
        impact: { bytes: entity.metrics.bytes, tokens: null, files: 1 },
        flags: flagsOf([entity], ["secret-exposed", "sensitive"]),
        action: { kind: "open", preselect: false, locator: entity.locator },
      });
      continue;
    }

    // D112: a secret in a configuration nothing reads is `medium`, flagged `sensitive` — never
    // `secret-exposed`, because nobody but the owner can reach it.
    const absent =
      index.harnesses.find((harness) => harness.harness === entity.harness)?.presence === "absent";
    const never = neverLoadedBy(loadedByOf(index, entity.id));
    const disabled = entity.enabled === false || never?.mode === "disabled";
    if (!absent && !disabled && never === null) continue;
    evidence.push(
      absent
        ? { kind: "loading-rule", detail: "presence: absent" }
        : { kind: "loading-rule", detail: never?.reason ?? "the entry is disabled" },
    );
    const verdict = absent ? "is not installed for" : disabled ? "has disabled" : "does not read";
    out.push({
      id: `finding:exposure:${entity.id}`,
      category: "exposure",
      severity: "medium",
      container: containerOf(entity),
      targets: [{ id: entity.id, role: "subject" }],
      message: `${entity.name} carries a literal ${key} in ${basename(file)}, which ${harnessName} ${verdict}`,
      evidence,
      confidence: "certain",
      impact: { bytes: entity.metrics.bytes, tokens: null, files: 1 },
      flags: flagsOf([entity], ["sensitive"]),
      action: { kind: "open", preselect: false, locator: entity.locator },
    });
  }
  return out;
}
