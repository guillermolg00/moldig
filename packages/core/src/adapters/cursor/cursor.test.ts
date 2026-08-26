import { existsSync, statSync } from "node:fs";
import { cp } from "node:fs/promises";
import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit, scan } from "../../index.js";
import type {
  AuditIndex,
  Breadcrumb,
  Entity,
  HarnessCache,
  LoadedByEdge,
} from "../../index/types.js";
import {
  loadFixture,
  normaliseSnapshot,
  treePaths,
  type FixtureTree,
  fixtureCopyTime,
  POSIX_FIXTURE_HOST,
} from "../../testing/index.js";

/** After the fixture's synthetic timestamps; `ages` are relative to it (the same `now` for both). */
const NOW = new Date("2026-08-26T12:00:00.000Z");
const PLATFORM = "darwin";
const ISO_ANYWHERE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const DATE_ANYWHERE = /(?<![\dT:-])\d{4}-\d{2}-\d{2}(?![\dT])/g;

const APP_SUPPORT = "home/Library/Application Support/Cursor";
const STORAGE = `${APP_SUPPORT}/User/workspaceStorage`;
const GLOBAL_DB = `${APP_SUPPORT}/User/globalStorage/state.vscdb`;

let tree: FixtureTree;
let result: AuditIndex;
let linux: AuditIndex;
let linuxTree: FixtureTree;
/** Size and mtime of every database before the scan: nothing may open one (ticket 06 §1, D104). */
let databasesBefore: { path: string; size: number; mtimeMs: number }[] = [];

/**
 * The case-only pair (`<ROOT>/API-NESTJS` + `<ROOT>/api-nestjs`) is a *filesystem* fact, not a
 * `platform` option: on a case-insensitive volume (macOS, Windows) the lower-case breadcrumb finds
 * the directory, on Linux it is a ghost. Both answers fold into one Project under `platform:
 * "darwin"`; only the breadcrumb's own `reachability` differs, which is why the committed snapshot
 * is the one a case-insensitive volume produces (the machine the fixture was captured on).
 */
let caseInsensitiveHost = false;

const byText = (a: string, b: string): number => a.localeCompare(b);

const { home, root, slugDir, rootSlug, id } = treePaths(() => tree);
/** The second tree the case is scanned in, as `linux`: its ids fold nothing. */
const linuxPaths = treePaths(() => linuxTree);
/** A tree path with its `root/` or `home/` prefix dropped — the host's separator included. */
const relativeToTree = (path: string): string =>
  path.replace(`${root()}${sep}`, "").replace(`${home()}${sep}`, "");

function entity(kind: string, path: string): Entity {
  const found = result.entities.find((item) => item.id === id(kind, path));
  if (found === undefined) throw new Error(`entity not found: ${id(kind, path)}`);
  return found;
}

function unit(path: string): HarnessCache {
  const found = entity("harness-cache", path);
  if (found.kind !== "harness-cache") throw new Error(`not a cache unit: ${path}`);
  return found;
}

function loadedBy(kind: string, path: string): LoadedByEdge {
  const from = id(kind, path);
  const edge = result.edges.find((item) => item.kind === "loaded-by" && item.from === from);
  if (edge === undefined || edge.kind !== "loaded-by")
    throw new Error(`loaded-by edge not found for ${from}`);
  return edge;
}

function crumb(predicate: (crumb: Breadcrumb) => boolean, index = result): Breadcrumb {
  const found = index.breadcrumbs.find(predicate);
  if (found === undefined) throw new Error("breadcrumb not found");
  return found;
}

/** The two `workspace.json` records of the case-only pair, as the `platform: "linux"` run saw them. */
function linuxPair(): Breadcrumb[] {
  return linux.breadcrumbs.filter(
    (item) => item.kind === "workspace-record" && item.raw.toLowerCase().endsWith("api-nestjs"),
  );
}

function linuxSlug(): Breadcrumb {
  return crumb((item) => item.kind === "slug-directory" && item.raw.endsWith("api-nestjs"), linux);
}

/** Files the fixture does not age carry the copy's mtime; those stamps differ per run. */
function stableTimes(json: string): string {
  const copy = fixtureCopyTime(NOW).toISOString();
  const copyDate = copy.slice(0, 10);
  return json
    .replaceAll(ISO_ANYWHERE, (stamp) => (stamp === copy ? "<COPY-TIME>" : stamp))
    .replaceAll(DATE_ANYWHERE, (date) => (date === copyDate ? "<COPY-DATE>" : date));
}

