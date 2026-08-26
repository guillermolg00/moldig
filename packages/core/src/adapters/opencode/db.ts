/**
 * `opencode.db`, read read-only (D37): the file opens `?immutable=1` first so no `-wal`/`-shm`
 * sidecar is ever created, and exactly the columns below are selected — never `session.title`,
 * `session.summary_*`, `session.directory` or any other column that could hold conversation
 * text or a breadcrumb v1 does not read (07 §Rules; 06 §1 rule 1). A file that cannot be read
 * yields one `sqlite-unreadable` warning (emitted by the shared helper) and an empty database.
 */
import { readSqlite, type SqliteRow } from "../../scan/sqlite.js";
import type { ScanContext } from "../../scan/context.js";
import { isFile } from "../../scan/fs.js";

export interface ProjectRow {
  id: string;
  worktree: string;
  timeCreated: number | null;
  timeUpdated: number | null;
}

export interface SessionRow {
  id: string;
  projectId: string;
  parentId: string | null;
  version: string | null;
  timeCreated: number | null;
  timeUpdated: number | null;
  timeArchived: number | null;
}

export interface OpenCodeDatabase {
  path: string;
  present: boolean;
  /** `<db>-wal` / `<db>-shm` when they already exist beside the file; never created. */
  sidecars: string[];
  readable: boolean;
  projects: ProjectRow[];
  sessions: SessionRow[];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function stamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function projectRow(row: SqliteRow): ProjectRow | null {
  const id = text(row["id"]);
  const worktree = text(row["worktree"]);
  if (id === null || worktree === null) return null;
  return {
    id,
    worktree,
    timeCreated: stamp(row["time_created"]),
    timeUpdated: stamp(row["time_updated"]),
  };
}

function sessionRow(row: SqliteRow): SessionRow | null {
  const id = text(row["id"]);
  const projectId = text(row["project_id"]);
  if (id === null || projectId === null) return null;
  return {
    id,
    projectId,
    parentId: text(row["parent_id"]),
    version: text(row["version"]),
    timeCreated: stamp(row["time_created"]),
    timeUpdated: stamp(row["time_updated"]),
    timeArchived: stamp(row["time_archived"]),
  };
}

const PROJECT_SQL = "SELECT id, worktree, time_created, time_updated FROM project";
const SESSION_SQL =
  "SELECT id, project_id, parent_id, version, time_created, time_updated, time_archived FROM session";

export async function readDatabase(path: string, ctx: ScanContext): Promise<OpenCodeDatabase> {
  const present = await isFile(path);
  const sidecars: string[] = [];
  for (const suffix of ["-wal", "-shm"]) {
    // oxlint-disable-next-line no-await-in-loop -- two stats, kept in the documented order
    if (await isFile(path + suffix)) sidecars.push(path + suffix);
  }
  const empty: OpenCodeDatabase = {
    path,
    present,
    sidecars,
    readable: false,
    projects: [],
    sessions: [],
  };
  if (!present) return { ...empty, readable: true };
  // One open, both queries: a second `readSqlite` would file a second warning for one file.
  const result = await readSqlite(path, "opencode", ctx, (db) => ({
    projects: db.all(PROJECT_SQL),
    sessions: db.all(SESSION_SQL),
  }));
  if (result.value === null) return empty;
  return {
    ...empty,
    readable: true,
    projects: result.value.projects
      .map((row) => projectRow(row))
      .filter((row): row is ProjectRow => row !== null),
    sessions: result.value.sessions
      .map((row) => sessionRow(row))
      .filter((row): row is SessionRow => row !== null),
  };
}

/** §0: `Harness.version` = the `version` of the newest `session` row (by `time_updated`). */
export function versionOf(database: OpenCodeDatabase): string | null {
  const newest = database.sessions.toSorted(
    (a, b) => (b.timeUpdated ?? 0) - (a.timeUpdated ?? 0) || a.id.localeCompare(b.id),
  )[0];
  return newest?.version ?? null;
}
