/**
 * Where Codex keeps its files (research 02 §Codex; D33, D135): `$CODEX_HOME` when the variable
 * is set, else `<home>/.codex` — which is `%USERPROFILE%\.codex` on win32, the same join. Two
 * keys inside `config.toml` move parts of the tree: `sqlite_home` (also `CODEX_SQLITE_HOME`)
 * relocates the `*_N.sqlite` files and `log_dir` relocates `log/`. D135 honours the two config
 * keys as *configuration*, so only the environment variables reach `scan.env`.
 */
import type { ScanContext } from "../../scan/context.js";
import { pathEngine } from "../../scan/paths.js";
import { userScopePaths, type UserScopePath } from "../../scan/user-scope.js";

/** How a directory got its place: the default, an environment override, a `config.toml` key. */
export type Relocation = "default" | "env" | "config";

export interface CodexPaths {
  home: string;
  /** `$CODEX_HOME`. */
  dir: string;
  envVar: "CODEX_HOME" | null;
  /** Joins with the rules `home`'s own spelling implies, so a win32 fixture stays win32. */
  join: (...segments: string[]) => string;
  config: string;
  userAgents: string;
  sessions: string;
  archivedSessions: string;
  skills: string;
  systemSkills: string;
  memories: string;
  globalState: string;
  sqliteHome: string;
  sqliteVia: Relocation;
  logDir: string;
  logVia: Relocation;
  /** The user-scope table's own rows (D33), so `scan.env` records exactly what was honoured. */
  scopePaths: UserScopePath[];
}

function stringOf(settings: Record<string, unknown>, key: string): string | null {
  const value = settings[key];
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The Codex locations for this scan. `settings` is the **unredacted** effective configuration:
 * `sqlite_home` and `log_dir` are absolute paths, and D64's value rule would replace them with
 * `<redacted>` before they could be joined.
 */
export function codexPaths(ctx: ScanContext, settings: Record<string, unknown> = {}): CodexPaths {
  const scopePaths = userScopePaths("codex", ctx);
  const first = scopePaths[0];
  const engine = pathEngine(ctx.options.home);
  const home = engine.resolve(ctx.options.home);
  const dir = first?.path ?? engine.join(home, ".codex");
  const join = (...segments: string[]): string => engine.join(...segments);
  const sqliteEnv = scopePaths.find((entry) => entry.envVar === "CODEX_SQLITE_HOME");
  const sqliteKey = stringOf(settings, "sqlite_home");
  const logKey = stringOf(settings, "log_dir");
  return {
    home,
    dir,
    envVar: first?.envVar === "CODEX_HOME" ? "CODEX_HOME" : null,
    join,
    config: join(dir, "config.toml"),
    userAgents: join(home, ".agents", "skills"),
    sessions: join(dir, "sessions"),
    archivedSessions: join(dir, "archived_sessions"),
    skills: join(dir, "skills"),
    systemSkills: join(dir, "skills", ".system"),
    memories: join(dir, "memories"),
    globalState: join(dir, ".codex-global-state.json"),
    sqliteHome: sqliteEnv?.path ?? (sqliteKey === null ? dir : engine.resolve(sqliteKey)),
    sqliteVia: sqliteEnv === undefined ? (sqliteKey === null ? "default" : "config") : "env",
    logDir: logKey === null ? join(dir, "log") : engine.resolve(logKey),
    logVia: logKey === null ? "default" : "config",
    scopePaths,
  };
}

/** `rollout-<ISO-ish ts>-<thread uuid>[_<rollout uuid>].jsonl[.zst]` (research 02 §Sessions). */
export const ROLLOUT_NAME: RegExp =
  /^rollout-(\d{4}-\d{2}-\d{2})T[\d-]+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:_[0-9a-f-]{36})?\.jsonl(\.zst)?$/i;

/** `state_5.sqlite`, `logs_2.sqlite`, … — the versioned database names of `state/src/sqlite.rs`. */
export const VERSIONED_DB: RegExp = /^[A-Za-z0-9_]+_\d+\.sqlite$/;

/** A database's write-ahead sidecars, which a read-only scan must never bring into being. */
export const DB_SIDECARS: readonly string[] = ["-wal", "-shm"];

/** The desktop app's rotating leftovers beside `.codex-global-state.json` (fixture edge case 10). */
export const GLOBAL_STATE_TMP: RegExp = /^\.\.codex-global-state\.json\.tmp-/;

/**
 * Credential material: never opened at all, only stat'ed (D65). The four documented Codex names
 * plus the shape of any other top-level entry that reads like a credential store, so a name
 * moldig has not seen fails closed into "never opened" rather than into a size-only row.
 */
export const CREDENTIAL_NAMES: readonly string[] = [
  "auth.json",
  ".credentials.json",
  "secrets",
  "mcp-oauth-locks",
];
export const CREDENTIAL_SHAPE: RegExp =
  /(auth|oauth|cred|secret|token|apikey|api_key|google_accounts)|(^|\.)\.env$/i;
