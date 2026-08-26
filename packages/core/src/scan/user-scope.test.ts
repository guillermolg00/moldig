import { describe, expect, it } from "vitest";
import type { HarnessId } from "../index/types.js";
import type { ScanPlatform } from "./paths.js";
import {
  appSupportDirOf,
  localAppDataOf,
  USER_SCOPE_ENV_VARS,
  userScopePaths,
  type UserScopeContext,
  type UserScopePath,
} from "./user-scope.js";

const HOME = { darwin: "/Users/x", linux: "/home/x", win32: "C:\\Users\\x" } as const;

/** `consultEnv` records what it honoured, exactly as the real context fills `scan.env`. */
function contextOf(
  platform: ScanPlatform,
  env: Record<string, string> = {},
): { ctx: UserScopeContext; consulted: Record<string, string> } {
  const consulted: Record<string, string> = {};
  const ctx: UserScopeContext = {
    options: { home: HOME[platform], platform, env },
    consultEnv: (name) => {
      const value = env[name];
      if (value !== undefined && value !== "") consulted[name] = value;
      return value === "" ? undefined : value;
    },
  };
  return { ctx, consulted };
}

function pathsOf(id: HarnessId, platform: ScanPlatform, env?: Record<string, string>): string[] {
  return userScopePaths(id, contextOf(platform, env).ctx).map((entry) => entry.path);
}

describe("userScopePaths (D33)", () => {
  it("pins the per-platform application-support directory of Cursor and VS Code", () => {
    expect(pathsOf("cursor", "darwin")).toEqual([
      "/Users/x/.cursor",
      "/Users/x/Library/Application Support/Cursor",
    ]);
    expect(pathsOf("cursor", "linux")).toEqual(["/home/x/.cursor", "/home/x/.config/Cursor"]);
    expect(appSupportDirOf(contextOf("win32").ctx, "Cursor")).toBe(
      "C:\\Users\\x\\AppData\\Roaming\\Cursor",
    );
    // VS Code is the same shape with the product name, Insiders listed beside it.
    expect(pathsOf("copilot", "darwin")).toEqual([
      "/Users/x/.copilot",
      "/Users/x/Library/Application Support/Code",
      "/Users/x/Library/Application Support/Code - Insiders",
    ]);
  });

  it("honours %APPDATA% and %LOCALAPPDATA% without recording them as overrides", () => {
    const { ctx, consulted } = contextOf("win32", {
      APPDATA: "D:\\Roaming",
      LOCALAPPDATA: "D:\\Local",
    });
    expect(userScopePaths("cursor", ctx).map((entry) => entry.path)).toEqual([
      "C:\\Users\\x\\.cursor",
      "D:\\Roaming\\Cursor",
    ]);
    expect(localAppDataOf(ctx)).toBe("D:\\Local");
    // `scan.env` carries only the overrides moldig honoured — a base directory is not one.
    expect(consulted).toEqual({});
  });

  it("puts Codex under the user profile on win32 and follows CODEX_HOME everywhere", () => {
    expect(pathsOf("codex", "win32")).toEqual(["C:\\Users\\x\\.codex"]);
    const { ctx, consulted } = contextOf("linux", {
      CODEX_HOME: "/srv/codex",
      CODEX_SQLITE_HOME: "/srv/codex-db",
    });
    expect(userScopePaths("codex", ctx)).toEqual<UserScopePath[]>([
      { path: "/srv/codex", role: "data", source: "env", envVar: "CODEX_HOME" },
      { path: "/srv/codex-db", role: "state", source: "env", envVar: "CODEX_SQLITE_HOME" },
    ]);
    expect(consulted).toEqual({ CODEX_HOME: "/srv/codex", CODEX_SQLITE_HOME: "/srv/codex-db" });
  });

  it("moves `~/.claude.json` inside the directory CLAUDE_CONFIG_DIR relocated", () => {
    expect(pathsOf("claude-code", "darwin")).toEqual(["/Users/x/.claude", "/Users/x/.claude.json"]);
    const relocated = userScopePaths(
      "claude-code",
      contextOf("linux", { CLAUDE_CONFIG_DIR: "/srv/cc" }).ctx,
    );
    expect(relocated).toEqual<UserScopePath[]>([
      { path: "/srv/cc", role: "data", source: "env", envVar: "CLAUDE_CONFIG_DIR" },
      { path: "/srv/cc/.claude.json", role: "state", source: "env", envVar: "CLAUDE_CONFIG_DIR" },
    ]);
  });

  it("reads OpenCode through XDG, on every platform, plus OPENCODE_CONFIG", () => {
    expect(pathsOf("opencode", "linux")).toEqual([
      "/home/x/.config/opencode",
      "/home/x/.local/share/opencode",
      "/home/x/.cache/opencode",
      "/home/x/.local/state/opencode",
    ]);
    const { ctx, consulted } = contextOf("linux", {
      XDG_DATA_HOME: "/srv/data",
      OPENCODE_CONFIG: "/srv/opencode.json",
    });
    const paths = userScopePaths("opencode", ctx);
    expect(paths).toContainEqual({
      path: "/srv/data/opencode",
      role: "data",
      source: "env",
      envVar: "XDG_DATA_HOME",
    });
    expect(paths).toContainEqual({
      path: "/srv/opencode.json",
      role: "config",
      source: "env",
      envVar: "OPENCODE_CONFIG",
    });
    expect(consulted["XDG_DATA_HOME"]).toBe("/srv/data");
  });

  it("adds the XDG skills lock to the shared stores only when XDG_STATE_HOME is set (D75)", () => {
    expect(pathsOf("shared", "linux")).toEqual(["/home/x/.agents"]);
    expect(pathsOf("shared", "linux", { XDG_STATE_HOME: "/srv/state" })).toEqual([
      "/home/x/.agents",
      "/srv/state/skills",
    ]);
  });

  it("marks every default as `default` with no envVar, and answers nothing for an unknown id", () => {
    for (const id of ["claude-code", "codex", "cursor", "copilot", "gemini-cli", "opencode"]) {
      const entries = userScopePaths(id, contextOf("darwin").ctx);
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry).toMatchObject({ source: "default", envVar: null });
      }
    }
    expect(userScopePaths("some-community-harness", contextOf("darwin").ctx)).toEqual([]);
  });

  it("lists exactly the overrides D33 and D135 name", () => {
    expect([...USER_SCOPE_ENV_VARS].toSorted()).toEqual(
      [
        "CLAUDE_CONFIG_DIR",
        "CODEX_HOME",
        "CODEX_SQLITE_HOME",
        "COPILOT_HOME",
        "CURSOR_CONFIG_DIR",
        "GEMINI_CLI_SYSTEM_DEFAULTS_PATH",
        "GEMINI_CLI_SYSTEM_SETTINGS_PATH",
        "OPENCODE_CONFIG",
        "XDG_CACHE_HOME",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
      ].toSorted(),
    );
  });
});
