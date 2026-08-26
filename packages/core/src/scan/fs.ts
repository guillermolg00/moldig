/**
 * Filesystem helpers shared by discovery and the adapters: bounded stats, text reads that never
 * throw, byte/line counting and the age arithmetic every entity metric uses.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { Dirent, Stats } from "node:fs";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

const DAY_MS = 86_400_000;

/**
 * One scan's memo of `readdir`, `stat`, `lstat` and `realpath` (ticket 28). Every adapter walks
 * the same Project trees looking for its own context files, so the same directory was read once
 * per adapter; the answers are identical because a scan is a point-in-time read of a tree it
 * never writes (ADR-0001), so the second reader takes the first one's promise.
 *
 * The memo lives in an `AsyncLocalStorage`, not a module variable: it belongs to one `scan` call,
 * so two scans in one process — the test suite runs many — never see each other's answers, and
 * nothing survives the call. Outside a scan the helpers behave exactly as before.
 */
interface ScanFsMemo {
  dirs: Map<string, Promise<Dirent[]>>;
  stats: Map<string, Promise<Stats | null>>;
  lstats: Map<string, Promise<Stats | null>>;
  realpaths: Map<string, Promise<string>>;
  /** Text files, under a budget: one `AGENTS.md` is read by five adapters, one `CLAUDE.md` by three. */
  texts: Map<string, Promise<string | null>>;
  textChars: { spent: number };
}

const memoStore = new AsyncLocalStorage<ScanFsMemo>();
const treeMemo = new AsyncLocalStorage<Map<string, Promise<TreeStats>>>();

/**
 * A bound on what one scan remembers. A home with a very large tree would otherwise hold every
 * `Dirent` of every directory it walked until the scan ends; past the bound the helpers simply
 * stop memoising, which costs speed and never an answer.
 */
const MEMO_LIMIT = 200_000;

/** How many characters of file text one scan keeps: enough for the files several adapters read. */
const TEXT_BUDGET_CHARS = 32_000_000;

/** Runs `body` with a fresh filesystem memo. `scan` wraps its whole pipeline in one. */
export function withFsMemo<T>(body: () => Promise<T>): Promise<T> {
  return memoStore.run(
    {
      dirs: new Map(),
      stats: new Map(),
      lstats: new Map(),
      realpaths: new Map(),
      texts: new Map(),
      textChars: { spent: 0 },
    },
    () => treeMemo.run(new Map(), body),
  );
}

function memoised<T>(
  pick: (memo: ScanFsMemo) => Map<string, Promise<T>>,
  key: string,
  read: () => Promise<T>,
): Promise<T> {
  const memo = memoStore.getStore();
  if (memo === undefined) return read();
  const cache = pick(memo);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const pending = read();
  if (cache.size < MEMO_LIMIT) cache.set(key, pending);
  return pending;
}

/**
 * `stat` under a deadline: `null` when the path is missing, `"timeout"` past the deadline.
 * A deadline of zero or less has already passed, so nothing is stat'ed at all — which is what
 * makes the `stat-deadline` path deterministic in tests.
 */
export async function statWithDeadline(
  path: string,
  deadlineMs: number,
): Promise<Stats | null | "timeout"> {
  if (deadlineMs <= 0) return "timeout";
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

export function statOrNull(path: string): Promise<Stats | null> {
  return memoised(
    (memo) => memo.stats,
    path,
    async () => {
      try {
        return await stat(path);
      } catch {
        return null;
      }
    },
  );
}

export function lstatOrNull(path: string): Promise<Stats | null> {
  return memoised(
    (memo) => memo.lstats,
    path,
    async () => {
      try {
        return await lstat(path);
      } catch {
        return null;
      }
    },
  );
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
export function realpathOrSelf(path: string): Promise<string> {
  return memoised(
    (memo) => memo.realpaths,
    path,
    async () => {
      try {
        return await realpath(path);
      } catch {
        return path;
      }
    },
  );
}

/**
 * Directory entries, empty when the directory cannot be listed. Callers never mutate the array
 * — they `filter`, `map` and `toSorted` — so one scan's readers share one listing.
 */
export function listDir(path: string): Promise<Dirent[]> {
  return memoised(
    (memo) => memo.dirs,
    path,
    async () => {
      try {
        return await readdir(path, { withFileTypes: true });
      } catch {
        return [];
      }
    },
  );
}

/**
 * UTF-8 contents, `null` when the file cannot be read. Memoised per scan under a character
 * budget: one `AGENTS.md` is read by five adapters and one `CLAUDE.md` by three, and past the
 * budget the file is simply read again rather than held.
 */
export function readText(path: string): Promise<string | null> {
  const memo = memoStore.getStore();
  if (memo === undefined) return readTextOf(path);
  const hit = memo.texts.get(path);
  if (hit !== undefined) return hit;
  if (memo.textChars.spent >= TEXT_BUDGET_CHARS) return readTextOf(path);
  const pending = (async () => {
    const text = await readTextOf(path);
    memo.textChars.spent += text?.length ?? 0;
    return text;
  })();
  memo.texts.set(path, pending);
  return pending;
}

async function readTextOf(path: string): Promise<string | null> {
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

/**
 * Size and mtime range of a file or of every file below a directory (symlinks not followed).
 * Memoised per scan alongside the other helpers: an adapter typically asks a unit's size twice —
 * once to decide whether the unit exists at all (`files === 0`), once to fill its metrics.
 */
export function treeStats(path: string, depth = 0): Promise<TreeStats> {
  const memo = treeMemo.getStore();
  // Only the walks an adapter starts are remembered; the recursion below them is already served
  // by the memoised `lstat` and `readdir`, and remembering every node would hold a whole tree.
  if (memo === undefined || depth !== 0) return treeStatsOf(path, depth);
  const hit = memo.get(path);
  if (hit !== undefined) return hit;
  const pending = treeStatsOf(path, depth);
  if (memo.size < MEMO_LIMIT) memo.set(path, pending);
  return pending;
}

async function treeStatsOf(path: string, depth: number): Promise<TreeStats> {
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

/** How many probes one bounded pool keeps in flight: enough to saturate libuv's fs threads. */
export const POOL_SIZE = 64;

/**
 * `run` over `items` with at most `limit` in flight, results in input order (ticket 28).
 *
 * The adapters find their context files by probing every directory below a Project member for a
 * handful of names. Probing touches nothing but the disk, so the probes overlap; what the
 * adapter then does with the results stays strictly sequential, because the load-chain order and
 * the per-Project `order` numbers depend on it. The pool is bounded so a monorepo with thousands
 * of directories never has thousands of file handles open at once.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  run: (item: T) => Promise<R>,
  limit: number = POOL_SIZE,
): Promise<R[]> {
  const out: R[] = [];
  for (let start = 0; start < items.length; start += limit) {
    // oxlint-disable-next-line no-await-in-loop -- this *is* the bound: one slice at a time
    const slice = await Promise.all(items.slice(start, start + limit).map((item) => run(item)));
    out.push(...slice);
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
