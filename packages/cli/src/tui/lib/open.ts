/**
 * The `o` keypress: hand a path to an editor.
 *
 * Resolution order, first hit wins: `cursor -g` when `CURSOR_TRACE_ID` is set, `code -g` when
 * `TERM_PROGRAM=vscode` or `code` is on `PATH`, then `$VISUAL`, then `$EDITOR`. Terminal
 * editors run with inherited stdio inside Ink's `suspendTerminal()`; GUI editors are spawned
 * detached and unref'd. Never a shell, except the `.cmd` shims Node refuses to spawn without
 * one on Windows. No locator carries a line in index v0, so `<line>` is always 1.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
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
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
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
  if (onPath("code", env, platform) !== null) {
    return { command: "code", args: ["-g", goto], terminal: false, via: "code on PATH" };
  }
  for (const variable of ["VISUAL", "EDITOR"]) {
    const value = env[variable]?.trim();
    if (!value) continue;
    const [command, ...rest] = value.split(/\s+/u);
    if (command === undefined) continue;
    const bin = basename(command).replace(/\.(exe|cmd)$/iu, "");
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

export interface OpenOptions {
  readonly suspendTerminal: SuspendTerminal;
  readonly platform: string;
}

export async function openWith(opener: Opener, options: OpenOptions): Promise<string> {
  const shell = options.platform === "win32";
  const done = `opened with ${opener.command} (${opener.via})`;
  if (opener.terminal) {
    // Raw mode off, cursor visible, alternate screen exited; Ink repaints from scratch after.
    const outcome = { message: done };
    await options.suspendTerminal(() => {
      const result = spawnSync(opener.command, [...opener.args], { stdio: "inherit", shell });
      if (result.error) {
        outcome.message = `could not run ${opener.command}: ${result.error.message}`;
      }
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
    child.once("error", (error: Error) => {
      resolve(`could not run ${opener.command}: ${error.message}`);
    });
    child.once("spawn", () => {
      child.unref();
      resolve(done);
    });
  });
}
