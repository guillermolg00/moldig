/**
 * `state_5.sqlite`, the thread index Codex writes beside its rollouts: the only database this
 * adapter opens, and only for the columns ticket 06 §1 names. Nothing that came from a
 * conversation is ever selected (`title`, `preview`, `first_user_message` stay where they are),
 * the file is opened `?immutable=1` first so no `-wal`/`-shm` sidecar is ever created (D37), and
 * the foreign key `threads.thread_section_id` is never followed — the table it points at may not
 * exist at all (fixtures/codex README).
 */
import type { SqliteRow } from "../../scan/sqlite.js";
import { readSqlite } from "../../scan/sqlite.js";
import type { Warner } from "../../scan/sqlite.js";
import { toIso } from "../../scan/fs.js";
import { HARNESS } from "./model.js";

const THREADS_SQL =
  "SELECT id, cwd, rollout_path, created_at, created_at_ms, updated_at, updated_at_ms, " +
  "archived, cli_version FROM threads";
const PROJECT_ROOTS_SQL = "SELECT path FROM project_roots";

export interface ThreadRow {
  id: string;
  cwd: string;
  rolloutPath: string | null;
  /** Milliseconds, `created_at_ms` when the column carries one, else `created_at` × 1000. */
  createdMs: number | null;
  updatedMs: number | null;
  archived: boolean;
  /** `<redacted>` in the committed fixture: a value written by the harness, never a promise. */
  cliVersion: string | null;
}

export interface ThreadsRead {
  rows: ThreadRow[];
  /** `project_roots.path` values (empty on every machine observed so far, §1.3). */
  projectRoots: string[];
  /** `false` = the database could not be read; the `sqlite-unreadable` warning is already filed. */
  readable: boolean;
}

function text(row: SqliteRow, column: string): string | null {
  const value = row[column];
  return typeof value === "string" && value !== "" ? value : null;
}

function millis(row: SqliteRow, msColumn: string, secondsColumn: string): number | null {
  const ms = row[msColumn];
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) return ms;
  if (typeof ms === "bigint") return Number(ms);
  const seconds = row[secondsColumn];
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  if (typeof seconds === "bigint") return Number(seconds) * 1000;
  return null;
}

function rowOf(row: SqliteRow): ThreadRow | null {
  const id = text(row, "id");
  const cwd = text(row, "cwd");
  if (id === null || cwd === null) return null;
  const archived = row["archived"];
  return {
    id,
    cwd,
    rolloutPath: text(row, "rollout_path"),
    createdMs: millis(row, "created_at_ms", "created_at"),
    updatedMs: millis(row, "updated_at_ms", "updated_at"),
    archived: archived === 1 || archived === true || archived === 1n,
    cliVersion: text(row, "cli_version"),
  };
}

/** ISO 8601 of a millisecond stamp, `null` when the row carried none. */
export function stampOf(ms: number | null): string | null {
  return ms === null ? null : toIso(ms);
}

/**
 * The `threads` and `project_roots` rows of `state_5.sqlite`. One `sqlite-unreadable` warning per
 * file at most: `project_roots` is queried inside the same open, and a missing table there is not
 * a reason to lose the thread rows.
 */
export async function readThreads(file: string, ctx: Warner): Promise<ThreadsRead> {
  const result = await readSqlite(file, HARNESS, ctx, (db) => {
    const threads = db.all(THREADS_SQL);
    let roots: SqliteRow[] = [];
    try {
      roots = db.all(PROJECT_ROOTS_SQL);
    } catch {
      // A Codex old enough not to have the table: the thread index is still the answer.
      roots = [];
    }
    return { threads, roots };
  });
  if (result.value === null) return { rows: [], projectRoots: [], readable: false };
  const rows: ThreadRow[] = [];
  for (const row of result.value.threads) {
    const parsed = rowOf(row);
    if (parsed !== null) rows.push(parsed);
  }
  const projectRoots: string[] = [];
  for (const row of result.value.roots) {
    const path = text(row, "path");
    if (path !== null) projectRoots.push(path);
  }
  return { rows, projectRoots, readable: true };
}

/** D54: the `cli_version` of the newest row — a string the harness itself wrote to disk. */
export function versionOf(rows: readonly ThreadRow[]): string | null {
  const newest = rows.toSorted(
    (a, b) => (b.updatedMs ?? 0) - (a.updatedMs ?? 0) || a.id.localeCompare(b.id),
  )[0];
  return newest?.cliVersion ?? null;
}
