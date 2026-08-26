/**
 * `treePaths` composes with the rules the tree's own path implies, so the same call produces a
 * POSIX path from a POSIX tree and a Windows path from a Windows tree — on any host. The win32
 * cases below are the ones a Windows runner produces; they are checked from a POSIX host because
 * `pathEngine` reads the spelling of the path, not `process.platform`.
 */
import { win32 } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ScanPlatform } from "../scan/paths.js";
import { loadFixture, type FixtureTree } from "./fixture-tree.js";
import { treePaths } from "./tree-paths.js";

/** A tree that never touched a disk: only what `treePaths` reads. */
function fakeTree(dir: string, platform: ScanPlatform, harness: string): FixtureTree {
  const engine = platform === "win32" ? win32 : { join: (...parts: string[]) => parts.join("/") };
  const home = engine.join(dir, "home");
  const root = engine.join(dir, "root");
  return {
    dir,
    home,
    root,
    roots: [root],
    cwd: root,
    platform,
    env: {},
    harness,
    path: (caseRelative) => engine.join(dir, ...caseRelative.split("/")),
    // Claude Code's rule, the one the win32/darwin pair below compares.
    slug: (absolutePath) => absolutePath.replace(/[^A-Za-z0-9]/g, "-"),
    cleanup: () => Promise.resolve(),
  };
}

/** What a composed path adds after the base, read with that platform's separator. */
const tail = (full: string, base: string, separator: string): string[] =>
  full.slice(base.length + 1).split(separator);

const POSIX = fakeTree("/tmp/moldig-fixture-a/tttt", "darwin", "claude-code");
const WIN32 = fakeTree("C:\\Temp\\moldig-fixture-a\\tttt", "win32", "claude-code");

describe("treePaths composes with the tree's own path rules", () => {
  it("joins with the host separator on POSIX and with `\\` on a Windows tree", () => {
    expect(treePaths(POSIX).home(".claude/settings.json")).toBe(
      "/tmp/moldig-fixture-a/tttt/home/.claude/settings.json",
    );
    expect(treePaths(WIN32).home(".claude/settings.json")).toBe(
      "C:\\Temp\\moldig-fixture-a\\tttt\\home\\.claude\\settings.json",
    );
    expect(treePaths(POSIX).root("project-a", "CLAUDE.md")).toBe(
      "/tmp/moldig-fixture-a/tttt/root/project-a/CLAUDE.md",
    );
    expect(treePaths(WIN32).root("project-a", "CLAUDE.md")).toBe(
      "C:\\Temp\\moldig-fixture-a\\tttt\\root\\project-a\\CLAUDE.md",
    );
    // No relative part: the tree's own directory, unchanged.
    expect(treePaths(WIN32).dir()).toBe("C:\\Temp\\moldig-fixture-a\\tttt");
  });

  it("appends the same segments on both platforms — only the separator differs", () => {
    const named = [".claude", "projects", "x.json"];
    expect(tail(treePaths(POSIX).home(".claude/projects", "x.json"), POSIX.home, "/")).toEqual(
      named,
    );
    expect(tail(treePaths(WIN32).home(".claude/projects", "x.json"), WIN32.home, "\\")).toEqual(
      named,
    );
  });

  it("puts the slug directory where the harness keeps it", () => {
    expect(treePaths(POSIX).slugDir("slug-a", "memory/MEMORY.md")).toBe(
      "/tmp/moldig-fixture-a/tttt/home/.claude/projects/slug-a/memory/MEMORY.md",
    );
    expect(treePaths(WIN32).slugDir("slug-a", "memory/MEMORY.md")).toBe(
      "C:\\Temp\\moldig-fixture-a\\tttt\\home\\.claude\\projects\\slug-a\\memory\\MEMORY.md",
    );
    expect(treePaths(fakeTree("/tmp/t", "darwin", "cursor")).slugDir("1700000000000")).toBe(
      "/tmp/t/home/.cursor/projects/1700000000000",
    );
    expect(treePaths(fakeTree("/tmp/t", "darwin", "gemini-cli")).slugDir("project-a")).toBe(
      "/tmp/t/home/.gemini/tmp/project-a",
    );
    expect(() => treePaths(fakeTree("/tmp/t", "darwin", "codex")).slugDir("x")).toThrow(
      /no path-derived slug directory/,
    );
  });

  it("takes the harness's slug of home and root from the tree", () => {
    expect(treePaths(POSIX).rootSlug()).toBe("-tmp-moldig-fixture-a-tttt-root");
    expect(treePaths(WIN32).homeSlug()).toBe("C--Temp-moldig-fixture-a-tttt-home");
  });

  it("folds an id the way the pinned platform does, and never folds the keyPath", () => {
    // darwin: case only — the separator the host wrote survives, which is the point.
    expect(treePaths(POSIX).id("settings-file", "/tmp/T/Home/.claude/Settings.json")).toBe(
      "settings-file:/tmp/t/home/.claude/settings.json",
    );
    const darwinOnWindowsPath = fakeTree("C:\\Temp\\t", "darwin", "claude-code");
    expect(treePaths(darwinOnWindowsPath).id("settings-file", "C:\\Temp\\t\\home\\A.json")).toBe(
      "settings-file:c:\\temp\\t\\home\\a.json",
    );
    // win32: case and separators both fold (D141).
    expect(treePaths(WIN32).id("settings-file", "C:\\Temp\\t\\home\\A.json")).toBe(
      "settings-file:c:/temp/t/home/a.json",
    );
    // The `#keyPath` is a JSON key path, not a path: it keeps its case and its slashes.
    expect(treePaths(POSIX).id("mcp-server", "/tmp/T/.claude.json#mcpServers/Server-A")).toBe(
      "mcp-server:/tmp/t/.claude.json#mcpServers/Server-A",
    );
  });

  it("accepts the tree lazily, so the helpers can be destructured at module scope", () => {
    let current = POSIX;
    const { home } = treePaths(() => current);
    expect(home("a")).toBe("/tmp/moldig-fixture-a/tttt/home/a");
    current = WIN32;
    expect(home("a")).toBe("C:\\Temp\\moldig-fixture-a\\tttt\\home\\a");
  });
});

describe("treePaths over a real tree", () => {
  let tree: FixtureTree;

  beforeAll(async () => {
    tree = await loadFixture("claude-code/breadcrumbs", { platform: "darwin" });
  }, 60_000);

  afterAll(async () => {
    await tree.cleanup();
  });

  it("agrees with `tree.path` and with the tree's own slug rule", () => {
    const paths = treePaths(() => tree);
    expect(paths.home(".claude/CLAUDE.md")).toBe(tree.path("home/.claude/CLAUDE.md"));
    expect(paths.root("project-a", "CLAUDE.md")).toBe(tree.path("root/project-a/CLAUDE.md"));
    expect(paths.slugDir(`${paths.rootSlug()}-project-a`)).toBe(
      tree.path("home/.claude/projects/__ROOT__-project-a"),
    );
    expect(paths.homeSlug()).toBe(tree.slug(tree.home));
  });
});
