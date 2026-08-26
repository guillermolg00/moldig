/**
 * What every adapter receives from `scan`: the injected environment (home, roots, cwd,
 * platform, env — never `process.env`), path identity, the tokenizer, discovery, git status
 * lookups and the warnings collector.
 */
import { basename, extname } from "node:path";
import type { RepoGitStatus } from "../git/git-status.js";
import type { Format, GitStatus, HarnessId, Metrics, Warning } from "../index/types.js";
import type { Tokenizer } from "../tokens/tokenizer.js";
import type { Discovery } from "./discovery.js";
import { ageDays, byteLength, countLines, statOrNull, toIso } from "./fs.js";
import { entityId, isUnder, type PathIdentity, type ScanPlatform } from "./paths.js";

export interface ResolvedOptions {
  home: string;
  roots: readonly string[];
  cwd: string;
  platform: ScanPlatform;
  env: Readonly<Record<string, string | undefined>>;
  git: boolean;
  now: Date;
  /** D50: PID liveness behind the `pid` and `in-use-marker` guards, injected so fixtures are deterministic. */
  isProcessAlive: (pid: number) => boolean;
}

export interface ScanContext {
  readonly options: ResolvedOptions;
  readonly identity: PathIdentity;
  readonly tokenizer: Tokenizer;
  readonly discovery: Discovery;
  readonly warnings: Warning[];
  /** Git status of an absolute path: `null` when git did not run for its repository. */
  gitStatusOf(path: string): GitStatus | null;
  /** Records an environment override that was consulted and set. */
  consultEnv(name: string): string | undefined;
  /** Environment overrides honoured, for `scan.env`. */
  readonly envConsulted: Record<string, string>;
  id(kind: string, path: string, keyPath?: readonly string[]): string;
  fileMetrics(path: string, text: string | null): Promise<Metrics>;
  warn(warning: Warning): void;
}

export interface GitLookup {
  /** Per repository or worktree directory (folded), the status listing; `null` = git failed there. */
  repos: Map<string, RepoGitStatus | null>;
}

const FORMAT_BY_EXT: Record<string, Format> = {
  ".md": "md",
  ".mdc": "mdc",
  ".txt": "txt",
  ".toml": "toml",
  ".json": "json",
  ".jsonc": "jsonc",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".star": "starlark",
  ".js": "js",
  ".mjs": "js",
  ".jsonl": "jsonl",
  ".zst": "jsonl.zst",
  ".sqlite": "sqlite",
  ".db": "sqlite",
  ".vscdb": "sqlite",
  ".pb": "pb",
};

export function formatOf(path: string): Format {
  const name = basename(path);
  if (name.endsWith(".jsonl.zst")) return "jsonl.zst";
  return FORMAT_BY_EXT[extname(name).toLowerCase()] ?? "other";
}

export function createContext(
  options: ResolvedOptions,
  identity: PathIdentity,
  tokenizer: Tokenizer,
  discovery: Discovery,
  git: GitLookup,
  /** Shared with discovery, which is built first and warns through the same collector (D36). */
  warnings: Warning[] = [],
): ScanContext {
  const envConsulted: Record<string, string> = {};

  function gitStatusOf(path: string): GitStatus | null {
    const folded = identity.fold(path);
    let best: { dir: string; status: RepoGitStatus | null } | null = null;
    for (const [dir, status] of git.repos) {
      if (isUnder(folded, dir) && (best === null || dir.length > best.dir.length))
        best = { dir, status };
    }
    if (best === null) return discovery.projectOf(path) === null ? "outside-repo" : null;
    return best.status === null ? null : best.status.statusOf(path);
  }

  return {
    options,
    identity,
    tokenizer,
    discovery,
    warnings,
    gitStatusOf,
    consultEnv(name) {
      const value = options.env[name];
      if (value !== undefined && value !== "") envConsulted[name] = value;
      return value === "" ? undefined : value;
    },
    envConsulted,
    id: (kind, path, keyPath) => entityId(kind, identity.fold(path), keyPath),
    async fileMetrics(path, text) {
      const stats = await statOrNull(path);
      const tokens = text === null ? null : tokenizer.count(text);
      return {
        bytes: stats?.size ?? (text === null ? 0 : byteLength(text)),
        files: 1,
        lines: text === null ? null : countLines(text),
        mtime: stats === null ? null : toIso(stats.mtimeMs),
        ageDays: stats === null ? null : ageDays(stats.mtimeMs, options.now),
        tokens,
        lastUsed: null,
      };
    },
    warn(item) {
      warnings.push(item);
    },
  };
}

export function warning(
  code: Warning["code"],
  message: string,
  harness: HarnessId | null,
  path: string | null,
  effect: Warning["effect"],
): Warning {
  return { code, message, harness, path, effect };
}
