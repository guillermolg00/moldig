/**
 * `sha256-folder` over a skill directory: the hash ticket 07 names, computed honestly. Two copies
 * of one public skill can carry byte-identical `SKILL.md` files and still differ — the fixture's
 * pair differs only in a payload `AGENTS.md` — so a hash of the entry file alone would call them
 * the same content. Symlinks are not followed and the walk is depth-bounded.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { listDir, lstatOrNull } from "../../scan/fs.js";

const MAX_DEPTH = 16;

async function filesUnder(dir: string, depth: number): Promise<string[]> {
  if (depth > MAX_DEPTH) return [];
  const entries = (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name));
  const out: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      // oxlint-disable-next-line no-await-in-loop -- ordered walk: the hash depends on the order
      out.push(...(await filesUnder(path, depth + 1)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      out.push(path);
    }
  }
  return out;
}

/** Hex sha256 over every file below `dir`, each contributing its relative path and its bytes. */
export async function folderHash(dir: string): Promise<string> {
  const hash = createHash("sha256");
  for (const file of await filesUnder(dir, 0)) {
    const relativePath = relative(dir, file).split(sep).join("/");
    hash.update(relativePath);
    hash.update("\0");
    // oxlint-disable-next-line no-await-in-loop -- the digest is order-dependent
    const stats = await lstatOrNull(file);
    if (stats !== null && stats.isSymbolicLink()) {
      hash.update("symlink\0");
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- the digest is order-dependent
    const bytes = await readFile(file).catch(() => null);
    hash.update(bytes ?? Buffer.alloc(0));
    hash.update("\0");
  }
  return hash.digest("hex");
}
