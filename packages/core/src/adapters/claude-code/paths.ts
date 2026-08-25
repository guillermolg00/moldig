/**
 * Where Claude Code keeps its files (research 01): `~/.claude/` (relocated whole by
 * `CLAUDE_CONFIG_DIR`, `~/.claude.json` included) and the slug rule of `projects/<slug>`.
 */
import { join, resolve } from "node:path";
import type { ScanContext } from "../../scan/context.js";

export interface ClaudePaths {
  home: string;
  configDir: string;
  claudeJson: string;
  projectsDir: string;
  /** `CLAUDE_CONFIG_DIR` when it relocated the tree. */
  envVar: "CLAUDE_CONFIG_DIR" | null;
}

export function claudePaths(ctx: ScanContext): ClaudePaths {
  const home = resolve(ctx.options.home);
  const override = ctx.consultEnv("CLAUDE_CONFIG_DIR");
  const configDir = override === undefined ? join(home, ".claude") : resolve(override);
  return {
    home,
    configDir,
    claudeJson:
      override === undefined ? join(home, ".claude.json") : join(configDir, ".claude.json"),
    projectsDir: join(configDir, "projects"),
    envVar: override === undefined ? null : "CLAUDE_CONFIG_DIR",
  };
}

/** `~/.claude/projects/<slug>`: every character outside `[A-Za-z0-9]` becomes `-`, case kept. */
export function slugOf(absolutePath: string): string {
  return absolutePath.replaceAll(/[^A-Za-z0-9]/g, "-");
}

export const SESSION_ID: RegExp = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
