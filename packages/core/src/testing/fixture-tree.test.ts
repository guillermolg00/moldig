/**
 * The one test file that spells `` `${tree.root}/…` `` on purpose. Everywhere else a path is
 * composed with `treePaths`, which uses the tree's own separator; here the expectation is the
 * *content* of a fixture file, where `<ROOT>` was substituted textually and the `/` after it is a
 * byte the case committed. On Windows the file really does read `C:\…\root/project-a`, so the
 * literal form is the correct one and `treePaths` would be wrong.
 */
import { lstat, mkdtemp, readdir, readFile, readlink, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  findFixturesDirFrom,
  rewriteContent,
  sqliteRewriteStatement,
  type FixtureTokens,
} from "./fixture-tree.js";
import { loadFixture, normaliseSnapshot, type FixtureOptions, type FixtureTree } from "./index.js";

const DAY_MS = 86_400_000;
const NOW = new Date("2026-08-26T12:00:00.000Z");
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
/** utimes precision differs per file system; `toBeCloseTo` allows half of 10^-digits: two seconds covers all CI runners. */
const MTIME_DIGITS = -Math.log10(4_000);

const trees: FixtureTree[] = [];

async function load(caseName: string, options?: FixtureOptions): Promise<FixtureTree> {
  const tree = await loadFixture(caseName, { now: NOW, ...options });
  trees.push(tree);
  return tree;
}

afterEach(async () => {
  await Promise.all(trees.splice(0).map((tree) => tree.cleanup()));
});

async function isSymlink(path: string): Promise<boolean> {
  return (await lstat(path)).isSymbolicLink();
}

async function mtimeMs(path: string): Promise<number> {
  return (await stat(path)).mtimeMs;
}

async function isEmptyDir(path: string): Promise<boolean> {
  return (await stat(path)).isDirectory() && (await readdir(path)).length === 0;
}

function daysAgo(days: number): number {
  return NOW.getTime() - days * DAY_MS;
}

function parseJson(text: string): unknown {
  return JSON.parse(text);
}

