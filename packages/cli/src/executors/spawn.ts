/**
 * The delegate executor: argv and a working directory, never a shell (D87). A binary missing
 * from `PATH` is a failed row ("command not found"), never a crash (08 §4.5).
 */
import { spawn as spawnProcess } from "node:child_process";
import type { SpawnResult } from "@moldig/core";

const STDERR_LIMIT = 8192;

export function spawnDelegate(command: {
  argv: string[];
  cwd: string | null;
}): Promise<SpawnResult> {
  const [binary, ...args] = command.argv;
  if (binary === undefined) {
    return Promise.resolve({ exitCode: null, stderr: "no command to run" });
  }
  return new Promise((resolve) => {
    const child = spawnProcess(binary, args, {
      // `shell: false` is the default and is spelled out here on purpose: moldig never
      // interpolates a command into a shell.
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      ...(command.cwd === null ? {} : { cwd: command.cwd }),
    });
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < STDERR_LIMIT) stderr += chunk;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      const missing = error.code === "ENOENT";
      resolve({
        exitCode: null,
        stderr: missing ? `command not found: ${binary}` : error.message,
      });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code, stderr: stderr.trim() });
    });
  });
}
