import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditIndex, Entity, EntityBase } from "../index/types.js";
import { MULTIPLIERS } from "../tokens/tokenizer.js";
import { apply } from "./apply.js";
import { dataDirFor } from "./data-dir.js";
import { plan } from "./plan.js";
import { summaryLines } from "./summary.js";
import type {
  ConfirmAnswer,
  Device,
  Executors,
  PlanGroup,
  RunManifest,
  Selection,
} from "./types.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");

let tree: string;
let home: string;
let repo: string;
let spawned: { argv: string[]; cwd: string | null }[];
let trashed: string[][];
let failing: Set<string>;

const MEMORY = `# Memory

- [topic-a.md](topic-a.md) — the fact that goes
- [topic-b.md](topic-b.md) — the fact that stays
`;

const MCP = `{
  // two servers
  "mcpServers": {
    "server-a": { "command": "node" },
    "server-b": { "command": "deno" }
  }
}
`;

function base(over: Partial<EntityBase> & Pick<EntityBase, "id" | "path">): EntityBase {
  return {
    harness: "claude-code",
    producer: null,
    project: null,
    scope: "user",
    ownership: "harness",
    shared: null,
    gitStatus: null,
    relativePath: null,
    locator: { type: "file", path: over.path },
    format: "md",
    label: basename(over.path),
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    kind: "harness-cache",
    metrics: {
      bytes: 100,
      files: 1,
      lines: null,
      mtime: null,
      ageDays: 45,
      tokens: null,
      lastUsed: null,
    },
    ...over,
  };
}

function cacheUnit(over: Partial<EntityBase> & Pick<EntityBase, "id" | "path">): Entity {
  return {
    ...base(over),
    kind: "harness-cache",
    cacheKind: "transcript",
    unit: "session",
    surface: "cli",
    session: null,
    slug: null,
    rule: "swept",
    retention: { days: 20, bytes: null, count: null, source: "cleanupPeriodDays" },
    liveGuard: { kind: "pid", alive: false },
    userContent: false,
    members: { files: 1, bytes: 100, oldest: null, newest: null },
  };
}

function index(rows: Entity[]): AuditIndex {
  return {
    schemaVersion: 0,
    generatedAt: NOW.toISOString(),
    moldig: { version: "0.0.0" },
    scan: {
      home,
      roots: [repo],
      cwd: repo,
      platform: "darwin",
      caseFold: true,
      env: {},
      git: { available: false, version: null },
      durationMs: 0,
    },
    tokenizer: {
      name: "gpt-tokenizer",
      version: "0",
      encoding: "o200k_base",
      fallbackUsed: false,
      multipliers: MULTIPLIERS,
    },
    harnesses: [],
    projects: [],
    breadcrumbs: [],
    entities: rows,
    edges: [],
    warnings: [],
    totals: {
      entities: rows.length,
      files: 0,
      bytes: 0,
      harnessCacheBytes: 0,
      memoryBytes: 0,
      tokens: 0,
    },
    findings: [],
    headline: {
      scope: "user-controllable",
      focus: { project: null, reason: "none" },
      perHarness: [],
    },
  };
}

async function statPath(path: string): ReturnType<Executors["stat"]> {
  try {
    const found = await lstat(path, { bigint: true });
    return {
      exists: true,
      bytes: Number(found.size),
      identity: [found.dev, found.ino, found.size, found.mtimeNs, found.ctimeNs].join(":"),
    };
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code === "ENOENT" ? { exists: false, bytes: 0, identity: null } : null;
  }
}

