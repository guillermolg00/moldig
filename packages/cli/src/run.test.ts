import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, sep } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadFixture, normaliseSnapshot, treePaths, type FixtureTree } from "@moldig/core/testing";
import { createFakeExecutors, type FakeExecutors } from "./executors/fake.js";
import { runCli, type Io } from "./run.js";
import type { OpenTui, TuiRequest } from "./tui/index.js";

/** Ticket 26's TUI behind its port: `runCli` only has to decide whether to open it. */
function fakeTui(seen: TuiRequest[]): OpenTui {
  return (request) => {
    seen.push(request);
    return Promise.resolve({ summary: "summary from the TUI\n", failedRows: 0 });
  };
}

/** The same clock the core snapshots use, so the fixture's `ages` land on the same day grid. */
const NOW = new Date("2026-08-26T12:00:00.000Z");
/** Pinned so one snapshot holds on macOS, Linux and Windows alike (D100). */
const PLATFORM = "darwin";
// oxlint-disable-next-line no-control-regex -- an escape sequence is exactly what is looked for
const ESCAPES = /\u001B\[/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** stdout parsed as a JSON object, with no assertion from `any`. */
function jsonOf(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error("expected a JSON object on stdout");
  return parsed;
}

function findingsOf(text: string): Record<string, unknown>[] {
  const findings: unknown = jsonOf(text)["findings"];
  if (!Array.isArray(findings)) throw new Error("expected findings[] on stdout");
  const items: unknown[] = findings;
  return items.filter(isRecord);
}

let tree: FixtureTree;

interface Run {
  code: number;
  out: string;
  err: string;
}

async function run(argv: readonly string[], overrides: Partial<Io> = {}): Promise<Run> {
  let out = "";
  let err = "";
  const io: Io = {
    stdout: (chunk) => {
      out += chunk;
    },
    stderr: (chunk) => {
      err += chunk;
    },
    isTTY: false,
    columns: 80,
    env: { NO_COLOR: "1" },
    cwd: tree.cwd,
    home: tree.home,
    platform: PLATFORM,
    now: NOW,
    ...overrides,
  };
  const code = await runCli(argv, io);
  return { code, out, err };
}

/** moldig's own data directory for a run over `on`: inside the fixture, never a real one. */
function dataDirOf(on: FixtureTree): string {
  return join(on.dir, "data", "moldig");
}

interface CleanRun extends Run {
  readonly fake: FakeExecutors;
  readonly manifest: Record<string, unknown> | null;
}

/**
 * A whole `clean` over its own fixture tree with the executors injected (08 §9): the trash is a
 * rename inside the tree, no process is ever spawned, and the manifest lands in the tree too.
 */
async function clean(
  argv: readonly string[],
  on: FixtureTree,
  options: { failing?: readonly string[]; exitCode?: number; move?: boolean } = {},
): Promise<CleanRun> {
  const fake = createFakeExecutors({ trashDir: join(on.dir, "fake-trash"), now: NOW, ...options });
  const result = await run([...argv, on.root], {
    cwd: on.cwd,
    home: on.home,
    env: { NO_COLOR: "1", XDG_DATA_HOME: join(on.dir, "data") },
    executors: fake.executors,
  });
  const runs = join(dataDirOf(on), "runs");
  const written = existsSync(runs) ? await readdir(runs) : [];
  const first = written[0];
  const manifest = first === undefined ? null : jsonOf(await readFile(join(runs, first), "utf8"));
  return { ...result, fake, manifest };
}

/** Every file under a directory, recursively: what a run must have left in place. */
async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted((a, b) => a.localeCompare(b));
}

beforeAll(async () => {
  tree = await loadFixture("claude-code/breadcrumbs", {
    cwd: "root/project-a",
    now: NOW,
    platform: PLATFORM,
  });
});

afterAll(async () => {
  await tree.cleanup();
});

