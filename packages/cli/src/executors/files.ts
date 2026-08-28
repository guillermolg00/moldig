/**
 * The filesystem executors: a backup copier, an atomic write and the two reads the engine
 * needs. `@moldig/core` decides what to copy and what to write; nothing here decides anything.
 */
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StatResult } from "@moldig/core";

/**
 * A byte-for-byte copy into the run's backup directory, before the file is edited or the
 * directory handed to an Installer (08 §3; 14 §2). Symlinks are copied as symlinks.
 */
export async function backup(
  path: string,
  to: string,
  expectedIdentity?: string | null,
): Promise<void> {
  await assertPathIdentity(path, expectedIdentity);
  await mkdir(dirname(to), { recursive: true });
  await cp(path, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  try {
    await assertPathIdentity(path, expectedIdentity);
  } catch (error) {
    await rm(to, { recursive: true, force: true });
    throw error;
  }
}

/**
 * The directory a path sits in, created when it is not there. The run manifest is written
 * before the first move (D91), and its `<data dir>/runs/` may not exist yet (08 §5).
 */
export async function ensureDirFor(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

/** Temp file in the same directory, the original's mode, then a guarded rename (08 §2). */
export async function writeAtomic(
  path: string,
  text: string,
  expectedIdentity?: string | null,
): Promise<void> {
  await assertPathIdentity(path, expectedIdentity);
  const directory = dirname(path);
  const temp = join(
    directory,
    `.${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}.moldig`,
  );
  const mode = await stat(path).then(
    (found) => found.mode,
    () => null,
  );
  try {
    await writeFile(temp, text, "utf8");
    if (mode !== null) await chmod(temp, mode);
    await assertPathIdentity(path, expectedIdentity);
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

/** `null` when the file cannot be read; the engine turns that into a `failed` row. */
export async function readText(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch(() => null);
}

/** `lstat`, never `stat`: a link is judged where it sits, not where it points (D96, 08 §3.2). */
export async function statPath(path: string): Promise<StatResult | null> {
  try {
    const found = await lstat(path, { bigint: true });
    return {
      exists: true,
      bytes: Number(found.size),
      identity: [found.dev, found.ino, found.mode, found.size, found.mtimeNs, found.ctimeNs].join(
        ":",
      ),
    };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code === "ENOENT" || code === "ENOTDIR"
      ? { exists: false, bytes: 0, identity: null }
      : null;
  }
}

/** Refuse a path replaced or modified after the Plan's confirmation snapshot. */
export async function assertPathIdentity(
  path: string,
  expectedIdentity: string | null | undefined,
): Promise<void> {
  if (expectedIdentity === undefined) return;
  const found = await statPath(path);
  if (found === null || found.identity !== expectedIdentity) {
    throw new Error(`${path} changed after confirmation`);
  }
}
