// THROWAWAY PROTOTYPE (ticket 09) — the `o` keypress: hand a path to an editor.
//
// Resolution order (research 03): `cursor -g` when CURSOR_TRACE_ID is set, `code -g` when
// TERM_PROGRAM=vscode or `code` is on PATH, then $VISUAL, then $EDITOR. Terminal editors run
// with inherited stdio inside Ink's `suspendTerminal()`; GUI editors are spawned detached.
// Never a shell, except the `.cmd` shims Node refuses to spawn without one on Windows.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Env } from "./hyperlink.js";

export interface Opener {
  readonly command: string;
  readonly args: readonly string[];
  readonly terminal: boolean;
  readonly via: string;
}

const TERMINAL_EDITORS = new Set([
  "vi",
  "vim",
  "nvim",
  "nano",
  "emacs",
  "hx",
  "helix",
  "micro",
  "pico",
  "joe",
  "kak",
]);

function onPath(bin: string, env: Env, platform: string): string | null {
  const dirs = (env["PATH"] ?? "").split(platform === "win32" ? ";" : ":").filter(Boolean);
  const names = platform === "win32" ? [`${bin}.cmd`, `${bin}.exe`, bin] : [bin];
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export function resolveOpener(env: Env, platform: string, target: string, line = 1): Opener | null {
  const goto = `${target}:${line}`;
  if (env["CURSOR_TRACE_ID"]) {
    return { command: "cursor", args: ["-g", goto], terminal: false, via: "CURSOR_TRACE_ID" };
  }
  if (env["TERM_PROGRAM"] === "vscode") {
    return { command: "code", args: ["-g", goto], terminal: false, via: "TERM_PROGRAM=vscode" };
  }
  if (onPath("code", env, platform)) {
    return { command: "code", args: ["-g", goto], terminal: false, via: "code on PATH" };
  }
  for (const variable of ["VISUAL", "EDITOR"]) {
    const value = env[variable]?.trim();
    if (!value) continue;
    const [command, ...rest] = value.split(/\s+/);
    if (!command) continue;
    const bin = path.basename(command).replace(/\.(exe|cmd)$/i, "");
    return {
      command,
      args: [...rest, target],
      terminal: TERMINAL_EDITORS.has(bin),
      via: `$${variable}`,
    };
  }
  return null;
}

export type SuspendTerminal = (callback: () => void | Promise<void>) => Promise<void>;

export async function openWith(
  opener: Opener,
  options: { suspendTerminal: SuspendTerminal; platform: string },
): Promise<string> {
  const shell = options.platform === "win32";
  const done = `opened with ${opener.command} (${opener.via})`;
  if (opener.terminal) {
    const outcome: { message: string } = { message: done };
    await options.suspendTerminal(() => {
      const result = spawnSync(opener.command, [...opener.args], { stdio: "inherit", shell });
      if (result.error)
        outcome.message = `could not run ${opener.command}: ${result.error.message}`;
    });
    return outcome.message;
  }
  return new Promise((resolve) => {
    const child = spawn(opener.command, [...opener.args], {
      detached: options.platform !== "win32",
      stdio: "ignore",
      shell,
      windowsHide: true,
    });
    child.once("error", (error) => resolve(`could not run ${opener.command}: ${error.message}`));
    child.once("spawn", () => {
      child.unref();
      resolve(done);
    });
  });
}
