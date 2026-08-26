/**
 * The one file that reads `process`: it builds the real `Io` and hands it to `runCli`. Setting
 * `process.exitCode` (never `process.exit`) lets stdout drain before Node leaves.
 *
 * The TUI arrives through a dynamic import so a piped `moldig audit --json` never parses Ink;
 * `runCli` decides whether to call it and stays free of any terminal dependency.
 */
import { homedir } from "node:os";
import { runCli } from "./run.js";
import type { OpenTui } from "./tui/index.js";

// D20: `TERM=dumb` takes the non-interactive path, alternate screen included.
const dumb = process.env["TERM"] === "dumb";

const openTui: OpenTui = async (request) => {
  const { openTui: open } = await import("./tui/index.js");
  return open(request);
};

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (chunk) => {
    process.stdout.write(chunk);
  },
  stderr: (chunk) => {
    process.stderr.write(chunk);
  },
  isTTY: process.stdout.isTTY,
  stdinIsTTY: process.stdin.isTTY && !dumb,
  columns: process.stdout.columns ?? 80,
  env: process.env,
  cwd: process.cwd(),
  home: homedir(),
  platform: process.platform,
  openTui,
});
