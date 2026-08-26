/**
 * The one file that reads `process`: it builds the real `Io` and hands it to `runCli`. Setting
 * `process.exitCode` (never `process.exit`) lets stdout drain before Node leaves.
 */
import { homedir } from "node:os";
import { runCli } from "./run.js";

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (chunk) => {
    process.stdout.write(chunk);
  },
  stderr: (chunk) => {
    process.stderr.write(chunk);
  },
  isTTY: process.stdout.isTTY,
  columns: process.stdout.columns ?? 80,
  env: process.env,
  cwd: process.cwd(),
  home: homedir(),
  platform: process.platform,
});