describe("loadFixture: claude-code/breadcrumbs", () => {
  it("copies the case into a temp tree with home, root, cwd, platform and env", async () => {
    const tree = await load("claude-code/breadcrumbs");
    expect(tree.harness).toBe("claude-code");
    expect(tree.home).toBe(join(tree.dir, "home"));
    expect(tree.root).toBe(join(tree.dir, "root"));
    expect(tree.roots).toEqual([tree.root]);
    expect(tree.cwd).toBe(tree.root);
    expect(tree.platform).toBe(process.platform);
    expect(tree.env).toEqual({});
    expect(await realpath(tree.dir)).toBe(tree.dir);
  });

  it("honours cwd, platform and env options without touching process.env", async () => {
    const tree = await load("claude-code/breadcrumbs", {
      cwd: "root/project-a",
      platform: "linux",
      env: { CLAUDE_CONFIG_DIR: "/elsewhere" },
    });
    expect(tree.cwd).toBe(join(tree.root, "project-a"));
    expect(tree.platform).toBe("linux");
    expect(tree.env).toEqual({ CLAUDE_CONFIG_DIR: "/elsewhere" });
  });

  it("renames _git into the .git directory and the worktree's .git file with gitdir rewritten", async () => {
    const tree = await load("claude-code/breadcrumbs");
    expect((await stat(tree.path("root/project-a/.git"))).isDirectory()).toBe(true);
    expect(await readFile(tree.path("root/project-a/.git/HEAD"), "utf8")).toContain("ref:");
    await expect(stat(tree.path("root/project-a/_git"))).rejects.toThrow(/ENOENT/);

    const worktreeGit = tree.path("root/project-a-wt/.git");
    expect((await stat(worktreeGit)).isFile()).toBe(true);
    const gitdir = (await readFile(worktreeGit, "utf8")).trim();
    expect(gitdir).toBe(`gitdir: ${tree.root}/project-a/.git/worktrees/project-a-wt`);

    const registered = (
      await readFile(tree.path("root/project-a/.git/worktrees/project-a-wt/gitdir"), "utf8")
    ).trim();
    expect(registered).toBe(`${tree.root}/project-a-wt/.git`);
  });

  it("renames slug directories with the Claude Code slug of the temp paths", async () => {
    const tree = await load("claude-code/breadcrumbs");
    const rootSlug = tree.slug(tree.root);
    expect(rootSlug).toBe(tree.root.replace(/[^A-Za-z0-9]/g, "-"));
    const slugDirs = await readdir(tree.path("home/.claude/projects"));
    expect(slugDirs.some((name) => name.includes("__"))).toBe(false);
    expect(slugDirs).toContain(`${rootSlug}-project-a`);
    expect(slugDirs).toContain(`${rootSlug}-project-a-apps-web`);
    expect(slugDirs).toContain(tree.slug(tree.home));
    expect(
      (await stat(tree.path("home/.claude/projects/__ROOT__-project-a/memory/MEMORY.md"))).isFile(),
    ).toBe(true);
  });

  it("rewrites <HOME> and <ROOT> inside .claude.json and keeps it parseable", async () => {
    const tree = await load("claude-code/breadcrumbs");
    const raw = await readFile(tree.path("home/.claude.json"), "utf8");
    expect(raw).not.toContain("<HOME>");
    expect(raw).not.toContain("<ROOT>");
    const parsed = parseJson(raw);
    expect(parsed).toHaveProperty(["projects", `${tree.root}/project-a`]);
    expect(parsed).toHaveProperty(["projects", `${tree.root}/project-a/apps/web`]);
    expect(parsed).toHaveProperty(["projects", tree.home]);
    expect(parsed).toHaveProperty(["projects", "/Volumes/Backup/old"]);
    expect(parsed).toHaveProperty("oauthAccount");
  });

  it("rewrites __ROOT__ inside sessions-index.json and the transcript", async () => {
    const tree = await load("claude-code/breadcrumbs");
    const slugDir = `${tree.home}/.claude/projects/${tree.slug(tree.root)}-project-a`;

    const index = parseJson(
      await readFile(
        tree.path("home/.claude/projects/__ROOT__-project-a/sessions-index.json"),
        "utf8",
      ),
    );
    expect(index).toHaveProperty(["entries", 0, "fullPath"], `${slugDir}/${SESSION_A}.jsonl`);
    expect(index).toHaveProperty(["entries", 0, "projectPath"], `${tree.root}/project-a`);

    const transcript = await readFile(
      tree.path(`home/.claude/projects/__ROOT__-project-a/${SESSION_A}.jsonl`),
      "utf8",
    );
    expect(transcript).not.toContain("__ROOT__");
    expect(transcript).not.toContain("<HOME>");
    const lines = transcript.trim().split("\n").map(parseJson);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveProperty("cwd", `${tree.root}/project-a`);
    expect(lines[1]).toHaveProperty(
      ["message", "content", 0, "input", "file_path"],
      `${slugDir}/memory/MEMORY.md`,
    );
  });

  it("applies ages with utimes, including the 45-day-old apps/web transcript", async () => {
    const tree = await load("claude-code/breadcrumbs");
    expect(
      await mtimeMs(tree.path("home/.claude/shell-snapshots/snapshot-zsh-1700000000000-synth1.sh")),
    ).toBeCloseTo(daysAgo(45), MTIME_DIGITS);
    expect(await mtimeMs(tree.path(`home/.claude/tasks/${SESSION_A}/1.json`))).toBeCloseTo(
      daysAgo(5),
      MTIME_DIGITS,
    );
    expect(
      await mtimeMs(
        tree.path(`home/.claude/projects/__ROOT__-project-a-apps-web/${SESSION_B}.jsonl`),
      ),
    ).toBeCloseTo(daysAgo(45), MTIME_DIGITS);
    // an un-aged file is fresh
    expect(await mtimeMs(tree.path("home/.claude/settings.json"))).toBeGreaterThan(daysAgo(1));
  });

  it("leaves zero-byte files empty (present but unreadable)", async () => {
    const tree = await load("claude-code/breadcrumbs");
    expect((await stat(tree.path(`home/.claude/tasks/${SESSION_A}/.lock`))).size).toBe(0);
  });

  it("removes the temp tree on cleanup", async () => {
    const tree = await loadFixture("claude-code/breadcrumbs");
    await tree.cleanup();
    await expect(stat(tree.dir)).rejects.toThrow(/ENOENT/);
  });
});

