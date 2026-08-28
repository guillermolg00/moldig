/** Recoverable SQLite edits used only by explicit orphan-Project deletion. */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import { assertPathIdentity } from "./files.js";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function quotedIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`unsafe SQLite identifier: ${value}`);
  return `"${value}"`;
}

/** SQLite's online backup includes committed WAL state and never creates sidecars by copying. */
export async function backupSqlite(
  path: string,
  to: string,
  expectedIdentity?: string | null,
): Promise<void> {
  await assertPathIdentity(path, expectedIdentity);
  await mkdir(dirname(to), { recursive: true });
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    // The handle is already open; this proves the path still names the file the Plan confirmed.
    await assertPathIdentity(path, expectedIdentity);
    await backup(database, to);
  } finally {
    database.close();
  }
}

/** One exact, parameterised row deletion; OpenCode Project rows keep their documented cascade. */
export async function deleteSqliteRows(
  file: string,
  table: string,
  keyColumn: string,
  keyValue: string,
  expectedIdentity?: string | null,
): Promise<number> {
  await assertPathIdentity(file, expectedIdentity);
  // OpenCode's project row owns its sessions; Codex schemas can reference optional absent tables.
  const database = new DatabaseSync(file, { enableForeignKeyConstraints: table === "project" });
  try {
    // Once opened, replacement of the path cannot redirect this transaction to another database.
    await assertPathIdentity(file, expectedIdentity);
    database.exec("PRAGMA busy_timeout = 2000");
    database.exec("BEGIN IMMEDIATE");
    const result = database
      .prepare(`DELETE FROM ${quotedIdentifier(table)} WHERE ${quotedIdentifier(keyColumn)} = ?`)
      .run(keyValue);
    database.exec("COMMIT");
    return Promise.resolve(Number(result.changes));
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // The transaction may not have started; preserve the original error.
    }
    return Promise.reject(error);
  } finally {
    database.close();
  }
}
