#!/usr/bin/env node
// Entry point. Keep this file free of syntax newer than ES2022 so that an old Node still parses
// it and reaches the version check below instead of dying with a SyntaxError. `engines` is only
// a warning under `npx`.
//
// D19: the warning filter goes first. `node:sqlite` (used read-only for four harnesses) prints
// an ExperimentalWarning on Node 22.x, which would break the "stderr carries Warnings only"
// contract in CI. Every other warning is re-printed on stderr; nothing else is silenced.
process.removeAllListeners("warning");
process.on("warning", (warning) => {
  const experimentalSqlite =
    warning.name === "ExperimentalWarning" && /sqlite/i.test(warning.message);
  if (!experimentalSqlite) console.error(warning.stack || `${warning.name}: ${warning.message}`);
});

const MIN_MAJOR = 22;
const MIN_MINOR = 18;

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR)) {
  console.error(
    `moldig needs Node.js >= ${MIN_MAJOR}.${MIN_MINOR} (found ${process.versions.node}).`,
  );
  process.exitCode = 2; // D18: an environment error, like every other exit 2.
} else {
  // D22: the V8 compile cache shaves startup off every run after the first. Feature-detected
  // because it landed in Node 22.1 and the floor is 22.18 only for the rest of the CLI.
  const nodeModule = await import("node:module");
  if (typeof nodeModule.enableCompileCache === "function") {
    try {
      nodeModule.enableCompileCache();
    } catch {
      // A read-only or full cache directory must never stop the CLI.
    }
  }
  await import("./main.js");
}
