import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Warning } from "../index/types.js";
import { loadFixture, type FixtureTree } from "../testing/index.js";
import { readSqlite, sqliteRows, type Warner } from "./sqlite.js";

const trees: FixtureTree[] = [];
const temps: string[] = [];

afterEach(async () => {
  await Promise.all(trees.splice(0).map((tree) => tree.cleanup()));
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function collector(): { ctx: Warner; warnings: Warning[] } {
  const warnings: Warning[] = [];
  return { ctx: { warn: (warning) => warnings.push(warning) }, warnings };
}

async function listing(dir: string): Promise<string[]> {
  return (await readdir(dir)).toSorted();
}

describe("readSqlite (D37)", () => {
  it("reads a harness database `?immutable=1` and leaves the directory byte-for-byte alone", async () => {
    const tree = await loadFixture("codex/trust-and-state", { platform: "darwin" });
    trees.push(tree);
    const file = tree.path("home/.codex/state_5.sqlite");
    const before = await listing(tree.path("home/.codex"));
    const { ctx, warnings } = collector();

    const result = await readSqlite(file, "codex", ctx, (db) =>
      db.all("SELECT DISTINCT cwd FROM threads ORDER BY cwd"),
    );

    expect(result.mode).toBe("immutable");
    expect(result.value?.length).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
    // No copy, no `-wal`, no `-shm`: the tree is exactly what it was (ADR-0001).
    expect(await listing(tree.path("home/.codex"))).toEqual(before);
  });

  it("reads the OpenCode database the same way", async () => {
    const tree = await loadFixture("opencode/db-and-config", { platform: "darwin" });
    trees.push(tree);
    const dir = tree.path("home/.local/share/opencode");
    const before = await listing(dir);
    const { ctx, warnings } = collector();

    const rows = await sqliteRows(
      join(dir, "opencode.db"),
      "opencode",
      ctx,
      "SELECT worktree FROM project ORDER BY worktree",
    );

    expect(rows.length).toBeGreaterThan(0);
    expect(warnings).toEqual([]);
    expect(await listing(dir)).toEqual(before);
  });

  it("never creates the sidecars a plain read-only open would (the guarantee, proven)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "moldig-sqlite-"));
    temps.push(dir);
    const file = join(dir, "wal.db");
    const { DatabaseSync } = await import("node:sqlite");
    const writer = new DatabaseSync(file);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(a TEXT); INSERT INTO t VALUES('x');");
    writer.close();
    await rm(file + "-wal", { force: true });
    await rm(file + "-shm", { force: true });
    expect(await listing(dir)).toEqual(["wal.db"]);

    const { ctx } = collector();
    const result = await readSqlite(file, "opencode", ctx, (db) => db.all("SELECT a FROM t"));
    expect(result.mode).toBe("immutable");
    expect(await listing(dir)).toEqual(["wal.db"]);

    // The fallback, run deliberately, is what `?immutable=1` exists to avoid.
    const fallback = new DatabaseSync(pathToFileURL(file).href + "?mode=ro", { readOnly: true });
    fallback.prepare("SELECT a FROM t").all();
    fallback.close();
    expect(await listing(dir)).toEqual(["wal.db", "wal.db-shm", "wal.db-wal"]);
  });

  it("warns `sqlite-unreadable` once, naming the file and the harness, and returns null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "moldig-sqlite-"));
    temps.push(dir);
    const missing = join(dir, "not-there.db");
    const { ctx, warnings } = collector();

    const result = await readSqlite(missing, "cursor", ctx, (db) => db.all("SELECT 1"));

    expect(result).toEqual({ value: null, mode: null });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "sqlite-unreadable",
      harness: "cursor",
      path: missing,
      effect: "skipped",
    });
    expect(warnings[0]?.message).toContain(missing);
    // Nothing was created in its place.
    expect(await listing(dir)).toEqual([]);
  });

  it("gives `sqliteRows` an empty listing rather than a throw when the file cannot be read", async () => {
    const { ctx, warnings } = collector();
    const rows = await sqliteRows(join(tmpdir(), "moldig-absent.db"), null, ctx, "SELECT 1");
    expect(rows).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.harness).toBeNull();
  });
});