describe("moldig scan", () => {
  it("prints the Harness, a Project and the totals, and exits 0", async () => {
    const { code, out } = await run(["scan", "--no-git", tree.root]);
    expect(code).toBe(0);
    expect(out).toContain("Claude Code");
    expect(out).toContain("installed");
    expect(out).toContain("project-a");
    expect(out).toContain("Totals");
    expect(out).toContain("tokens on disk");
    expect(out).toContain("1 Project present · 1 gone · 0 unreachable");
  });

  it("prints index v0 with --json and nothing else on stdout", async () => {
    const { code, out } = await run(["scan", "--no-git", "--json", tree.root]);
    expect(code).toBe(0);
    expect(jsonOf(out)).toMatchObject({ schemaVersion: 0, scan: { platform: PLATFORM } });
    expect(out.trimEnd()).not.toContain("\n"); // compact: one line
    expect(out).not.toMatch(ESCAPES);
  });

  it("--pretty indents and implies --json", async () => {
    const { code, out } = await run(["scan", "--no-git", "--pretty", tree.root]);
    expect(code).toBe(0);
    expect(out).toContain('\n  "schemaVersion": 0,');
    expect(jsonOf(out)).toMatchObject({ schemaVersion: 0 });
  });

  it("matches the summary snapshot at 80 columns", async () => {
    const { out } = await run(["scan", "--no-git", tree.root]);
    await expect(normaliseSnapshot(out, tree)).toMatchFileSnapshot("./__snapshots__/scan.txt");
  });
});

describe("moldig audit", () => {
  it("prints the Headline number, the eight Categories and the Findings", async () => {
    const { code, out } = await run(["audit", "--no-git", tree.root]);
    expect(code).toBe(1); // Findings at or above the default --fail-on low
    expect(out).toContain("Headline number");
    expect(out).toContain("every session pays");
    expect(out).toContain("tokens/session");
    for (const category of [
      "duplicate",
      "orphan",
      "bloat",
      "drift",
      "shadow memory",
      "autogenerated",
      "harness cache",
      "exposure",
    ]) {
      expect(out).toContain(category);
    }
    expect(out).toContain("Findings");
  });

  it("matches the audit snapshot at 80 columns", async () => {
    const { out } = await run(["audit", "--no-git", tree.root]);
    await expect(normaliseSnapshot(out, tree)).toMatchFileSnapshot("./__snapshots__/audit.txt");
  });

  it("prints the AuditIndex with --json", async () => {
    const { code, out } = await run(["audit", "--no-git", "--json", tree.root]);
    expect(code).toBe(1);
    expect(jsonOf(out)).toMatchObject({
      schemaVersion: 0,
      headline: { scope: "user-controllable" },
    });
    expect(findingsOf(out).length).toBeGreaterThan(0);
  });

  it("--fail-on decides the exit code", async () => {
    const [low, medium, high, never] = await Promise.all([
      run(["audit", "--no-git", tree.root]),
      run(["audit", "--no-git", "--fail-on", "medium", tree.root]),
      run(["audit", "--no-git", "--fail-on", "high", tree.root]),
      run(["audit", "--no-git", "--fail-on", "never", tree.root]),
    ]);
    expect([low?.code, medium?.code, high?.code, never?.code]).toEqual([1, 1, 0, 0]);
  });

  it("--category and --severity filter the table, findings[] and --fail-on (D15)", async () => {
    const only = await run(["audit", "--no-git", "--category", "orphan", "--json", tree.root]);
    expect(findingsOf(only.out).map((finding) => finding["category"])).toEqual(["orphan"]);
    expect(jsonOf(only.out)["headline"]).not.toBeUndefined(); // the headline is never filtered
    expect(only.code).toBe(1);

    const high = await run(["audit", "--no-git", "--severity", "high", "--json", tree.root]);
    expect(findingsOf(high.out)).toEqual([]);
    expect(high.code).toBe(0);

    const table = await run(["audit", "--no-git", "--category", "orphan", tree.root]);
    expect(table.out).toContain("orphan");
    expect(table.out).not.toContain("kept under Claude Code's user scope");
  });

  it("--no-read-signal adds the read-signal-skipped Warning on stderr", async () => {
    const { err } = await run(["audit", "--no-git", "--no-read-signal", tree.root]);
    expect(err).toContain("warning read-signal-skipped: memory read signal not computed");
  });
});

