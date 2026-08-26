/**
 * The legacy JSON store `opencode.db` superseded (research 09 §1; research 10 §1): one
 * `<data>/storage/project/<id>.json` per project it knew, `{id, worktree, vcs?, time: {created,
 * updated, initialized?}, sandboxes}`. Only those files are opened — `storage/session/**` and
 * `storage/message/**` are transcripts and are never read beyond `stat` (07 §Never opened).
 */
import { join } from "node:path";
import { isRecord, listDir, readJsonObject } from "../../scan/fs.js";

export interface LegacyRecord {
  path: string;
  id: string;
  worktree: string;
  created: number | null;
  updated: number | null;
}

function stamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export async function readLegacyProjects(storageDir: string): Promise<LegacyRecord[]> {
  const dir = join(storageDir, "project");
  const files = (await listDir(dir))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const records = await Promise.all(
    files.map(async (entry) => {
      const path = join(dir, entry.name);
      const data = await readJsonObject(path);
      if (data === null) return null;
      const id = typeof data["id"] === "string" ? data["id"] : entry.name.replace(/\.json$/, "");
      const worktree = data["worktree"];
      if (typeof worktree !== "string" || worktree === "") return null;
      const time = isRecord(data["time"]) ? data["time"] : {};
      return {
        path,
        id,
        worktree,
        created: stamp(time["created"]),
        updated: stamp(time["updated"]),
      };
    }),
  );
  return records.filter((record): record is LegacyRecord => record !== null);
}