describe("loadFixture: shared/root-tree", () => {
  it("creates an empty home when the case has none", async () => {
    const tree = await load("shared/root-tree");
    expect(await isEmptyDir(tree.home)).toBe(true);
  });

  it("creates the declared directory symlink relative to its parent", async () => {
    const tree = await load("shared/root-tree");
    const link = tree.path("root/link-to-monorepo");
    expect(await isSymlink(link)).toBe(true);
    const target = await readlink(link);
    expect(target.endsWith("monorepo")).toBe(true);
    const monorepo = await realpath(tree.path("root/monorepo"));
    expect(await realpath(resolve(dirname(link), target))).toBe(monorepo);
    expect(await realpath(link)).toBe(monorepo);
  });

  it("renames nested _git entries and rewrites the worktree records", async () => {
    const tree = await load("shared/root-tree");
    expect((await stat(tree.path("root/monorepo/vendor/lib/.git/HEAD"))).isFile()).toBe(true);
    await expect(stat(tree.path("root/monorepo/vendor/lib/_git"))).rejects.toThrow(/ENOENT/);
    expect((await stat(tree.path("root/wt-feature/.git"))).isFile()).toBe(true);
    const gitdir = (await readFile(tree.path("root/wt-feature/.git"), "utf8")).trim();
    expect(gitdir.startsWith(`gitdir: ${tree.root}/`)).toBe(true);
    expect(gitdir).not.toContain("<ROOT>");
  });

  it("uses the identity slug and normalises paths to <ROOT>", async () => {
    const tree = await load("shared/root-tree");
    expect(tree.slug(tree.root)).toBe(tree.root);
    expect(normaliseSnapshot(`${tree.root}/monorepo`, tree)).toBe("<ROOT>/monorepo");
  });
});

describe("loadFixture: claude-code/skills-and-plugins", () => {
  it("creates a dangling symlink as a link and the empty dirs", async () => {
    const tree = await load("claude-code/skills-and-plugins");
    const dangling = tree.path("home/.claude/skills/skill-dangling");
    expect(await isSymlink(dangling)).toBe(true);
    await expect(stat(dangling)).rejects.toThrow(/ENOENT/);

    const linked = tree.path("home/.claude/skills/skill-a");
    expect(await isSymlink(linked)).toBe(true);
    expect(await realpath(linked)).toBe(await realpath(tree.path("home/.agents/skills/skill-a")));

    expect(await isEmptyDir(tree.path("home/.claude/plugins/repos"))).toBe(true);
    expect(await isEmptyDir(tree.path("home/.claude/plugins/data/plugin-a-marketplace-a"))).toBe(
      true,
    );
  });
});