describe("moldig without a command", () => {
  it("prints the audit table and the shareable summary in a pipe, and exits 0 (D5, D132)", async () => {
    const { code, out } = await run(["--no-git", tree.root]);
    expect(code).toBe(0);
    expect(out).toContain("Headline number");
    expect(out).toContain("moldig — project-a (cwd)");
    expect(out).toContain("Nothing moved (preview):");
    expect(out).toContain("Clean: 3 rows");
    expect(out).not.toContain("ticket 26");
  });

  it("opens the TUI on the scan screen in a terminal and prints the summary it hands back", async () => {
    const seen: TuiRequest[] = [];
    const { code, out } = await run(["--no-git", tree.root], {
      isTTY: true,
      stdinIsTTY: true,
      openTui: fakeTui(seen),
    });
    expect(code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.initialRoute).toBeUndefined(); // the TUI's own default: the Scan screen
    expect(seen[0]?.index.headline.focus.reason).toBe("cwd");
    expect(out).toBe("\nsummary from the TUI\n");
  });

  it("stays on the printed path without a terminal on stdin", async () => {
    const seen: TuiRequest[] = [];
    const { out } = await run(["--no-git", tree.root], { isTTY: true, openTui: fakeTui(seen) });
    expect(seen).toHaveLength(0);
    expect(out).toContain("Headline number");
  });

  it("--json never opens the TUI (D14)", async () => {
    const seen: TuiRequest[] = [];
    const { code, out } = await run(["--no-git", "--json", tree.root], {
      isTTY: true,
      stdinIsTTY: true,
      openTui: fakeTui(seen),
    });
    expect(code).toBe(0);
    expect(seen).toHaveLength(0);
    expect(jsonOf(out)).toMatchObject({ headline: { scope: "user-controllable" } });
  });

  it("a failed row in the TUI's run exits 1 (D17)", async () => {
    const { code } = await run(["--no-git", tree.root], {
      isTTY: true,
      stdinIsTTY: true,
      openTui: () => Promise.resolve({ summary: "s\n", failedRows: 2 }),
    });
    expect(code).toBe(1);
  });

  it("--json is audit --json (D14)", async () => {
    const { code, out } = await run(["--no-git", "--json", tree.root]);
    expect(code).toBe(0);
    expect(findingsOf(out).length).toBeGreaterThan(0);
    expect(jsonOf(out)).toMatchObject({ headline: { scope: "user-controllable" } });
  });
});

