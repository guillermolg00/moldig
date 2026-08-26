/**
 * Where Cursor keeps its files (research 02 §Cursor; D33): `~/.cursor` — relocated whole by
 * `CURSOR_CONFIG_DIR` — and the IDE's application-support directory, both taken from the shared
 * user-scope table so the per-platform locations live in one place and `scan.env` records exactly
 * the overrides moldig honoured. Plus the slug rule of `~/.cursor/projects/<slug>`, which is
 * compared and never decoded (`a-b` may be `a/b`, `a.b` or `a-b`).
 */
import { join } from "node:path";
import type { ScanContext } from "../../scan/context.js";
import { userScopePaths, type UserScopePath } from "../../scan/user-scope.js";

export interface CursorPaths {
  home: string;
  /** `~/.cursor`, or `CURSOR_CONFIG_DIR` when it relocated the tree (D33). */
  configDir: string;
  envVar: "CURSOR_CONFIG_DIR" | null;
  /** darwin `~/Library/Application Support/Cursor`, linux `~/.config/Cursor`, win32 `%APPDATA%\Cursor`. */
  appSupport: string;
  userDir: string;
  workspaceStorage: string;
  globalStorage: string;
  logsDir: string;
  projectsDir: string;
  worktreesDir: string;
  plansDir: string;
  /** The two rows of `Harness.userScope.paths`, with `source`/`envVar` already filled. */
  userScope: UserScopePath[];
}

export function cursorPaths(ctx: ScanContext): CursorPaths {
  const home = ctx.options.home;
  const scope = userScopePaths("cursor", ctx);
  const config = scope.find((entry) => entry.role === "config");
  const appSupport = scope.find((entry) => entry.role === "app-support");
  const configDir = config?.path ?? join(home, ".cursor");
  const appSupportDir = appSupport?.path ?? join(home, "Cursor");
  const userDir = join(appSupportDir, "User");
  return {
    home,
    configDir,
    envVar: config?.envVar === "CURSOR_CONFIG_DIR" ? "CURSOR_CONFIG_DIR" : null,
    appSupport: appSupportDir,
    userDir,
    workspaceStorage: join(userDir, "workspaceStorage"),
    globalStorage: join(userDir, "globalStorage"),
    logsDir: join(appSupportDir, "logs"),
    projectsDir: join(configDir, "projects"),
    worktreesDir: join(configDir, "worktrees"),
    plansDir: join(configDir, "plans"),
    userScope: scope,
  };
}

/**
 * `~/.cursor/projects/<slug>`: every run of `[^A-Za-z0-9]` collapses to one `-` and a leading
 * `-` is stripped, case kept (fixture README; research 09 §1). Not Claude Code's rule.
 */
export function cursorSlug(absolutePath: string): string {
  return absolutePath.replaceAll(/[^A-Za-z0-9]+/g, "-").replace(/^-/, "");
}

/** Slug directory names that are window ids, not paths (`1700000000000`, ms epoch). */
export function isWindowId(name: string): boolean {
  return /^\d+$/.test(name);
}

/**
 * A slug that names a temporary directory (research 09 §1: `$TMPDIR/<uuid>` sessions). Only
 * consulted for slugs nothing else resolved — on macOS the whole fixture tree lives under
 * `/private/var/folders/…`, so the prefix alone would swallow every resolvable slug.
 */
export function isTmpSlug(name: string, tmpDir: string | undefined): boolean {
  const prefixes = ["var-folders-", "private-var-folders-", "tmp-"];
  if (tmpDir !== undefined && tmpDir !== "") prefixes.push(cursorSlug(tmpDir));
  return prefixes.some((prefix) => prefix !== "" && name.startsWith(prefix));
}
