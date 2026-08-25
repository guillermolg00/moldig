#!/usr/bin/env node
// Entry point. Keep this file free of syntax newer than ES2022 so that an old
// Node still parses it and reaches the version check below instead of dying
// with a SyntaxError. `engines` is only a warning under `npx`.
const MIN_MAJOR = 22;
const MIN_MINOR = 18;

const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
if (major < MIN_MAJOR || (major === MIN_MAJOR && minor < MIN_MINOR)) {
  console.error(
    `moldig needs Node.js >= ${MIN_MAJOR}.${MIN_MINOR} (found ${process.versions.node}).`,
  );
  process.exitCode = 1;
} else {
  await import("./main.js");
}
