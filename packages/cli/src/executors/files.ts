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
export async function backup(path: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await cp(path, to, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
}

/** Temp file in the same directory, the original's mode, then a rename (08 §2). */
export async function writeAtomic(path: string, text: string): Promise<void> {
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
  return lstat(path).then(
    (found) => ({ exists: true, bytes: found.size }),
    () => ({ exists: false, bytes: 0 }),
  );
}