describe("loadFixture: sqlite rewrite", () => {
  it("replaces the placeholders inside opencode.db and keeps the -wal sidecar", async () => {
    const tree = await load("opencode/db-and-config");
    const file = tree.path("home/.local/share/opencode/opencode.db");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const worktrees = db
        .prepare("SELECT worktree FROM project")
        .all()
        .map((row) => row["worktree"]);
      expect(worktrees).toContain(`${tree.root}/project-a`);
      expect(worktrees).toContain(tree.home);
      expect(worktrees).toContain("/");
      expect(JSON.stringify(worktrees)).not.toMatch(/<ROOT>|<HOME>/);
      const directories = db
        .prepare("SELECT directory FROM session")
        .all()
        .map((row) => row["directory"]);
      expect(directories).toContain(`${tree.root}/project-a/packages/api`);
    } finally {
      db.close();
    }
    expect((await stat(`${file}-wal`)).size).toBe(0);
  });

  it("replaces the placeholders inside the Codex state database", async () => {
    const tree = await load("codex/trust-and-state");
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(tree.path("home/.codex/state_5.sqlite"), { readOnly: true });
    try {
      const rows = db.prepare("SELECT cwd, rollout_path FROM threads").all();
      expect(rows.map((row) => row["cwd"])).toContain(`${tree.root}/project-a`);
      const rolloutPaths = rows.map((row) => String(row["rollout_path"]));
      expect(rolloutPaths.every((path) => path.startsWith(`${tree.home}/.codex/sessions/`))).toBe(
        true,
      );
    } finally {
      db.close();
    }
  });
});

/** A win32-shaped temp tree, so D100's escaping branch is exercised on any host. */
const WIN32_TOKENS: FixtureTokens = {
  home: "C:\\Temp\\fx\\home",
  root: "C:\\Temp\\fx\\root",
  homeSlug: "C--Temp-fx-home",
  rootSlug: "C--Temp-fx-root",
  homeUri: "/C:/Temp/fx/home",
  rootUri: "/C:/Temp/fx/root",
};

describe("loadFixture: file:// placeholders and the JSON branch (D100)", () => {
  it("rewrites a file:// placeholder into a URI that decodes back to the real directory", async () => {
    const tree = await load("cursor/workspaces");
    const storage = tree.path("home/Library/Application Support/Cursor/User/workspaceStorage");
    const texts = await Promise.all(
      (await readdir(storage)).map((id) =>
        readFile(join(storage, id, "workspace.json"), "utf8").catch(() => null),
      ),
    );
    const folders = texts
      .filter((text): text is string => text !== null)
      .flatMap((text) => /"folder"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? []);

    expect(folders.length).toBeGreaterThan(0);
    for (const folder of folders) {
      // A valid URI on every platform: `file:///tmp/…` here, `file:///C:/…` on win32 (D100).
      expect(folder.startsWith("file:///")).toBe(true);
      expect(() => new URL(folder)).not.toThrow();
    }
    // At least one of them decodes back to a directory of this tree.
    expect(folders.map((folder) => fileURLToPath(folder))).toContain(tree.path("root/project-a"));
    expect(folders.join(" ")).not.toMatch(/<ROOT>|<HOME>/);
  });

  it("writes the /C:/… URI form inside a JSON file and escapes the plain path there", () => {
    const text = JSON.stringify({ folder: "file://<ROOT>/project-a", cwd: "<ROOT>/project-a" });
    const parsed = parseJson(rewriteContent(text, WIN32_TOKENS, true));
    expect(parsed).toHaveProperty("folder", "file:///C:/Temp/fx/root/project-a");
    expect(parsed).toHaveProperty("cwd", "C:\\Temp\\fx\\root/project-a");
    // A YAML or Markdown file gets the same URI but no backslash escaping.
    expect(rewriteContent("cwd: <ROOT>/p", WIN32_TOKENS, false)).toBe("cwd: C:\\Temp\\fx\\root/p");
  });

  it("escapes backslashes inside a JSON column and leaves a bare path alone", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("CREATE TABLE t(v TEXT)");
      const insert = db.prepare("INSERT INTO t VALUES(?)");
      insert.run("<ROOT>/project-a");
      insert.run('{"worktree":"<ROOT>/project-a","uri":"file://<ROOT>/project-a"}');
      const { sql, params } = sqliteRewriteStatement("t", "v", WIN32_TOKENS);
      db.prepare(sql).run(...params);
      const values = db
        .prepare("SELECT v FROM t")
        .all()
        .map((row) => String(row["v"]));

      // The bare path keeps its single backslashes: it is not a JSON document.
      expect(values[0]).toBe("C:\\Temp\\fx\\root/project-a");
      // The JSON document is still valid JSON, and parses back to the real path.
      const document = values[1] ?? "";
      expect(document).toContain("C:\\\\Temp\\\\fx\\\\root");
      const parsed = parseJson(document);
      expect(parsed).toHaveProperty("worktree", "C:\\Temp\\fx\\root/project-a");
      // The `file://` value takes the URI form, `/C:/…`, and never carries a backslash.
      expect(parsed).toHaveProperty("uri", "file:///C:/Temp/fx/root/project-a");
    } finally {
      db.close();
    }
  });
});

