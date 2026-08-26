/**
 * Where Copilot keeps its files on both surfaces (research 02 [78], D33): the CLI home
 * (`$COPILOT_HOME`, else `~/.copilot`) and the VS Code user directory of the platform
 * (`~/Library/Application Support/Code/User` on darwin, `~/.config/Code/User` on linux,
 * `%APPDATA%\Code\User` on win32). The per-platform table itself lives in `scan/user-scope.ts`
 * so `scan.env` records exactly the overrides moldig honoured.
 */
import type { ScanContext } from "../../scan/context.js";
import { pathEngine } from "../../scan/paths.js";
import { userScopePaths, type UserScopePath } from "../../scan/user-scope.js";

export interface CopilotPaths {
  home: string;
  /** `$COPILOT_HOME` or `~/.copilot`. */
  cliHome: string;
  sessionState: string;
  logs: string;
  sessionStore: string;
  /** The VS Code user directory (`…/Code/User`). */
  vscodeUser: string;
  /** The VS Code Insiders user directory — listed by D33, scanned only when it exists. */
  vscodeInsidersUser: string;
  workspaceStorage: string;
  globalStorage: string;
  /** `Harness.userScope.paths`, straight from the shared table. */
  userScope: UserScopePath[];
}

/** A `<uuid>` session-state directory (Copilot CLI names one per session). */
export const SESSION_ID: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function copilotPaths(ctx: ScanContext): CopilotPaths {
  const engine = pathEngine(ctx.options.home);
  const home = engine.resolve(ctx.options.home);
  const scope = userScopePaths("copilot", ctx);
  // The table's order is fixed (D33): the CLI home, then `Code`, then `Code - Insiders`.
  const cliHome = scope[0]?.path ?? engine.join(home, ".copilot");
  const code = scope[1]?.path ?? engine.join(home, "Code");
  const insiders = scope[2]?.path ?? engine.join(home, "Code - Insiders");
  const vscodeUser = engine.join(code, "User");
  return {
    home,
    cliHome,
    sessionState: engine.join(cliHome, "session-state"),
    logs: engine.join(cliHome, "logs"),
    sessionStore: engine.join(cliHome, "session-store.db"),
    vscodeUser,
    vscodeInsidersUser: engine.join(insiders, "User"),
    workspaceStorage: engine.join(vscodeUser, "workspaceStorage"),
    globalStorage: engine.join(vscodeUser, "globalStorage"),
    userScope: scope,
  };
}
