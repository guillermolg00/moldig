/**
 * The one way moldig reads a harness database (D37; ADR-0001): `node:sqlite`, read-only, opened
 * `?immutable=1` first so SQLite touches nothing at all — a WAL-flagged database opened `?mode=ro`
 * creates the `-wal` and `-shm` sidecars next to it, which a read-only scanner must never do.
 * `?mode=ro` is the fallback for the databases SQLite refuses to treat as immutable; a database
 * that opens neither way yields one `sqlite-unreadable` warning naming the file and the harness,
 * and the caller gets `null`. moldig never copies a database and never writes one.
 */
import { pathToFileURL } from "node:url";
import type { HarnessId } from "../index/types.js";
import type { ScanContext } from "./context.js";

/** All the helper needs from the scan context: somewhere to file a warning. */
export type Warner = Pick<ScanContext, "warn">;

/** The read side of `node:sqlite`'s `DatabaseSync`, which is all a scanner is allowed to use. */
export interface ReadOnlyDatabase {
  /** Every row of a query, as plain objects. */
  all(sql: string, ...params: readonly (string | number | null)[]): SqliteRow[];
}

/** One row: `node:sqlite` returns null-prototype objects of column values. */
export type SqliteRow = Record<string, unknown>;

export type SqliteOpenMode = "immutable" | "read-only";

export interface SqliteReadResult<T> {
  value: T | null;
  /** How the file opened; `null` when neither mode worked. */
  mode: SqliteOpenMode | null;
}

/** `file:` URI of a database plus the query SQLite reads its open flags from. */
function uriOf(file: string, mode: SqliteOpenMode): string {
  const query = mode === "immutable" ? "?immutable=1" : "?mode=ro";
  return pathToFileURL(file).href + query;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A row as a plain object: `node:sqlite` hands back null-prototype records of column values. */
function asRow(row: unknown): SqliteRow {
  const out: SqliteRow = {};
  if (typeof row !== "object" || row === null) return out;
  for (const [column, value] of Object.entries(row)) out[column] = value;
  return out;
}

/**
 * Opens `file` read-only and hands `read` a database that can only be queried. The callback runs
 * while the handle is open and must not keep it; whatever it returns is the result. `null` means
 * the file could not be opened either way (the warning has already been emitted) — never that the
 * query found nothing.
 */
export async function readSqlite<T>(
  file: string,
  harness: HarnessId | null,
  ctx: Warner,
  read: (db: ReadOnlyDatabase) => T,
): Promise<SqliteReadResult<T>> {
  const { DatabaseSync } = await import("node:sqlite");
  let lastError = "";
  for (const mode of ["immutable", "read-only"] as const) {
    // Only a failure to *open* falls back to the next mode; a query that throws is this file's
    // answer, and re-running it under the other flag would change nothing.
    const opened = ((): InstanceType<typeof DatabaseSync> | null => {
      try {
        return new DatabaseSync(uriOf(file, mode), { readOnly: true });
      } catch (error) {
        lastError = messageOf(error);
        return null;
      }
    })();
    if (opened === null) continue;
    try {
      const reader: ReadOnlyDatabase = {
        all: (sql, ...params) =>
          opened
            .prepare(sql)
            .all(...params)
            .map(asRow),
      };
      return { value: read(reader), mode };
    } catch (error) {
      lastError = messageOf(error);
      break;
    } finally {
      opened.close();
    }
  }
  ctx.warn({
    code: "sqlite-unreadable",
    message: `${file} could not be read read-only: ${lastError}`,
    harness,
    path: file,
    effect: "skipped",
  });
  return { value: null, mode: null };
}

/**
 * The rows of one query, `[]` when the database could not be opened (the `sqlite-unreadable`
 * warning is emitted once, by `readSqlite`). The shape most adapters need.
 */
export async function sqliteRows(
  file: string,
  harness: HarnessId | null,
  ctx: Warner,
  sql: string,
  ...params: readonly (string | number | null)[]
): Promise<SqliteRow[]> {
  const result = await readSqlite(file, harness, ctx, (db) => db.all(sql, ...params));
  return result.value ?? [];
}
