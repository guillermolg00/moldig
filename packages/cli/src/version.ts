/**
 * The published version of this package. Read at runtime from the package.json next to the
 * bundle (`dist/cli.mjs` → `../package.json`, which npm always ships) so nothing has to be
 * inlined at build time and the tests see the same number as the users.
 */
import { readFile } from "node:fs/promises";

let cached: Promise<string> | undefined;

async function read(): Promise<string> {
  try {
    const text = await readFile(new URL("../package.json", import.meta.url), "utf8");
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
      const version: unknown = parsed.version;
      if (typeof version === "string") return version;
    }
  } catch {
    // A missing or unreadable package.json must never stop the CLI from running.
  }
  return "0.0.0";
}

export function moldigVersion(): Promise<string> {
  cached ??= read();
  return cached;
}
