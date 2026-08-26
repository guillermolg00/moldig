/**
 * Where each harness keeps its own files, per platform, and which environment variable moved
 * them (D33, D135; ticket 06 §10, 07 point 8). One table so every adapter asks the same place
 * instead of re-deriving `~/Library/Application Support/…` on its own, and so `scan.env` records
 * exactly the overrides moldig honoured.
 *
 * Nothing here touches the disk: the answer is a list of locations, and the adapter decides
 * which of them exist. Only the variables listed in `USER_SCOPE_ENV_VARS` are consulted through
 * `ctx.consultEnv` (they land in `scan.env`); the platform's own base directories (`APPDATA`,
 * `LOCALAPPDATA`, `ProgramData`) are read without being recorded — they are not overrides.
 *
 * Paths are joined with the rules the home directory's own spelling implies, so a `platform:
 * "win32"` run over a fixture builds `C:\Users\x\.codex` on any host.
 */
import type { Harness, HarnessId } from "../index/types.js";
import type { ResolvedOptions, ScanContext } from "./context.js";
import { pathEngine, type ScanPlatform } from "./paths.js";

export type UserScopePath = Harness["userScope"]["paths"][number];
export type UserScopeRole = UserScopePath["role"];

/** All the table reads from the scan context — a full `ScanContext` satisfies it. */
export interface UserScopeContext {
  readonly options: Pick<ResolvedOptions, "home" | "platform" | "env">;
  consultEnv: ScanContext["consultEnv"];
}

/**
 * Every environment override moldig honours (D33 + D135). A variable outside this list never
 * reaches `scan.env`, whatever a harness documents.
 */
export const USER_SCOPE_ENV_VARS: readonly string[] = [
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "CODEX_SQLITE_HOME",
  "COPILOT_HOME",
  "OPENCODE_CONFIG",
  "CURSOR_CONFIG_DIR",
  "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
  "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
];

/** Everything the table reads, with the home directory's own path rules. */
interface Scope {
  home: string;
  platform: ScanPlatform;
  join: (...segments: string[]) => string;
  resolve: (path: string) => string;
  /** Recorded in `scan.env` when set (D33's list only). */
  override(name: string): string | undefined;
  /** Read but never recorded: a platform base directory is not an override. */
  base(name: string): string | undefined;
}

function scopeOf(ctx: UserScopeContext): Scope {
  const engine = pathEngine(ctx.options.home);
  const home = engine.resolve(ctx.options.home);
  return {
    home,
    platform: ctx.options.platform,
    join: (...segments) => engine.join(...segments),
    resolve: (path) => engine.resolve(path),
    override: (name) => ctx.consultEnv(name),
    base: (name) => {
      const value = ctx.options.env[name];
      return value === undefined || value === "" ? undefined : value;
    },
  };
}

function entry(path: string, role: UserScopeRole, envVar: string | null = null): UserScopePath {
  return { path, role, source: envVar === null ? "default" : "env", envVar };
}

/** `<home>\AppData\Roaming` unless `%APPDATA%` says otherwise. */
function appData(scope: Scope): string {
  return scope.base("APPDATA") ?? scope.join(scope.home, "AppData", "Roaming");
}

/** The XDG directory a harness stores under, honouring the override when it is set. */
function xdg(
  scope: Scope,
  variable: string,
  fallback: readonly string[],
  leaf: string,
  role: UserScopeRole,
): UserScopePath {
  const override = scope.override(variable);
  return override === undefined
    ? entry(scope.join(scope.home, ...fallback, leaf), role)
    : entry(scope.join(scope.resolve(override), leaf), role, variable);
}

/** A directory relocated whole by one variable (`~/.codex` ← `CODEX_HOME`). */
function relocatable(
  scope: Scope,
  variable: string,
  fallback: string,
  role: UserScopeRole,
): UserScopePath {
  const override = scope.override(variable);
  return override === undefined
    ? entry(scope.join(scope.home, fallback), role)
    : entry(scope.resolve(override), role, variable);
}

/**
 * The per-platform application-support directory of an Electron editor (D33): Cursor's and VS
 * Code's are the same shape with a different product name.
 */
function appSupportDir(scope: Scope, product: string): string {
  if (scope.platform === "darwin") {
    return scope.join(scope.home, "Library", "Application Support", product);
  }
  if (scope.platform === "win32") return scope.join(appData(scope), product);
  return scope.join(scope.home, ".config", product);
}