describe("loadFixture: failure modes (D101)", () => {
  it("names a case that does not exist", async () => {
    await expect(loadFixture("claude-code/no-such-case")).rejects.toThrow(/fixture case not found/);
  });

  it("rejects a case name that is not '<harness>/<case>'", async () => {
    await expect(loadFixture("breadcrumbs")).rejects.toThrow(/must be "<harness>\/<case>"/);
  });

  it("says the helper is monorepo-internal when fixtures/ cannot be found", async () => {
    // The search walks up; started outside the checkout it finds nothing, and the message has
    // to explain why instead of printing a path (D101).
    const outside = await mkdtemp(join(tmpdir(), "moldig-no-fixtures-"));
    try {
      await expect(findFixturesDirFrom(outside)).rejects.toThrow(
        /@moldig\/core\/testing: no fixtures\/ directory[\s\S]*monorepo/,
      );
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("finds the checkout's fixtures/ from this module", async () => {
    const found = await findFixturesDirFrom(dirname(fileURLToPath(import.meta.url)));
    expect(await stat(join(found, "README.md"))).toBeDefined();
  });
});

describe("normaliseSnapshot", () => {
  it("replaces paths and slugs (longest first), folds case, converts backslashes, deep-clones", async () => {
    const tree = await load("claude-code/breadcrumbs");
    const rootSlug = tree.slug(tree.root);
    const input = {
      path: `${tree.root}/project-a`,
      nested: { home: [tree.home, `${tree.home}/.claude`] },
      slug: `${rootSlug}-project-a`,
      folded: `project:${tree.root.toLowerCase()}/project-a`,
      foldedSlug: `breadcrumb:claude-code:${rootSlug.toLowerCase()}-project-a`,
      windows: "a\\b",
      [tree.home]: 1,
      number: 3,
      nothing: null,
    };
    const snapshot = normaliseSnapshot(input, tree);
    expect(snapshot).toEqual({
      path: "<ROOT>/project-a",
      nested: { home: ["<HOME>", "<HOME>/.claude"] },
      slug: "__ROOT__-project-a",
      folded: "project:<ROOT>/project-a",
      foldedSlug: "breadcrumb:claude-code:__ROOT__-project-a",
      windows: "a/b",
      "<HOME>": 1,
      number: 3,
      nothing: null,
    });
    expect(input.path).toBe(`${tree.root}/project-a`);
    expect(snapshot.nested).not.toBe(input.nested);
  });

  it("never applies slug patterns for harnesses whose slug directories carry no path", async () => {
    const tree = await load("gemini-cli/zero-breadcrumbs");
    expect(tree.slug(`${tree.root}/Project A.b`)).toBe("project-a-b");
    expect(normaliseSnapshot(`${tree.root}/project-a`, tree)).toBe("<ROOT>/project-a");
    expect(normaliseSnapshot("root/project-a and home", tree)).toBe("root/project-a and home");
    expect(await isSymlink(tree.path("home/.gemini/skills/skill-gone"))).toBe(true);
  });
});
