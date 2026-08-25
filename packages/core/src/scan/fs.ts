/**
 * Filesystem helpers shared by discovery and the adapters: bounded stats, text reads that never
 * throw, byte/line counting and the age arithmetic every entity metric uses.
 */
import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

const DAY_MS = 86_400_000;

/** `stat` under a deadline: `null` when the path is missing, `"timeout"` past the deadline. */
export async function statWithDeadline(
  path: string,
  deadlineMs: number,
): Promise<Stats | null | "timeout"> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolveTimeout) => {
    timer = setTimeout(() => resolveTimeout("timeout"), deadlineMs);
  });
  try {
    return await Promise.race([stat(path).catch(() => null), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

export async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await lstat(path);
  } catch {
    return null;
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  const stats = await statOrNull(path);
  return stats !== null && stats.isDirectory();
}

export async function isFile(path: string): Promise<boolean> {
  const stats = await statOrNull(path);
  return stats !== null && stats.isFile();
}

/** `realpath` when the path exists, the path itself otherwise. */
export async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** Directory entries, empty when the directory cannot be listed. */
export async function listDir(path: string): Promise<Dirent[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** UTF-8 contents, `null` when the file cannot be read. */
export async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** Parsed JSON object, `null` when unreadable, unparsable or not an object. */
export async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  const text = await readText(path);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function sha256(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 0;
  for (const char of text) if (char === "\n") lines += 1;
  return text.endsWith("\n") ? lines : lines + 1;
}

export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

export function toIso(date: Date | number): string {
  return new Date(date).toISOString();
}

/** Whole days between `mtime` and `now`, never negative (a file copied after `now` is 0 days old). */
export function ageDays(mtimeMs: number, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - mtimeMs) / DAY_MS));
}

export interface TreeStats {
  files: number;
  bytes: number;
  oldestMs: number | null;
  newestMs: number | null;
}

/** Size and mtime range of a file or of every file below a directory (symlinks not followed). */
export async function treeStats(path: string, depth = 0): Promise<TreeStats> {
  const stats = await lstatOrNull(path);
  const out: TreeStats = { files: 0, bytes: 0, oldestMs: null, newestMs: null };
  if (stats === null) return out;
  const add = (fileStats: Stats): void => {
    out.files += 1;
    out.bytes += fileStats.size;
    out.oldestMs =
      out.oldestMs === null ? fileStats.mtimeMs : Math.min(out.oldestMs, fileStats.mtimeMs);
    out.newestMs =
      out.newestMs === null ? fileStats.mtimeMs : Math.max(out.newestMs, fileStats.mtimeMs);
  };
  if (stats.isFile() || stats.isSymbolicLink()) {
    add(stats);
    return out;
  }
  if (!stats.isDirectory() || depth > 32) return out;
  const children = await Promise.all(
    (await listDir(path)).map((entry) => treeStats(join(path, entry.name), depth + 1)),
  );
  for (const child of children) {
    out.files += child.files;
    out.bytes += child.bytes;
    if (child.oldestMs !== null) {
      out.oldestMs =
        out.oldestMs === null ? child.oldestMs : Math.min(out.oldestMs, child.oldestMs);
    }
    if (child.newestMs !== null) {
      out.newestMs =
        out.newestMs === null ? child.newestMs : Math.max(out.newestMs, child.newestMs);
    }
  }
  return out;
}

/** Runs `run` over `items` one after the other. */
export function sequentially<T>(
  items: readonly T[],
  run: (item: T) => Promise<void>,
): Promise<void> {
  return items.reduce<Promise<void>>(
    (chain, item) => chain.then(() => run(item)),
    Promise.resolve(),
  );
}