function claudeCode(scope: Scope): UserScopePath[] {
  const override = scope.override("CLAUDE_CONFIG_DIR");
  const configDir =
    override === undefined ? scope.join(scope.home, ".claude") : scope.resolve(override);
  const variable = override === undefined ? null : "CLAUDE_CONFIG_DIR";
  return [
    entry(configDir, "data", variable),
    // `~/.claude.json` moves inside the directory when the variable relocated it (research 01 §0).
    entry(
      scope.join(override === undefined ? scope.home : configDir, ".claude.json"),
      "state",
      variable,
    ),
  ];
}

function codex(scope: Scope): UserScopePath[] {
  // `%USERPROFILE%\.codex` on win32 is the same path: `home` is already the user profile (D33).
  const paths = [relocatable(scope, "CODEX_HOME", ".codex", "data")];
  const sqlite = scope.override("CODEX_SQLITE_HOME");
  if (sqlite !== undefined) paths.push(entry(scope.resolve(sqlite), "state", "CODEX_SQLITE_HOME"));
  return paths;
}

function cursor(scope: Scope): UserScopePath[] {
  return [
    relocatable(scope, "CURSOR_CONFIG_DIR", ".cursor", "config"),
    entry(appSupportDir(scope, "Cursor"), "app-support"),
  ];
}

function copilot(scope: Scope): UserScopePath[] {
  return [
    relocatable(scope, "COPILOT_HOME", ".copilot", "data"),
    // The VS Code surface of the same Harness (D33): Insiders is listed beside it.
    entry(appSupportDir(scope, "Code"), "app-support"),
    entry(appSupportDir(scope, "Code - Insiders"), "app-support"),
  ];
}

function geminiCli(scope: Scope): UserScopePath[] {
  const paths = [entry(scope.join(scope.home, ".gemini"), "data")];
  for (const variable of ["GEMINI_CLI_SYSTEM_DEFAULTS_PATH", "GEMINI_CLI_SYSTEM_SETTINGS_PATH"]) {
    const override = scope.override(variable);
    if (override !== undefined) paths.push(entry(scope.resolve(override), "config", variable));
  }
  const programData = scope.base("ProgramData");
  if (scope.platform === "win32" && programData !== undefined) {
    // D78: the system settings path, confidence low — listed, never assumed.
    paths.push(entry(scope.join(programData, "gemini-cli"), "config"));
  }
  return paths;
}

function openCode(scope: Scope): UserScopePath[] {
  const paths = [
    xdg(scope, "XDG_CONFIG_HOME", [".config"], "opencode", "config"),
    xdg(scope, "XDG_DATA_HOME", [".local", "share"], "opencode", "data"),
    xdg(scope, "XDG_CACHE_HOME", [".cache"], "opencode", "cache"),
    xdg(scope, "XDG_STATE_HOME", [".local", "state"], "opencode", "state"),
  ];
  const config = scope.override("OPENCODE_CONFIG");
  if (config !== undefined) paths.push(entry(scope.resolve(config), "config", "OPENCODE_CONFIG"));
  return paths;
}

/** The stores several harnesses share: `~/.agents` and, when relocated, the XDG skills lock (D75). */
function sharedStores(scope: Scope): UserScopePath[] {
  const paths = [entry(scope.join(scope.home, ".agents"), "data")];
  const state = scope.override("XDG_STATE_HOME");
  if (state !== undefined) {
    paths.push(entry(scope.join(scope.resolve(state), "skills"), "state", "XDG_STATE_HOME"));
  }
  return paths;
}

/**
 * Where harness `id` keeps its files on `ctx.options.platform`, with `source`/`envVar` filled.
 * An id with no entry in the table yields an empty list rather than a guess.
 */
export function userScopePaths(id: HarnessId, ctx: UserScopeContext): UserScopePath[] {
  const scope = scopeOf(ctx);
  switch (id) {
    case "claude-code":
      return claudeCode(scope);
    case "codex":
      return codex(scope);
    case "cursor":
      return cursor(scope);
    case "copilot":
      return copilot(scope);
    case "gemini-cli":
      return geminiCli(scope);
    case "opencode":
      return openCode(scope);
    case "shared":
      return sharedStores(scope);
    default:
      return [];
  }
}

/**
 * The application-support directory of an Electron editor on this platform (`Cursor`, `Code`,
 * `Code - Insiders`) — the one place the per-OS table lives (D33).
 */
export function appSupportDirOf(ctx: UserScopeContext, product: string): string {
  return appSupportDir(scopeOf(ctx), product);
}

/** `%LOCALAPPDATA%` for the adapters that need it (Copilot's VS Code cache on win32). */
export function localAppDataOf(ctx: UserScopeContext): string {
  const scope = scopeOf(ctx);
  return scope.base("LOCALAPPDATA") ?? scope.join(scope.home, "AppData", "Local");
}
