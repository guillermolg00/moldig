/**
 * The two content hashes of a skill directory, both in pure JavaScript (ADR-0001: moldig runs no
 * binary, so `git hash-object` and `git write-tree` are re-implemented rather than spawned).
 *
 * - `git-tree-sha1` is git's own tree object hash, so the 40-hex `skillFolderHash` a Vercel lock
 *   records can be compared byte for byte. Blob = `sha1("blob <len>\0" + bytes)`; tree =
 *   `sha1("tree <len>\0" + entries)` with entries `<mode> <name>\0<20-byte sha>` sorted by name,
 *   directories sorted as `name/`; modes `100644`, `100755` (executable bit), `120000` (symlink,
 *   whose blob is the link text) and `40000` (subtree). `.git/` is excluded, everything else is
 *   included, and an empty subtree is skipped — git cannot record a directory with no entries.
 * - `sha256-folder` is the folder digest ticket 06 §13 describes: every file below the directory,
 *   sorted by relative path, contributing `<relative path>\0<size>\0<bytes>`, skipping `.git/`
 *   and `node_modules/`, symlinks hashed by their link text, mode bits excluded.
 *
 * Mode bits are unavailable on win32, so `gitTreeSha1` is never asked for there (D44 leaves the
 * drift verdict `unknown` instead).
 */
import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { listDir, lstatOrNull } from "../../scan/fs.js";

/** Deep enough for any skill payload; the same bound `treeStats` uses. */
const MAX_DEPTH = 32;

const GIT_EXCLUDED = new Set([".git"]);
const FOLDER_EXCLUDED = new Set([".git", "node_modules"]);

/** The bytes git would store for a file: its contents, or the link text of a symlink. */
async function bytesOf(path: string, stats: Stats): Promise<Buffer | null> {
  try {
    return stats.isSymbolicLink()
      ? Buffer.from(await readlink(path), "utf8")
      : await readFile(path);
  } catch {
    return null;
  }
}

function blobSha(bytes: Buffer): Buffer {
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, "utf8"), bytes]))
    .digest();
}

interface TreeEntry {
  name: string;
  mode: string;
  sha: Buffer;
}

/** Git orders tree entries by raw bytes, with a directory's name read as `name/`. */
function sortKey(entry: TreeEntry): Buffer {
  return Buffer.from(entry.mode === "40000" ? `${entry.name}/` : entry.name, "utf8");
}

async function treeSha(dir: string, depth: number): Promise<Buffer | null> {
  if (depth > MAX_DEPTH) return null;
  const entries: TreeEntry[] = [];
  for (const child of await listDir(dir)) {
    if (GIT_EXCLUDED.has(child.name)) continue;
    const path = join(dir, child.name);
    // oxlint-disable-next-line no-await-in-loop -- one directory at a time keeps disk IO bounded
    const stats = await lstatOrNull(path);
    if (stats === null) continue;
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      // oxlint-disable-next-line no-await-in-loop -- see above
      const sub = await treeSha(path, depth + 1);
      // git cannot record an empty directory: a subtree with no entries is never written.
      if (sub !== null) entries.push({ name: child.name, mode: "40000", sha: sub });
      continue;
    }
    if (!stats.isFile() && !stats.isSymbolicLink()) continue;
    // oxlint-disable-next-line no-await-in-loop -- see above
    const bytes = await bytesOf(path, stats);
    if (bytes === null) continue;
    const mode = stats.isSymbolicLink()
      ? "120000"
      : (stats.mode & 0o111) === 0
        ? "100644"
        : "100755";
    entries.push({ name: child.name, mode, sha: blobSha(bytes) });
  }
  if (entries.length === 0) return null;
  const body = Buffer.concat(
    entries
      .toSorted((a, b) => Buffer.compare(sortKey(a), sortKey(b)))
      .map((entry) =>
        Buffer.concat([Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"), entry.sha]),
      ),
  );
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`tree ${body.length}\0`, "utf8"), body]))
    .digest();
}

/** The hash `git write-tree` would print for `dir`; `null` when it holds nothing git could store. */
export async function gitTreeSha1(dir: string): Promise<string | null> {
  const sha = await treeSha(dir, 0);
  return sha === null ? null : sha.toString("hex");
}

interface FolderFile {
  relativePath: string;
  bytes: Buffer;
}

async function folderFiles(
  dir: string,
  prefix: string,
  depth: number,
  out: FolderFile[],
): Promise<void> {
  if (depth > MAX_DEPTH) return;
  for (const child of await listDir(dir)) {
    if (FOLDER_EXCLUDED.has(child.name)) continue;
    const path = join(dir, child.name);
    const relativePath = prefix === "" ? child.name : `${prefix}/${child.name}`;
    // oxlint-disable-next-line no-await-in-loop -- one directory at a time keeps disk IO bounded
    const stats = await lstatOrNull(path);
    if (stats === null) continue;
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      // oxlint-disable-next-line no-await-in-loop -- see above
      await folderFiles(path, relativePath, depth + 1, out);
      continue;
    }
    if (!stats.isFile() && !stats.isSymbolicLink()) continue;
    // oxlint-disable-next-line no-await-in-loop -- see above
    const bytes = await bytesOf(path, stats);
    if (bytes !== null) out.push({ relativePath, bytes });
  }
}

/** SHA-256 over the directory's files; `null` when the directory holds no file at all. */
export async function sha256Folder(dir: string): Promise<string | null> {
  const files: FolderFile[] = [];
  await folderFiles(dir, "", 0, files);
  if (files.length === 0) return null;
  const hash = createHash("sha256");
  for (const file of files.toSorted((a, b) => (a.relativePath < b.relativePath ? -1 : 1))) {
    hash.update(Buffer.from(`${file.relativePath}\0${file.bytes.length}\0`, "utf8"));
    hash.update(file.bytes);
  }
  return hash.digest("hex");
}
