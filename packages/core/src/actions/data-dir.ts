/**
 * Where moldig keeps what a run produces: the data directory, the run id, the backup paths.
 * Pure string functions — nothing here creates a directory; `packages/cli` does that when it
 * writes. Nothing is ever written inside a repository (08 §3).
 */
import type { Locator } from "../index/types.js";

export interface DataDirInput {
  platform: "darwin" | "linux" | "win32";
  /** The environment the scan honoured; only `XDG_DATA_HOME` and `LOCALAPPDATA` are read. */
  env: Record<string, string | undefined>;
  home: string;
}

/**
 * `$XDG_DATA_HOME/moldig` (default `~/.local/share/moldig`) on macOS and Linux;
 * `%LOCALAPPDATA%\moldig` on Windows, falling back to `<home>\AppData\Local\moldig` (08 §3).
 */
export function dataDirFor({ platform, env, home }: DataDirInput): string {
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"];
    const base = local === undefined || local === "" ? `${home}\\AppData\\Local` : local;
    return `${base}\\moldig`;
  }
  const xdg = env["XDG_DATA_HOME"];
  const base = xdg === undefined || xdg === "" ? `${home}/.local/share` : xdg;
  return `${base}/moldig`;
}

const SEPARATOR: Readonly<Record<string, string>> = { win32: "\\" };

function join(platform: string, ...parts: string[]): string {
  return parts.join(SEPARATOR[platform] ?? "/");
}

/** The run's start time as an ISO 8601 UTC timestamp with `:` replaced by `-` (Windows names). */
export function runIdFor(now: Date): string {
  return now.toISOString().replaceAll(":", "-");
}

/** `<data dir>/runs/<run id>.json` — printed in the summary (08 §5.3). */
export function manifestPathFor(dataDir: string, runId: string, platform = "darwin"): string {
  return join(platform, dataDir, "runs", `${runId}.json`);
}

/** `<data dir>/backups/<run id>/` — one entry per backed-up file or directory (08 §5.2). */
export function backupDirFor(dataDir: string, runId: string, platform = "darwin"): string {
  return join(platform, dataDir, "backups", runId);
}

const KEEP = /[A-Za-z0-9._-]/u;

/**
 * D90: every byte outside `[A-Za-z0-9._-]` is percent-encoded as `%XX`, so two different
 * original paths can never collide on one backup name (the prototype's `%` substitution did).
 */
export function encodePath(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let out = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    out += KEEP.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** `<data dir>/backups/<run id>/<percent-encoded original path>` (D90). */
export function backupPathFor(backupDir: string, path: string, platform = "darwin"): string {
  return join(platform, backupDir, encodePath(path));
}

/** A stable key for a target with no Entity id: the locator, flattened (never a real path). */
export function locatorKey(locator: Locator): string {
  switch (locator.type) {
    case "file":
    case "dir": {
      return `${locator.type}:${locator.path}`;
    }
    case "paths": {
      return `paths:${locator.paths.join("|")}`;
    }
    case "entry":
    case "array-value": {
      return `${locator.type}:${locator.file}#${locator.keyPath.join("/")}`;
    }
    default: {
      return `sqlite:${locator.file}#${locator.table}/${locator.keyValue}`;
    }
  }
}
