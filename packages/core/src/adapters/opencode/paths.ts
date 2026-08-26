/**
 * Where OpenCode keeps its files (research 02 §OpenCode; D33): config, data and cache are split
 * across the XDG directories, and `$OPENCODE_CONFIG` names one extra configuration file merged
 * after the user's. The per-platform table itself lives in `scan/user-scope.ts` so `scan.env`
 * records exactly the overrides moldig honoured; this module only names the files inside them.
 *
 * The system layer (`/Library/Application Support/opencode/` on darwin) is **not** read in v1
 * (D56, like Claude Code's managed layer): it lies outside the injected home, so no fixture can
 * cover it and a scan must never reach into the real machine.
 */
import type { UserScopePath } from "../../scan/user-scope.js";
import { userScopePaths } from "../../scan/user-scope.js";
import type { ScanContext } from "../../scan/context.js";
import { pathEngine } from "../../scan/paths.js";

export const HARNESS_ID = "harness:opencode";

export interface OpenCodePaths {
  home: string;
  /** `$XDG_CONFIG_HOME/opencode` (default `~/.config/opencode`). */
  configDir: string;
  /** `$XDG_DATA_HOME/opencode` (default `~/.local/share/opencode`). */
  dataDir: string;
  /** `$XDG_CACHE_HOME/opencode` (default `~/.cache/opencode`). */
  cacheDir: string;
  /** `$OPENCODE_CONFIG`, when the variable named a file. */
  extraConfig: string | null;
  database: string;
  storageDir: string;
  logDir: string;
  /** The rows of `Harness.userScope.paths`, straight from the shared table (D33). */
  userScope: UserScopePath[];
}

export function openCodePaths(ctx: ScanContext): OpenCodePaths {
  // The table returns config, data, cache and state in that order, then `$OPENCODE_CONFIG`.
  const rows = userScopePaths("opencode", ctx);
  // The home directory's own spelling decides the rules, never the host's (D33).
  const engine = pathEngine(ctx.options.home);
  const join = (...segments: string[]): string => engine.join(...segments);
  const configDir = rows[0]?.path ?? join(ctx.options.home, ".config", "opencode");
  const dataDir = rows[1]?.path ?? join(ctx.options.home, ".local", "share", "opencode");
  const cacheDir = rows[2]?.path ?? join(ctx.options.home, ".cache", "opencode");
  const extra = rows.find((row) => row.envVar === "OPENCODE_CONFIG");
  return {
    home: ctx.options.home,
    configDir,
    dataDir,
    cacheDir,
    extraConfig: extra?.path ?? null,
    database: join(dataDir, "opencode.db"),
    storageDir: join(dataDir, "storage"),
    logDir: join(dataDir, "log"),
    userScope: rows,
  };
}

/** The two spellings of a configuration file, in the order OpenCode looks for them. */
export const CONFIG_NAMES: readonly string[] = ["opencode.json", "opencode.jsonc"];