/** The fake trash renames into `<tree>/.trash/<n>/` and records the call (spec 08 §10). */
function executors(): Executors {
  return {
    trash: async (paths) => {
      trashed.push(paths);
      const bin = join(tree, ".trash", String(trashed.length));
      await mkdir(bin, { recursive: true });
      const left: string[] = [];
      const moved: string[] = [];
      for (const path of paths) {
        if (failing.has(path)) {
          left.push(path);
          continue;
        }
        // oxlint-disable-next-line no-await-in-loop -- the fake trash moves one path at a time
        await rename(path, join(bin, basename(path)));
        moved.push(path);
      }
      return { moved, left, error: left.length > 0 ? "the helper refused a path" : null };
    },
    backup: async (path, to) => {
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, await readFile(path));
    },
    backupSqlite: async (path, to) => {
      await mkdir(dirname(to), { recursive: true });
      await writeFile(to, await readFile(path));
    },
    deleteSqliteRows: () => Promise.resolve(1),
    writeFile: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text);
    },
    spawn: (command) => {
      spawned.push(command);
      return Promise.resolve({ exitCode: command.argv.includes("boom") ? 3 : 0, stderr: "" });
    },
    readFile: (path) =>
      readFile(path, "utf8").then(
        (text) => text,
        () => null,
      ),
    stat: statPath,
    now: () => NOW,
  };
}

function deviceOf(path: string): Device {
  return path.includes("shell-snapshots") ? { dev: 9, kind: "network" } : { dev: 1, kind: "local" };
}

beforeEach(async () => {
  tree = await mkdtemp(join(tmpdir(), "moldig-apply-"));
  home = join(tree, "home");
  repo = join(tree, "repo");
  spawned = [];
  trashed = [];
  failing = new Set();
  await mkdir(join(home, ".claude/projects/slug/memory"), { recursive: true });
  await mkdir(join(home, ".claude/shell-snapshots"), { recursive: true });
  await mkdir(repo, { recursive: true });
  await writeFile(join(home, ".claude/projects/slug/memory/MEMORY.md"), MEMORY);
  await writeFile(join(home, ".claude/projects/slug/memory/topic-a.md"), "a fact\n");
  await writeFile(join(home, ".claude/projects/slug/session.jsonl"), "{}\n");
  await writeFile(join(home, ".claude/shell-snapshots/snap.sh"), "echo\n");
  await writeFile(join(repo, ".mcp.json"), MCP);
});

afterEach(async () => {
  await rm(tree, { recursive: true, force: true });
});

function entities(): Entity[] {
  const memoryUnit = join(home, ".claude/projects/slug/memory");
  return [
    cacheUnit({ id: "cache:session", path: join(home, ".claude/projects/slug/session.jsonl") }),
    cacheUnit({
      id: "cache:snap",
      path: join(home, ".claude/shell-snapshots/snap.sh"),
      metrics: { ...base({ id: "x", path: "y" }).metrics, bytes: 50 },
    }),
    {
      ...base({ id: "memory:fact", path: join(memoryUnit, "topic-a.md") }),
      kind: "memory-file",
      role: "fact",
      unit: memoryUnit,
      owner: "project",
      frontmatter: {},
      loadedPortion: null,
      reads: null,
      writes: null,
      neverRead: null,
      readSignal: { source: "none", exact: false, bashParsed: false },
    },
    {
      ...base({ id: "memory:index", path: join(memoryUnit, "MEMORY.md") }),
      kind: "memory-file",
      role: "index",
      unit: memoryUnit,
      owner: "project",
      frontmatter: {},
      loadedPortion: null,
      reads: null,
      writes: null,
      neverRead: null,
      readSignal: { source: "none", exact: false, bashParsed: false },
    },
    {
      ...base({
        id: "mcp:entry",
        path: join(repo, ".mcp.json"),
        ownership: "human",
        locator: {
          type: "entry",
          file: join(repo, ".mcp.json"),
          format: "jsonc",
          keyPath: ["mcpServers", "server-a"],
        },
        removal: { method: "backup-edit" },
        format: "json",
      }),
      kind: "mcp-server",
      name: "server-a",
      transport: "stdio",
      command: "node",
      args: [],
      url: null,
      envKeys: [],
      headerKeys: [],
      secretKeys: [],
      hasOauth: false,
      usesInterpolation: false,
      enabled: true,
      approval: "unknown",
      invalid: null,
      endpointKey: "node",
      rawKeys: ["command"],
    },
    {
      ...base({
        id: "mcp:delegated",
        path: join(home, ".claude.json"),
        ownership: "human",
        locator: {
          type: "entry",
          file: join(home, ".claude.json"),
          format: "json",
          keyPath: ["mcpServers", "server-c"],
        },
        removal: { method: "delegate", command: "claude mcp remove server-c -s user" },
        format: "json",
      }),
      kind: "mcp-server",
      name: "server-c",
      transport: "stdio",
      command: "node",
      args: [],
      url: null,
      envKeys: [],
      headerKeys: [],
      secretKeys: [],
      hasOauth: false,
      usesInterpolation: false,
      enabled: true,
      approval: "unknown",
      invalid: null,
      endpointKey: "node-c",
      rawKeys: ["command"],
    },
  ];
}