/** JSON in the shape the repo's formatter keeps (`oxfmt --check` runs over `__snapshots__`). */
function formattedJson(value: unknown, indent = "", prefix = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = indent + "  ";
    const primitives = value.every((item) => typeof item !== "object" || item === null);
    if (primitives) {
      const line = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
      if (prefix + indent.length + line.length <= 100) return line;
    }
    return `[\n${value.map((item) => inner + formattedJson(item, inner)).join(",\n")}\n${indent}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const inner = indent + "  ";
    const lines = entries.map(([key, item]) => {
      const head = `${JSON.stringify(key)}: `;
      return `${inner}${head}${formattedJson(item, inner, head.length)}`;
    });
    return `{\n${lines.join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

function databaseFiles(current: FixtureTree): string[] {
  const dirs = [
    `${APP_SUPPORT}/User/globalStorage`,
    ...[
      "05309d04e4b91c8adfb3415e99ef759f",
      "219eb084383dab6b0fb5790b347d7478",
      "341f0e2c389cdc09e34ae0d26eeee4b9",
      "42d0ae0d01ed151eed33107f4ae83a3a",
      "a395ef5c679da40a8c8f31e20faabf8b",
      "a3b19f678ec5de0c22b6fb40f1563bcd",
      "d9fd13a22662fcf2edd0cbc8861280f1",
      "f28cf89f9f4a2c3f59231335caa293dc",
      "f3eb0056c6efb562233aa653b172cb84",
    ].map((storage) => `${STORAGE}/${storage}`),
  ];
  return dirs.flatMap((dir) =>
    ["state.vscdb", "state.vscdb.backup", "state.vscdb-wal", "state.vscdb-shm"]
      .map((name) => current.path(`${dir}/${name}`))
      .filter((path) => existsSync(path)),
  );
}

beforeAll(async () => {
  tree = await loadFixture("cursor/workspaces", {
    cwd: "root/project-a",
    now: NOW,
    platform: PLATFORM,
  });
  caseInsensitiveHost = existsSync(tree.path("root/api-nestjs"));
  databasesBefore = databaseFiles(tree).map((path) => {
    const stats = statSync(path);
    return { path, size: stats.size, mtimeMs: stats.mtimeMs };
  });
  const index = await scan({
    home: tree.home,
    roots: tree.roots,
    cwd: tree.cwd,
    platform: PLATFORM,
    env: tree.env,
    git: false,
    now: NOW,
    harnesses: ["cursor"],
  });
  result = await audit(index);

  linuxTree = await loadFixture("cursor/workspaces", {
    cwd: "root/project-a",
    now: NOW,
    platform: "linux",
  });
  // The case is a macOS capture: on linux the application-support directory is
  // `~/.config/Cursor` (D33), so the same tree is placed there — which is also the proof that
  // the adapter looks at the per-platform location and nowhere else.
  await cp(linuxTree.path(APP_SUPPORT), join(linuxTree.home, ".config", "Cursor"), {
    recursive: true,
    preserveTimestamps: true,
  });
  linux = await audit(
    await scan({
      home: linuxTree.home,
      roots: linuxTree.roots,
      cwd: linuxTree.cwd,
      platform: "linux",
      env: linuxTree.env,
      git: false,
      now: NOW,
      harnesses: ["cursor"],
    }),
  );
});

afterAll(async () => {
  await tree.cleanup();
  await linuxTree.cleanup();
});

describe.runIf(POSIX_FIXTURE_HOST)("cursor adapter over the workspaces case", () => {
  it("describes the harness from what it wrote to disk, running no binary", () => {
    const harness = result.harnesses[0];
    expect(result.harnesses).toHaveLength(1);
    expect(harness?.id).toBe("harness:cursor");
    expect(harness?.harness).toBe("cursor");
    expect(harness?.surfaces).toEqual(["ide", "cli"]);
    expect(harness?.presence).toBe("installed");
    // Cursor writes no version anywhere and moldig never runs `cursor-agent --version`.
    expect(harness?.version).toBeNull();
    expect(harness?.effectiveModel).toBeNull();
    expect(harness?.capabilities).toEqual({
      memoryLocation: "server-side",
      memoryReadSignal: "not-applicable",
      contextFileNames: ["AGENTS.md", "CLAUDE.md", ".cursorrules"],
      sweepDocumented: false,
    });
    expect(harness?.caps).toEqual({
      memoryIndexLines: null,
      memoryIndexBytes: null,
      chainMaxBytes: null,
      skillDescriptionChars: null,
      importDepth: null,
    });
    // D33: the two user-scope locations come from the shared per-platform table.
    expect(harness?.userScope.paths).toEqual([
      { path: home(".cursor"), role: "config", source: "default", envVar: null },
      {
        path: home("Library/Application Support/Cursor"),
        role: "app-support",
        source: "default",
        envVar: null,
      },
    ]);
    expect(harness?.effectiveSettings).toEqual({
      version: 1,
      editor: { vimMode: false },
      hasChangedDefaultModel: false,
      permissions: { allow: ["<redacted>"], deny: [] },
    });
    // The recents row of `state.vscdb` is named as a source and never read (ticket 06 §1).
    expect(harness?.breadcrumbSources.map((source) => [source.kind, source.readInV1])).toEqual([
      ["workspace-record", true],
      ["slug-directory", true],
      ["worktree-directory", true],
      ["workspace-record", false],
    ]);
    expect(result.warnings.map((item) => item.code)).toEqual(["git-missing"]);
    expect(result.scan.env).toEqual({});
    // Memory is server-side: no memory file, no read signal, no shadow-memory finding.
    expect(result.entities.some((item) => item.kind === "memory-file")).toBe(false);
    expect(result.findings.some((item) => item.category === "shadow-memory")).toBe(false);
  });

  it("honours CURSOR_CONFIG_DIR and records it in scan.env (D33)", async () => {
    const moved = await loadFixture("cursor/workspaces", {
      now: NOW,
      platform: PLATFORM,
      env: { CURSOR_CONFIG_DIR: home(".cursor") },
    });
    const movedConfig = treePaths(moved).home(".cursor");
    try {
      const index = await scan({
        home: moved.home,
        roots: moved.roots,
        cwd: moved.root,
        platform: PLATFORM,
        env: { CURSOR_CONFIG_DIR: movedConfig },
        git: false,
        now: NOW,
        harnesses: ["cursor"],
      });
      expect(index.scan.env).toEqual({ CURSOR_CONFIG_DIR: movedConfig });
      expect(index.harnesses[0]?.userScope.paths[0]).toEqual({
        path: movedConfig,
        role: "config",
        source: "env",
        envVar: "CURSOR_CONFIG_DIR",
      });
    } finally {
      await moved.cleanup();
    }
  });

  it("folds the case-only pair into one Project on darwin and into two on linux", () => {
    const pair = result.breadcrumbs.filter(
      (item) => item.kind === "workspace-record" && item.raw.toLowerCase().endsWith("api-nestjs"),
    );
    expect(pair).toHaveLength(2);
    expect(new Set(pair.map((item) => item.project))).toEqual(
      new Set([id("project", root("API-NESTJS"))]),
    );
    const project = result.projects.find((item) => item.id === id("project", root("API-NESTJS")));
    expect(project?.path).toBe(root("API-NESTJS"));
    expect(project?.kind).toBe("repository");
    expect(project?.reachability).toBe("present");
    // The upper-case spelling is the one on disk; the lower-case record only reaches it on a
    // case-insensitive volume, and folds into the same id either way.
    const lower = pair.find((item) => item.raw.endsWith("api-nestjs"));
    expect(lower?.reachability).toBe(caseInsensitiveHost ? "present" : "orphan");
    // The slug `__ROOT__-api-nestjs` exists only in the lower-case spelling: an exact-case lookup
    // finds nothing, the folded one finds the pair (spec §1.3 `slug-by-key`).
    const slug = crumb((item) => item.kind === "slug-directory" && item.raw.endsWith("api-nestjs"));
    expect(slug.resolution).toBe("slug-by-key");
    expect(slug.project).toBe(id("project", root("API-NESTJS")));

    expect(linuxPair()).toHaveLength(2);
  });

  it("makes the case-only pair two Projects on linux, where nothing folds by identity", (context) => {
    // On a case-insensitive volume the filesystem itself resolves both spellings to the one
    // directory, whatever the platform says; the identity fold is what the next test looks at.
    context.skip(caseInsensitiveHost, "the volume folds case, so the pair is one directory here");
    expect(new Set(linuxPair().map((item) => item.project)).size).toBe(2);
    expect(linuxPair().map((item) => item.project)).toContain(
      linuxPaths.id("project", linuxPaths.root("API-NESTJS")),
    );
    expect(linuxPair().map((item) => item.project)).toContain(
      linuxPaths.id("project", linuxPaths.root("api-nestjs")),
    );
    expect(
      linux.projects.filter((item) => item.path.toLowerCase().endsWith("api-nestjs")),
    ).toHaveLength(2);
    // The slug is the lower-case spelling: on linux it resolves to the lower-case Project only.
    expect(linuxSlug().project).toBe(linuxPaths.id("project", linuxPaths.root("api-nestjs")));
  });

  it("drops the slug-by-key match on linux: the fold that found it is the darwin identity", (context) => {
    context.skip(!caseInsensitiveHost, "a case-sensitive volume answers with two Projects instead");
    // Both records resolve to the directory that exists (`API-NESTJS`), whose slug is not the one
    // on disk — with no case fold there is no key to match, so the slug names nothing.
    expect(linuxSlug().resolution).toBe("unresolved");
    expect(linuxSlug().project).toBeNull();
    expect(linuxSlug().strayReason).toBe("unresolved-slug");
  });

  it("gathers the ghost project's three breadcrumbs and the state behind them", () => {
    const gone = result.projects.find((item) => item.id === id("project", root("gone")));
    expect(gone?.reachability).toBe("orphan");
    expect(gone?.kind).toBe("unknown");
    const crumbs = result.breadcrumbs.filter((item) => item.project === gone?.id);
    expect(crumbs.map((item) => item.kind).toSorted(byText)).toEqual([
      "slug-directory",
      "workspace-record",
      "worktree-directory",
    ]);
    const storage = unit(
      home(
        "Library/Application Support/Cursor/User/workspaceStorage/42d0ae0d01ed151eed33107f4ae83a3a",
      ),
    );
    expect(storage.metrics.ageDays).toBe(200);
    expect(storage.project).toBe(gone?.id);
    const stale = unit(home(".cursor/worktrees/gone/xyz"));
    expect(stale.cacheKind).toBe("worktree");
    expect(stale.rule).toBe("swept");
    expect(stale.liveGuard).toEqual({ kind: "install-path", alive: false });
    expect(stale.protection).toBe("none");
    expect(stale.removal).toEqual({ method: "trash" });
    // D67: a stale leaf is harness state, never a `detached-worktree` Project of its own.
    expect(result.projects.some((item) => item.path.includes(".cursor/worktrees"))).toBe(false);
    const orphan = result.findings.find((item) => item.category === "orphan");
    expect(orphan?.container).toBe(gone?.id);
    expect(orphan?.targets.filter((target) => target.role === "breadcrumb")).toHaveLength(3);
    // D117: the workspace directory is size-only, so it is never a removable target.
    expect(orphan?.targets.some((target) => target.id === storage.id)).toBe(false);
    expect(orphan?.targets.some((target) => target.id === stale.id)).toBe(true);
  });

  it("keeps two storage directories for one folder, the subdirectory workspace and the home workspace", () => {
    const duplicates = result.breadcrumbs.filter(
      (item) => item.kind === "workspace-record" && item.raw.endsWith("/project-a"),
    );
    expect(duplicates).toHaveLength(2);
    expect(new Set(duplicates.map((item) => item.project))).toEqual(
      new Set([id("project", root("project-a"))]),
    );
    expect(duplicates.map((item) => item.refs.workspaceStorageId ?? "").toSorted(byText)).toEqual([
      "a395ef5c679da40a8c8f31e20faabf8b",
      "f28cf89f9f4a2c3f59231335caa293dc",
    ]);
    // Ticket 08's exact hint for the marker Cursor writes when it deletes a workspace.
    expect(
      unit(
        home(
          `Library/Application Support/Cursor/User/workspaceStorage/a395ef5c679da40a8c8f31e20faabf8b`,
        ),
      ).label,
    ).toBe("a395ef5c · Cursor marked this workspace deleted");

    const nested = crumb((item) => item.raw.endsWith("/project-a/packages/api"));
    expect(nested.project).toBe(id("project", root("project-a")));
    expect(nested.relativePathInProject).toBe("packages/api");
    expect(loadedBy("context-file", root("project-a/packages/api/AGENTS.md")).mode).toBe(
      "on-demand",
    );

    const homeCrumb = crumb(
      (item) => item.kind === "workspace-record" && item.raw === `file://${tree.home}`,
    );
    expect(homeCrumb.project).toBeNull();
    expect(homeCrumb.strayReason).toBe("bare-directory");
    expect(homeCrumb.reachability).toBe("present");
    const homeSlug = crumb(
      (item) => item.kind === "slug-directory" && item.raw === tree.slug(tree.home),
    );
    expect(homeSlug.project).toBeNull();
    expect(homeSlug.strayReason).toBe("bare-directory");
    expect(result.harnesses[0]?.userScope.stray).toContain(homeCrumb.id);
    expect(result.harnesses[0]?.userScope.stray).toContain(homeSlug.id);
  });

  it("leaves the multi-root record, the record-less storage dir and the window id unresolved", () => {
    // D31: a record that names no folder points at nothing — Stray, never a Project.
    const multiRoot = crumb((item) => item.raw.endsWith("/workspace.json"));
    expect(multiRoot.recordedForm).toBe("file-uri");
    expect(multiRoot.path).toBeNull();
    expect(multiRoot.resolution).toBe("unresolved");
    expect(multiRoot.strayReason).toBe("unresolved-slug");
    expect(multiRoot.reachability).toBe("orphan");
    expect(multiRoot.occurrences.count).toBe(1);
    expect(multiRoot.occurrences.first).toBe(
      new Date(NOW.getTime() - 150 * 86_400_000).toISOString(),
    );

    const bare = unit(
      home(
        "Library/Application Support/Cursor/User/workspaceStorage/219eb084383dab6b0fb5790b347d7478",
      ),
    );
    expect(bare.label).toBe("219eb084 · no workspace.json");
    expect(bare.project).toBeNull();
    expect(
      result.breadcrumbs.some((item) =>
        item.locator.type === "file" ? item.locator.path.includes("219eb084") : false,
      ),
    ).toBe(false);

    const windowId = crumb((item) => item.raw === "1700000000000");
    expect(windowId.recordedForm).toBe("window-id");
    expect(windowId.resolution).toBe("unresolved");
    expect(windowId.strayReason).toBe("unresolved-slug");
    expect(windowId.path).toBeNull();
    expect(unit(slugDir("1700000000000")).protection).toBe("undocumented");
  });

  it("attributes the live worktree leaf to its repository and keeps it live", () => {
    const leaf = home(".cursor/worktrees/project-a/abc");
    const crumbAbc = crumb((item) => item.kind === "worktree-directory" && item.raw === leaf);
    expect(crumbAbc.path).toBe(root("project-a"));
    expect(crumbAbc.project).toBe(id("project", root("project-a")));
    expect(crumbAbc.resolution).toBe("direct");
    expect(crumbAbc.reachability).toBe("present");
    const projectA = result.projects.find((item) => item.id === id("project", root("project-a")));
    expect(
      projectA?.members.map((member) => [member.role, member.name, member.reachability]),
    ).toEqual([
      ["repository", null, "present"],
      ["worktree", "abc", "present"],
    ]);
    const live = unit(leaf);
    expect(live.rule).toBe("swept");
    expect(live.retention).toEqual({
      days: null,
      bytes: null,
      count: 25,
      source: "cursor.worktreeMaxCount",
    });
    expect(live.liveGuard).toEqual({ kind: "install-path", alive: true });
    expect(live.protection).toBe("live");
    expect(live.removal).toEqual({ method: "none" });
    // The worktree's own context files belong to the Project and cost a session started there.
    const rule = loadedBy("context-file", `${leaf}/.cursor/rules/always.mdc`);
    expect(rule.project).toBe(id("project", root("project-a")));
    expect(rule.reason).toBe("in linked worktree abc: loaded by sessions started there");
    expect(rule.countsTowardHeadline).toBe(false);
    expect(entity("context-file", `${leaf}/.cursor/rules/always.mdc`).relativePath).toBe(
      `../../home/.cursor/worktrees/project-a/abc/.cursor/rules/always.mdc`,
    );
    expect(entity("context-file", `${leaf}/AGENTS.md`).gitStatus).toBeNull();
  });

  it("gives every rule type its verdict and counts only alwaysApply and .cursorrules", () => {
    const always = loadedBy("context-file", root("project-a/.cursor/rules/always.mdc"));
    expect([always.mode, always.reason, always.countsTowardHeadline]).toEqual([
      "full",
      "alwaysApply: true — injected in every chat",
      true,
    ]);
    expect(always.tokensLoaded).toBeGreaterThan(0);
    const scoped = loadedBy("context-file", root("project-a/.cursor/rules/scoped.mdc"));
    expect([scoped.mode, scoped.reason, scoped.countsTowardHeadline]).toEqual([
      "on-demand",
      "globs-scoped rule: attached when matching files are in context",
      false,
    ]);
    expect([scoped.tokensLoaded, scoped.charsLoaded, scoped.order]).toEqual([0, 0, null]);
    const agent = loadedBy("context-file", root("project-a/.cursor/rules/agent.mdc"));
    expect([agent.mode, agent.reason, agent.countsTowardHeadline]).toEqual([
      "description-only",
      "description-only rule: the model pulls it in when relevant",
      false,
    ]);
    // A rule in a subfolder is a rule (research 02 [17]: rules are keyed by full path).
    const manual = loadedBy("context-file", root("project-a/.cursor/rules/sub/manual.mdc"));
    expect([manual.mode, manual.reason, manual.countsTowardHeadline]).toEqual([
      "manual",
      "manual rule: @-mentioned by the user",
      false,
    ]);
    for (const name of ["always", "scoped", "agent", "sub/manual"]) {
      const file = entity("context-file", root(`project-a/.cursor/rules/${name}.mdc`));
      expect(file.kind === "context-file" && file.form).toBe("rule");
      expect(file.format).toBe("mdc");
      expect(file.kind === "context-file" && file.importCount).toBe(0);
    }
    const legacy = loadedBy("context-file", root("project-a/.cursorrules"));
    expect([legacy.mode, legacy.confidence, legacy.countsTowardHeadline]).toEqual([
      "full",
      "low",
      true,
    ]);
    expect(entity("context-file", root("project-a/.cursorrules")).format).toBe("txt");
    const agents = loadedBy("context-file", root("project-a/AGENTS.md"));
    expect([agents.mode, agents.countsTowardHeadline]).toEqual(["full", true]);
    // The user rule is the baseline of every session (`project: null`).
    const userRule = loadedBy("context-file", home(".cursor/rules/user-rule.mdc"));
    expect([userRule.project, userRule.mode, userRule.countsTowardHeadline]).toEqual([
      null,
      "full",
      true,
    ]);
    expect(result.harnesses[0]?.userScope.baseline.items[0]?.entity).toBe(
      id("context-file", home(".cursor/rules/user-rule.mdc")),
    );
    const counted = result.edges.filter(
      (edge): edge is LoadedByEdge => edge.kind === "loaded-by" && edge.countsTowardHeadline,
    );
    const countedContext = counted
      .map((edge) => result.entities.find((item) => item.id === edge.from))
      .filter((item) => item?.kind === "context-file")
      .map((item) => relativeToTree(item?.path ?? ""));
    expect(countedContext.toSorted(byText)).toEqual([
      ".cursor/rules/user-rule.mdc",
      "API-NESTJS/AGENTS.md",
      "project-a/.cursor/rules/always.mdc",
      "project-a/.cursorrules",
      "project-a/AGENTS.md",
    ]);
  });

  it("reads the MCP entries at both scopes, with no shadows edge and no approval it cannot see", () => {
    const userStdio = entity("mcp-server", `${home(".cursor/mcp.json")}#mcpServers/server-stdio`);
    expect(userStdio.kind === "mcp-server" && userStdio.transport).toBe("stdio");
    expect(userStdio.kind === "mcp-server" && userStdio.envKeys).toEqual(["VAR_A"]);
    expect(userStdio.kind === "mcp-server" && userStdio.approval).toBe("not-applicable");
    expect(userStdio.sensitive).toBe(true);
    expect(userStdio.removal).toEqual({ method: "backup-edit" });
    const userHttp = entity("mcp-server", `${home(".cursor/mcp.json")}#mcpServers/server-url`);
    expect(userHttp.kind === "mcp-server" && userHttp.transport).toBe("http");
    expect(userHttp.kind === "mcp-server" && userHttp.headerKeys).toEqual(["Header-A"]);
    expect(userHttp.kind === "mcp-server" && userHttp.secretKeys).toEqual(["Header-A"]);
    expect(loadedBy("mcp-server", `${home(".cursor/mcp.json")}#mcpServers/server-url`).mode).toBe(
      "full",
    );
    const project = entity(
      "mcp-server",
      `${root("project-a/.cursor/mcp.json")}#mcpServers/server-stdio`,
    );
    expect(project.kind === "mcp-server" && project.transport).toBe("stdio");
    expect(project.kind === "mcp-server" && project.approval).toBe("unknown");
    expect(project.shared).toBeNull();
    const edge = loadedBy(
      "mcp-server",
      `${root("project-a/.cursor/mcp.json")}#mcpServers/server-stdio`,
    );
    expect(edge.mode).toBe("unknown");
    expect(edge.reason).toBe(
      "project scope: approval recorded in state.vscdb, which moldig never opens",
    );
    // D68: Cursor documents no precedence between a user and a project entry of the same name.
    expect(result.edges.some((item) => item.kind === "shadows")).toBe(false);
    expect(entity("settings-file", home(".cursor/mcp.json")).kind === "settings-file").toBe(true);
    const config = entity("settings-file", home(".cursor/mcp.json"));
    expect(config.kind === "settings-file" && config.entries).toBe(2);
    // D142: a settings file is never removable — its entries are edited out.
    expect(config.protection).toBe("never");
    expect(config.removal).toEqual({ method: "none" });
  });

  it("keeps one Skill per real directory, with a placement per path, and the bundled tier apart", () => {
    const real = entity("skill", home(".cursor/skills/web-design-guidelines"));
    expect(real.kind === "skill" && real.layout).toBe("copy");
    expect(real.kind === "skill" && real.placements).toEqual([
      {
        path: home(".cursor/skills/web-design-guidelines"),
        harness: "cursor",
        surface: null,
        scope: "user",
        project: null,
        gitStatus: "outside-repo",
        shared: null,
        isSymlink: false,
        linkTarget: null,
        dangling: false,
      },
    ]);
    // The symlink is a Cursor placement on the store's Skill, not a second entity.
    const shared = entity("skill", home(".agents/skills/find-skills"));
    expect(shared.harness).toBeNull();
    expect(shared.kind === "skill" && shared.layout).toBe("canonical");
    expect(shared.kind === "skill" && shared.placements.map((item) => item.harness)).toEqual([
      null,
      "cursor",
    ]);
    const link = shared.kind === "skill" ? shared.placements[1] : undefined;
    expect(link?.isSymlink).toBe(true);
    expect(link?.linkTarget).toBe("../../.agents/skills/find-skills");
    expect(loadedBy("skill", home(".agents/skills/find-skills")).mode).toBe("description-only");
    for (const name of ["create-rule", "migrate-to-skills"]) {
      const bundled = entity("skill", home(`.cursor/skills-cursor/${name}`));
      expect(bundled.ownership).toBe("harness");
      expect(bundled.protection).toBe("never");
      expect(bundled.removal).toEqual({ method: "none" });
      expect(bundled.kind === "skill" && bundled.layout).toBe("bundled");
      const edge = loadedBy("skill", home(`.cursor/skills-cursor/${name}`));
      expect([edge.mode, edge.project, edge.countsTowardHeadline]).toEqual([
        "description-only",
        null,
        true,
      ]);
    }
    const projectSkill = loadedBy("skill", root("project-a/.cursor/skills/skill-a"));
    expect(projectSkill.effectiveName).toBe("/skill-a");
    expect(projectSkill.project).toBe(id("project", root("project-a")));
    const command = entity("skill", root("project-a/.cursor/commands/command-a.md"));
    expect(command.kind === "skill" && command.form).toBe("command-file");
    expect(loadedBy("skill", root("project-a/.cursor/commands/command-a.md")).reason).toBe(
      "command file: listed as /command-a",
    );
    // D39: an agent definition is spawned on demand and never enters the Headline number.
    const agent = loadedBy("agent-definition", root("project-a/.cursor/agents/agent-a.md"));
    expect([agent.mode, agent.countsTowardHeadline, agent.confidence]).toEqual([
      "on-demand",
      false,
      "medium",
    ]);
    expect(
      entity("agent-definition", root("project-a/.cursor/agents/agent-a.md")).kind ===
        "agent-definition",
    ).toBe(true);
  });

  it("sizes the databases, the backup clone and the undocumented directories without opening them", () => {
    const database = unit(
      home(`Library/Application Support/Cursor/User/globalStorage/state.vscdb`),
    );
    // D104: `rule: kept` + `protection: never` + no removal — the row exists to show the bytes.
    expect([database.cacheKind, database.rule, database.protection]).toEqual([
      "database",
      "kept",
      "never",
    ]);
    expect(database.removal).toEqual({ method: "none" });
    expect(database.locator.type).toBe("paths");
    // The empty `-wal` sidecar is a member of the unit, never a unit of its own.
    expect(database.members.files).toBe(2);
    expect(
      unit(home(`Library/Application Support/Cursor/User/globalStorage/state.vscdb.backup`))
        .protection,
    ).toBe("never");
    const backup = unit(home(".cursor/mcp.json.backup"));
    expect([backup.cacheKind, backup.rule, backup.protection, backup.sensitive]).toEqual([
      "config-backup",
      "undocumented",
      "none",
      true,
    ]);
    expect(backup.metrics.ageDays).toBe(120);
    expect(backup.removal).toEqual({ method: "trash" });
    // D126: the per-project MCP cache is its own `mcp-cache` unit, stat only.
    const slug = `${rootSlug()}-api-nestjs`;
    expect(unit(slugDir(`${slug}/mcps`)).cacheKind).toBe("mcp-cache");
    expect(unit(slugDir(`${slug}/mcp-cache.json`)).cacheKind).toBe("mcp-cache");
    const slugUnit = unit(slugDir(slug));
    expect([slugUnit.cacheKind, slugUnit.rule, slugUnit.protection]).toEqual([
      "undocumented",
      "undocumented",
      "undocumented",
    ]);
    expect(slugUnit.slug).toBe(slug);
    // The transcripts are 45 days old and the MCP cache is subtracted from the directory.
    expect(slugUnit.metrics.ageDays).toBe(45);
    expect(slugUnit.metrics.files).toBe(2);
    const plans = unit(home(".cursor/plans"));
    expect([plans.cacheKind, plans.protection, plans.metrics.ageDays]).toEqual([
      "plan",
      "undocumented",
      90,
    ]);
    // D122: a size-only row carries no `userContent` flag — it has no checkbox to confirm.
    expect(plans.userContent).toBe(false);
    expect(unit(home(".cursor/ai-tracking")).protection).toBe("undocumented");
    expect(unit(home(".cursor/extensions")).protection).toBe("undocumented");
    expect(unit(home("Library/Application Support/Cursor/Workspaces")).protection).toBe(
      "undocumented",
    );
    // Ticket 08: nothing Cursor writes is ever preselected — no unit is swept by age.
    const cacheFindings = result.findings.filter((item) => item.category === "harness-cache");
    expect(cacheFindings.length).toBeGreaterThan(0);
    expect(cacheFindings.every((item) => !item.action.preselect)).toBe(true);
    expect(
      cacheFindings.every((item) => item.targets.every((target) => target.preselect !== true)),
    ).toBe(true);
    const units = result.entities.filter(
      (item): item is HarnessCache => item.kind === "harness-cache",
    );
    expect(result.totals.harnessCacheBytes).toBe(
      units.reduce((sum, item) => sum + item.metrics.bytes, 0),
    );
  });

  it("never opens a database: sizes and mtimes are untouched and no sidecar appears", () => {
    expect(databasesBefore.length).toBeGreaterThan(0);
    for (const before of databasesBefore) {
      const after = statSync(before.path);
      expect([before.path, after.size, after.mtimeMs]).toEqual([
        before.path,
        before.size,
        before.mtimeMs,
      ]);
    }
    // A `?mode=ro` open of a WAL database would create these next to it; `-wal` was already there.
    expect(databaseFiles(tree).toSorted(byText)).toEqual(
      databasesBefore.map((db) => db.path).toSorted(byText),
    );
    expect(existsSync(tree.path(`${GLOBAL_DB}-shm`))).toBe(false);
    expect(result.warnings.some((item) => item.code === "sqlite-unreadable")).toBe(false);
  });

  it("emits nothing at all on a machine with no trace of Cursor (D147)", async () => {
    // `shared/root-tree` carries an `AGENTS.md` and a `CLAUDE.md` but no `~/.cursor`, no
    // application-support tree and no `.cursor` at a Project root: no Harness row, no entity, no
    // verdict on a shared file for a harness no session can start.
    const bare = await loadFixture("shared/root-tree", { now: NOW, platform: PLATFORM });
    try {
      const index = await scan({
        home: bare.home,
        roots: bare.roots,
        cwd: bare.root,
        platform: PLATFORM,
        env: bare.env,
        git: false,
        now: NOW,
        harnesses: ["cursor"],
      });
      expect(index.harnesses).toEqual([]);
      expect(index.breadcrumbs).toEqual([]);
      // The shared stores adapter always runs (D21): the tree's `AGENTS.md` and its store are
      // still indexed, and none of it belongs to this harness or carries its verdict.
      expect(index.entities.every((item) => item.harness === null)).toBe(true);
      expect(index.edges.every((edge) => edge.to !== "harness:cursor")).toBe(true);
      expect(index.warnings.every((item) => item.harness !== "cursor")).toBe(true);
      expect(index.projects.every((item) => item.perHarness["cursor"] === undefined)).toBe(true);
    } finally {
      await bare.cleanup();
    }
  });

  it("matches the audit snapshot", async ({ skip }) => {
    // See `caseInsensitiveHost`: the case pair answers to the volume, not to `platform`.
    skip(!caseInsensitiveHost, "the committed snapshot is the case-insensitive-volume answer");
    const stable = normaliseSnapshot(result, tree);
    stable.scan.durationMs = 0;
    stable.moldig.version = "<VERSION>";
    await expect(stableTimes(formattedJson(stable) + "\n")).toMatchFileSnapshot(
      "./__snapshots__/workspaces.audit.json",
    );
  });
});
