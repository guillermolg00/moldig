/**
 * Where Gemini CLI keeps its files (research 02, Gemini section): `~/.gemini/` at user scope,
 * `<member>/.gemini/` per Project member, and the two system settings files whose directory is
 * pinned per platform (D78; `GEMINI_CLI_SYSTEM_DEFAULTS_PATH` / `GEMINI_CLI_SYSTEM_SETTINGS_PATH`
 * relocate each file — D135). The slug rule of `tmp/<slug>` and `history/<slug>` lives here too.
 */
import { basename, join, resolve } from "node:path";
import type { ScanContext } from "../../scan/context.js";
import { userScopePaths, type UserScopePath } from "../../scan/user-scope.js";

export const HARNESS = "gemini-cli" as const;
export const HARNESS_ID = "harness:gemini-cli";

export interface GeminiPaths {
  home: string;
  /** `~/.gemini` — no environment override is documented for the tree itself. */
  geminiDir: string;
  tmpDir: string;
  historyDir: string;
  extensionsDir: string;
  skillsDir: string;
  commandsDir: string;
  agentsDir: string;
  policiesDir: string;
  /** `~/.agents/skills` — the canonical store Gemini also reads (§6 user tier). */
  agentsStore: string;
  systemDefaults: string;
  systemSettings: string;
  systemDefaultsEnv: string | null;
  systemSettingsEnv: string | null;
  userScope: UserScopePath[];
}

/**
 * D78: `/Library/Application Support/GeminiCli` on darwin, `/etc/gemini-cli` on linux and
 * `%ProgramData%\gemini-cli` on win32 (confidence low — listed, never assumed).
 */
function systemDir(ctx: ScanContext): string {
  const { platform, env } = ctx.options;
  if (platform === "darwin") return "/Library/Application Support/GeminiCli";
  if (platform === "linux") return "/etc/gemini-cli";
  const programData = env["ProgramData"];
  return join(
    programData === undefined || programData === "" ? "C:\\ProgramData" : programData,
    "gemini-cli",
  );
}

export function geminiPaths(ctx: ScanContext): GeminiPaths {
  const home = resolve(ctx.options.home);
  const geminiDir = join(home, ".gemini");
  const sysDir = systemDir(ctx);
  const defaultsOverride = ctx.consultEnv("GEMINI_CLI_SYSTEM_DEFAULTS_PATH");
  const settingsOverride = ctx.consultEnv("GEMINI_CLI_SYSTEM_SETTINGS_PATH");
  return {
    home,
    geminiDir,
    tmpDir: join(geminiDir, "tmp"),
    historyDir: join(geminiDir, "history"),
    extensionsDir: join(geminiDir, "extensions"),
    skillsDir: join(geminiDir, "skills"),
    commandsDir: join(geminiDir, "commands"),
    agentsDir: join(geminiDir, "agents"),
    policiesDir: join(geminiDir, "policies"),
    agentsStore: join(home, ".agents", "skills"),
    systemDefaults:
      defaultsOverride === undefined
        ? join(sysDir, "system-defaults.json")
        : resolve(defaultsOverride),
    systemSettings:
      settingsOverride === undefined ? join(sysDir, "settings.json") : resolve(settingsOverride),
    systemDefaultsEnv: defaultsOverride === undefined ? null : "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
    systemSettingsEnv: settingsOverride === undefined ? null : "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
    userScope: userScopePaths(HARNESS, ctx),
  };
}

/**
 * Since v0.29.0: `slug = basename(path).toLowerCase()` with every character outside `[a-z0-9]`
 * replaced by `-`. Collision suffixes (`-1`, `-2`) are recorded in `projects.json` only, so they
 * are never derivable from a path (research 02; research 10 §2.3).
 */
export function slugOf(absolutePath: string): string {
  return basename(absolutePath)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]/g, "-");
}

/** A directory name that looks like the legacy `sha256(path)` slug. */
export const LEGACY_SLUG: RegExp = /^[0-9a-f]{64}$/;

/** `session-<ISO timestamp>-<id8>.jsonl` (legacy `.json`) — the anchor of a session unit. */
export const CHAT_FILE: RegExp = /^session-(.+)-([0-9a-f]{8})\.jsonl?$/i;

/** `session-<uuid>.jsonl` under `logs/`, and `tool-outputs/session-<uuid>/`. */
export const SESSION_MEMBER: RegExp = /^session-([0-9a-f-]{36})(?:\.jsonl)?$/i;

export const SESSION_ID: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