const SELECTION: Selection = [
  { action: "clean", id: "cache:session" },
  { action: "clean", id: "cache:snap" },
  { action: "clean", id: "memory:fact" },
  { action: "delete", id: "mcp:entry" },
  { action: "delete", id: "mcp:delegated" },
];

function planned(selection: Selection = SELECTION): ReturnType<typeof plan> {
  return plan(index(entities()), selection, {
    home,
    platform: "darwin",
    dataDir: dataDirFor({ platform: "darwin", env: {}, home }),
    now: NOW,
    moldig: { version: "0.0.0" },
    command: "clean",
    deviceOf,
  });
}

function statusOf(manifest: RunManifest, key: string): string {
  const row = manifest.rows.find((item) => item.target.key === key);
  if (row === undefined) throw new Error(`no row for ${key}`);
  return row.result.status;
}

describe("apply() over a temp tree with fake executors", () => {
  it("moves, edits, delegates and records every row in the manifest", async () => {
    const manifest = await apply(planned(), executors());

    expect(existsSync(join(home, ".claude/projects/slug/session.jsonl"))).toBe(false);
    expect(existsSync(join(home, ".claude/projects/slug/memory/topic-a.md"))).toBe(false);
    expect(existsSync(join(home, ".claude/shell-snapshots/snap.sh"))).toBe(true);
    expect(trashed.flat()).not.toContain(join(home, ".claude/shell-snapshots/snap.sh"));

    // The fact moved and the index lost exactly the line that linked it (08 §2).
    const rewritten = await readFile(join(home, ".claude/projects/slug/memory/MEMORY.md"), "utf8");
    expect(rewritten).toBe("# Memory\n\n- [topic-b.md](topic-b.md) — the fact that stays\n");

    // The entry is gone and the comment around it is not (14 §1).
    const edited = await readFile(join(repo, ".mcp.json"), "utf8");
    expect(edited).toContain("// two servers");
    expect(edited).not.toContain("server-a");
    expect(edited).toContain("server-b");

    expect(spawned).toEqual([
      { argv: ["claude", "mcp", "remove", "server-c", "-s", "user"], cwd: home },
    ]);

    expect(statusOf(manifest, "cache:session")).toBe("moved");
    expect(statusOf(manifest, "memory:fact")).toBe("moved");
    expect(statusOf(manifest, "mcp:entry")).toBe("edited");
    expect(statusOf(manifest, "mcp:delegated")).toBe("delegated");
    expect(statusOf(manifest, "cache:snap")).toBe("refused");
    expect(manifest.rows.every((row) => row.result.at !== null)).toBe(true);
    expect(manifest.run.finishedAt).toBe(NOW.toISOString());
    expect(manifest.mode).toBe("run");
  });

  it("keeps the pre-edit bytes in the run's backup directory", async () => {
    const document = planned();
    await apply(document, executors());
    const backups = document.groups
      .flatMap((group) => group.rows)
      .flatMap((row) => row.backups.map((item) => item.to));
    expect(backups).toHaveLength(2);
    for (const path of backups) expect(path.startsWith(document.backupDir)).toBe(true);
    const saved = await Promise.all(backups.map((path) => readFile(path, "utf8")));
    expect(saved).toContain(MEMORY);
    expect(saved).toContain(MCP);
  });

  it("keeps the first backup when several selected entries share one settings file", async () => {
    const file = join(repo, ".mcp.json");
    const document = planned([
      {
        action: "delete",
        locator: {
          type: "entry",
          file,
          format: "jsonc",
          keyPath: ["mcpServers", "server-a"],
        },
      },
      {
        action: "delete",
        locator: {
          type: "entry",
          file,
          format: "jsonc",
          keyPath: ["mcpServers", "server-b"],
        },
      },
    ]);
    await apply(document, executors());
    const backup = document.groups[0]?.rows[0]?.backups[0]?.to;
    expect(backup).toBeDefined();
    expect(await readFile(backup ?? "", "utf8")).toBe(MCP);
    expect(await readFile(file, "utf8")).not.toContain("server-a");
    expect(await readFile(file, "utf8")).not.toContain("server-b");
  });

  it("writes the manifest after every group and rewrites it at the end (D91)", async () => {
    const document = planned();
    const manifest = await apply(document, executors());
    const written: RunManifest = JSON.parse(await readFile(document.manifestPath, "utf8"));
    expect(written).toEqual(manifest);
    expect(written.manifestPath).toBe(document.manifestPath);
    expect(written.groups.map((group) => [group.action, group.status])).toEqual([
      ["clean", "ran"],
      ["delete", "ran"],
    ]);
    expect(written.groups[0]?.summary.moved).toBe(2);
    expect(written.groups[0]?.summary.refused).toBe(1);
    expect(written.selection).toHaveLength(5);
  });

  it("a failing row never aborts its group nor the run", async () => {
    failing.add(join(home, ".claude/projects/slug/session.jsonl"));
    const manifest = await apply(planned(), executors());
    expect(statusOf(manifest, "cache:session")).toBe("failed");
    const failed = manifest.rows.find((row) => row.target.key === "cache:session");
    expect(failed?.result.reason).toContain("still in place");
    // Every later row of the same group and of the next group still ran.
    expect(statusOf(manifest, "memory:fact")).toBe("moved");
    expect(statusOf(manifest, "mcp:entry")).toBe("edited");
    expect(statusOf(manifest, "mcp:delegated")).toBe("delegated");
  });

  it("refuses a path that changes after the confirmation snapshot", async () => {
    const target = join(home, ".claude/projects/slug/session.jsonl");
    const manifest = await apply(planned([{ action: "clean", id: "cache:session" }]), executors(), {
      confirm: async () => {
        await writeFile(target, "replacement with different bytes\n");
        return "run";
      },
    });

    expect(statusOf(manifest, "cache:session")).toBe("failed");
    expect(manifest.rows[0]?.result.reason).toContain("changed after confirmation");
    expect(await readFile(target, "utf8")).toBe("replacement with different bytes\n");
    expect(trashed).toEqual([]);
  });

  it("reports the exit code and the last line of stderr of a failed delegate (D92)", async () => {
    const document = planned([{ action: "delete", id: "mcp:delegated" }]);
    const row = document.groups[0]?.rows[0];
    if (row === undefined) throw new Error("no delegate row");
    row.disposition.argv = ["claude", "boom"];
    const manifest = await apply(document, {
      ...executors(),
      spawn: (command) => {
        spawned.push(command);
        return Promise.resolve({ exitCode: 3, stderr: "first line\ncommand not found: claude" });
      },
    });
    expect(statusOf(manifest, "mcp:delegated")).toBe("failed");
    expect(manifest.rows[0]?.result.reason).toBe("exit 3: command not found: claude");
    expect(manifest.rows[0]?.result.exitCode).toBe(3);
  });

  it("redacts credentials from failed delegate stderr before writing the manifest", async () => {
    const document = planned([{ action: "delete", id: "mcp:delegated" }]);
    const row = document.groups[0]?.rows[0];
    if (row === undefined) throw new Error("no delegate row");
    row.disposition.argv = ["claude", "boom"];
    const bareToken = "A".repeat(32);
    const manifest = await apply(document, {
      ...executors(),
      spawn: () =>
        Promise.resolve({
          exitCode: 3,
          stderr: `request failed: https://user:secret-token@example.test/private ${bareToken}`,
        }),
    });
    const reason = manifest.rows[0]?.result.reason ?? "";
    expect(reason).toBe(
      "exit 3: request failed: https://<redacted>@example.test/private <redacted>",
    );
    expect(JSON.stringify(manifest)).not.toContain("secret-token");
    expect(JSON.stringify(manifest)).not.toContain(bareToken);
  });

  it("never spawns a delegate whose group was skipped", async () => {
    const answers: Record<string, ConfirmAnswer> = { clean: "run", delete: "skip" };
    const manifest = await apply(planned(), executors(), {
      confirm: (group: PlanGroup) => Promise.resolve(answers[group.action] ?? "run"),
    });
    expect(spawned).toEqual([]);
    expect(statusOf(manifest, "mcp:delegated")).toBe("planned");
    expect(statusOf(manifest, "cache:session")).toBe("moved");
    expect(manifest.groups.map((group) => group.status)).toEqual(["ran", "skipped"]);
    expect(manifest.groups[1]?.confirmation.answer).toBe("skip");
    // The entry file was not touched either.
    expect(await readFile(join(repo, ".mcp.json"), "utf8")).toBe(MCP);
  });

  it("esc skips every remaining group", async () => {
    const manifest = await apply(planned(), executors(), {
      confirm: () => Promise.resolve("skip-rest"),
    });
    expect(trashed).toEqual([]);
    expect(spawned).toEqual([]);
    expect(manifest.groups.every((group) => group.status === "skipped")).toBe(true);
    expect(manifest.groups.map((group) => group.confirmation.answer)).toEqual([
      "skip-rest",
      "skip-rest",
    ]);
  });

  it("hands every selected Project's on-disk state to the trash in one call", async () => {
    const first = join(home, "project-one-state");
    const second = join(home, "project-two-state");
    await writeFile(first, "one");
    await writeFile(second, "two");
    const document = planned([
      {
        action: "delete",
        locator: { type: "file", path: first },
        label: "project one",
        kind: "project-state",
        project: "project:one",
      },
      {
        action: "delete",
        locator: { type: "file", path: second },
        label: "project two",
        kind: "project-state",
        project: "project:two",
      },
    ]);
    const manifest = await apply(document, executors());
    expect(trashed).toEqual([[first, second]]);
    expect(manifest.rows.map((row) => row.result.status)).toEqual(["moved", "moved"]);
  });

  it("reports the current row before it starts and after it settles", async () => {
    const events: {
      action: string;
      completed: number;
      total: number;
      label: string;
      status: string | null;
    }[] = [];
    await apply(planned([{ action: "clean", id: "cache:session" }]), executors(), {
      onProgress: (event) => events.push(event),
    });
    expect(events).toEqual([
      { action: "clean", completed: 0, total: 1, label: "session.jsonl", status: null },
      { action: "clean", completed: 1, total: 1, label: "session.jsonl", status: "moved" },
    ]);
  });

  it("a dry run touches nothing and leaves every row planned (D115)", async () => {
    const document = planned();
    const manifest = await apply(document, executors(), { mode: "dry-run" });
    expect(manifest.mode).toBe("dry-run");
    expect(manifest.rows.every((row) => row.result.status === "planned")).toBe(true);
    expect(existsSync(document.manifestPath)).toBe(false);
    expect(trashed).toEqual([]);
    expect(spawned).toEqual([]);
    expect(summaryLines(manifest)[0]).toContain("Nothing moved (preview): 5 rows selected");
  });

  it("summarises the run in the words of ticket 08 §4", async () => {
    const manifest = await apply(planned(), executors());
    const lines = summaryLines(manifest, { harnessNames: { "claude-code": "Claude Code" } });
    expect(lines[0]).toMatch(/^Freed /u);
    expect(lines[1]).toBe("Rows: 2 moved · 1 edited · 1 delegated · 1 refused · 0 failed");
    expect(lines).toContain(`Manifest: ${manifest.manifestPath}`);
    expect(lines.filter((line) => line.startsWith("Backup: "))).toHaveLength(2);
    expect(lines.at(-1)).toBe(
      'recovery: OS trash "Put Back" + the backup paths in the manifest (no restore command in v1)',
    );
  });
});