describe("moldig clean refuses rather than guesses", () => {
  it("refuses without a terminal and without --yes, and says so (D124)", async () => {
    const { code, out, err } = await run(["clean", tree.root]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("no terminal to confirm in");
    expect(err).toContain("--yes and a filter");
  });

  it("refuses --yes without a filter (D124)", async () => {
    const { code, err } = await run(["clean", "--yes", tree.root]);
    expect(code).toBe(2);
    expect(err).toContain("--yes needs a filter as well");
  });

  it("refuses a Category an unattended clean cannot reach (D16)", async () => {
    const { code, err } = await run(["clean", "--yes", "--category", "bloat", tree.root]);
    expect(code).toBe(2);
    expect(err).toContain("harness-cache only");
  });

  it("refuses when only stdout is a terminal, filter or not (D4)", async () => {
    const { code, err } = await run(["clean", "--category", "harness-cache", tree.root], {
      isTTY: true,
    });
    expect(code).toBe(2);
    expect(err).toContain("no terminal to confirm in");
  });

  it("refuses with --json in a terminal: a document is no place to confirm in", async () => {
    const seen: TuiRequest[] = [];
    const { code, err } = await run(["clean", "--json", tree.root], {
      isTTY: true,
      stdinIsTTY: true,
      openTui: fakeTui(seen),
    });
    expect(code).toBe(2);
    expect(seen).toHaveLength(0);
    expect(err).toContain("no terminal to confirm in");
  });

  it("opens the TUI on the selection panel in a terminal with a real Runner (D4)", async () => {
    const seen: TuiRequest[] = [];
    const { code, out } = await run(["clean", tree.root], {
      isTTY: true,
      stdinIsTTY: true,
      openTui: fakeTui(seen),
    });
    expect(code).toBe(0);
    expect(seen[0]?.initialRoute).toEqual({ screen: "selection" });
    expect(typeof seen[0]?.runner.plan).toBe("function");
    expect(out).toBe("\nsummary from the TUI\n");
  });
});

describe("moldig clean --dry-run", () => {
  it("prints the plan document with --json and writes nothing (D115)", async () => {
    const { code, out, fake, manifest } = await clean(["clean", "--dry-run", "--json"], tree);
    expect(code).toBe(0);
    const document = jsonOf(out);
    expect(document).toMatchObject({ schemaVersion: 0, mode: "dry-run" });
    const rows = document["rows"];
    if (!Array.isArray(rows)) throw new Error("expected rows[] in the plan document");
    expect(rows.length).toBe(3);
    for (const row of rows.filter(isRecord)) {
      expect(row["result"]).toMatchObject({ status: "planned" });
    }
    // Nothing at all: no manifest, no backup, no executor call.
    expect(manifest).toBeNull();
    expect(existsSync(dataDirOf(tree))).toBe(false);
    expect(fake.trashed).toEqual([]);
    expect(fake.written).toEqual([]);
    expect(out).not.toMatch(ESCAPES);
  });

  it("prints the human preview and says nothing moved", async () => {
    const { code, out, fake } = await clean(["clean", "--dry-run"], tree);
    expect(code).toBe(0);
    expect(out).toContain("Clean (3)");
    expect(out).toContain("→ Trash");
    expect(out).toContain("Nothing moved (preview): 3 rows selected");
    expect(out).toContain("dry run: nothing was moved");
    expect(fake.trashed).toEqual([]);
    expect(existsSync(dataDirOf(tree))).toBe(false);
  });

  it("needs neither --yes nor a filter, and the filters only narrow (D16)", async () => {
    const narrowed = await clean(["clean", "--dry-run", "--json", "--older-than", "1000"], tree);
    expect(narrowed.code).toBe(0);
    expect(jsonOf(narrowed.out)["rows"]).toEqual([]);

    const harness = await clean(["clean", "--dry-run", "--json", "--harness", "codex"], tree);
    expect(jsonOf(harness.out)["rows"]).toEqual([]);
  });
});

describe("moldig clean --yes", () => {
  let own: FixtureTree;

  beforeEach(async () => {
    own = await loadFixture("claude-code/breadcrumbs", {
      cwd: "root/project-a",
      now: NOW,
      platform: PLATFORM,
    });
  });

  afterEach(async () => {
    await own.cleanup();
  });

  it("trashes only the preselected units, writes the manifest and prints the summary", async () => {
    const before = await filesUnder(own.home);
    const { code, out, fake, manifest } = await clean(
      ["clean", "--yes", "--category", "harness-cache"],
      own,
    );
    expect(code).toBe(0);

    // The manifest is the one document (D115), written where 08 §5 says it goes.
    expect(manifest).toMatchObject({ schemaVersion: 0, mode: "run" });
    const rows = manifest?.["rows"];
    if (!Array.isArray(rows)) throw new Error("expected rows[] in the manifest");
    const moved = rows.filter(isRecord);
    expect(moved).toHaveLength(3);
    for (const row of moved) {
      expect(row["result"]).toMatchObject({ status: "moved" });
      expect(row["finding"]).not.toBeNull();
    }

    // Only what the plan named left the tree; nothing was ever spawned.
    const planned = new Set(
      moved.flatMap((row) => {
        const target = row["target"];
        const paths = isRecord(target) ? target["paths"] : [];
        return Array.isArray(paths) ? paths.filter((path) => typeof path === "string") : [];
      }),
    );
    expect(planned.size).toBeGreaterThan(0);
    expect(new Set(fake.trashed.flat())).toEqual(planned);
    expect(fake.spawned).toEqual([]);
    const gone = before.filter((path) => !existsSync(path));
    expect(gone.length).toBeGreaterThan(0);
    for (const path of gone) {
      expect([...planned].some((kept) => path === kept || path.startsWith(kept + sep))).toBe(true);
    }
    // The recent session, the backup clone and the kept state are all still in place.
    const after = await filesUnder(own.home);
    expect(after.some((path) => path.includes("11111111-1111"))).toBe(true);
    expect(after.some((path) => path.includes("backups/"))).toBe(true);

    expect(out).toContain("Clean (3)");
    expect(out).toContain("Rows: 3 moved · 0 edited · 0 delegated · 0 refused · 0 failed");
    expect(out).toContain("Manifest: ");
    expect(out).toContain('recovery: OS trash "Put Back"');
  });

  it("prints the run manifest and nothing else with --json", async () => {
    const { code, out } = await clean(
      ["clean", "--yes", "--harness", "claude-code", "--json"],
      own,
    );
    expect(code).toBe(0);
    expect(out.startsWith("{")).toBe(true);
    expect(out.trimEnd()).not.toContain("\n");
    expect(jsonOf(out)).toMatchObject({ mode: "run", schemaVersion: 0 });
  });

  it("a failed row never aborts the run and makes it exit 1 (D4)", async () => {
    const plan = await clean(["clean", "--dry-run", "--json", "--category", "harness-cache"], own);
    const rows = jsonOf(plan.out)["rows"];
    if (!Array.isArray(rows)) throw new Error("expected rows[] in the plan document");
    const first = rows.find(isRecord);
    const target = first === undefined ? undefined : first["target"];
    const paths = isRecord(target) ? target["paths"] : [];
    const doomed = Array.isArray(paths) ? String(paths[0]) : "";

    const { code, out, manifest } = await clean(
      ["clean", "--yes", "--category", "harness-cache"],
      own,
      { failing: [doomed] },
    );
    expect(code).toBe(1);
    expect(out).toContain("1 failed");
    expect(out).toContain("2 moved");
    const written = manifest?.["rows"];
    if (!Array.isArray(written)) throw new Error("expected rows[] in the manifest");
    const statuses = written
      .filter(isRecord)
      .map((row) => (isRecord(row["result"]) ? row["result"]["status"] : null));
    expect(statuses.toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual([
      "failed",
      "moved",
      "moved",
    ]);
    expect(existsSync(doomed)).toBe(true);
  });

  it("selects nothing when the filters keep nothing, and exits 0", async () => {
    const { code, out, fake, manifest } = await clean(
      ["clean", "--yes", "--older-than", "10000"],
      own,
    );
    expect(code).toBe(0);
    expect(fake.trashed).toEqual([]);
    expect(out).toContain("Freed 0 B");
    expect(manifest).toMatchObject({ mode: "run" });
  });
});

describe("usage errors exit 2", () => {
  it("an unknown flag", async () => {
    const { code, out, err } = await run(["scan", "--nope"]);
    expect(code).toBe(2);
    expect(out).toBe("");
    expect(err).toContain("moldig: unknown flag --nope");
    expect(err).toContain("usage: moldig");
  });

  it("an unknown Harness id, listing the valid ones", async () => {
    const { code, err } = await run(["scan", "--harness", "windsurf"]);
    expect(code).toBe(2);
    expect(err).toContain("claude-code, codex, cursor, gemini-cli, copilot, opencode");
  });

  it("an unknown Category and a bad severity", async () => {
    const bad = await Promise.all([
      run(["audit", "--category", "clutter"]),
      run(["audit", "--severity", "critical"]),
      run(["audit", "--fail-on", "always"]),
    ]);
    for (const { code } of bad) expect(code).toBe(2);
  });

  it("a Root that is not an existing directory (D23)", async () => {
    const missing = await run(["scan", treePaths(tree).dir("nowhere")]);
    expect(missing.code).toBe(2);
    expect(missing.err).toContain("no such directory");

    const file = await run(["scan", tree.path("home/.claude.json")]);
    expect(file.code).toBe(2);
    expect(file.err).toContain("not a directory");
  });

  it("a flag the command does not take", async () => {
    const { code, err } = await run(["scan", "--fail-on", "high"]);
    expect(code).toBe(2);
    expect(err).toContain("--fail-on is not a flag of scan");
  });

  it("an unsupported platform (D125)", async () => {
    const { code, err } = await run(["scan"], { platform: "freebsd" });
    expect(code).toBe(2);
    expect(err).toContain("moldig runs on darwin, linux, win32, not on freebsd");
  });
});

describe("--help and --version (D13)", () => {
  it("prints the global page", async () => {
    const { code, out } = await run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("moldig — CleanMyMac for your AI setup.");
    expect(out).toContain("moldig scan [roots…]");
    expect(out).toContain("Exit codes");
  });

  it("prints a page per command", async () => {
    const commands = ["scan", "audit", "clean"];
    const pages = await Promise.all(commands.map((command) => run([command, "--help"])));
    for (const [i, page] of pages.entries()) {
      expect(page.code).toBe(0);
      expect(page.out.startsWith(`moldig ${commands[i]} [roots…]`)).toBe(true);
    }
  });

  it("prints the version", async () => {
    const { code, out } = await run(["--version"]);
    expect(code).toBe(0);
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+/u);
  });
});

describe("the output contract", () => {
  it("sends every Warning to stderr and none to stdout", async () => {
    const { out, err } = await run(["scan", "--no-git", tree.root]);
    expect(err).toContain("warning git-missing: git not run (git: false)");
    expect(err).toContain("warning: scanning only: Claude Code");
    expect(out.split("\n").some((line) => line.startsWith("warning"))).toBe(false);
  });

  it("folds a multi-line Warning message onto one line", async () => {
    // git fails on the fixture's HEAD-only repository and quotes the command it ran, newline
    // and all; the contract is one line per Warning.
    const { err } = await run(["scan", tree.root]);
    const lines = err.split("\n").filter((line) => line !== "");
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line.startsWith("warning"))).toBe(true);
  });

  it("keeps stdout free of Warnings with --json too", async () => {
    const { out, err } = await run(["scan", "--no-git", "--json", tree.root]);
    expect(err).toContain("warning git-missing");
    expect(out.startsWith("{")).toBe(true);
  });

  it("writes no escape sequence when NO_COLOR is set, terminal or not", async () => {
    const runs = await Promise.all(
      [true, false].map((isTTY) =>
        run(["audit", "--no-git", tree.root], { isTTY, env: { NO_COLOR: "1" } }),
      ),
    );
    for (const { out } of runs) expect(out).not.toMatch(ESCAPES);
  });

  it("writes no escape sequence when TERM is dumb", async () => {
    const { out } = await run(["audit", "--no-git", tree.root], {
      isTTY: true,
      env: { TERM: "dumb" },
    });
    expect(out).not.toMatch(ESCAPES);
  });

  it("colours the report for FORCE_COLOR even in a pipe (D20)", async () => {
    const { out } = await run(["audit", "--no-git", tree.root], { env: { FORCE_COLOR: "1" } });
    expect(out).toMatch(ESCAPES);
  });

  it("never wraps a line past the width it was given", async () => {
    const widths = [80, 100];
    const runs = await Promise.all(
      widths.map((columns) => run(["audit", "--no-git", tree.root], { columns })),
    );
    for (const [i, { out }] of runs.entries()) {
      for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(widths[i] ?? 80);
    }
  });
});
