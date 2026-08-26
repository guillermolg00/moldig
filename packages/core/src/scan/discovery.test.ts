import { afterEach, describe, expect, it } from "vitest";
import type { Warning } from "../index/types.js";
import { loadFixture, type FixtureTree } from "../testing/index.js";
import {
  aggregateSessionCwds,
  createDiscovery,
  markersIn,
  unresolvedTarget,
  type Discovery,
} from "./discovery.js";
import { realpathOrSelf } from "./fs.js";
import { pathIdentity, presenceOf } from "./paths.js";

const trees: FixtureTree[] = [];

afterEach(async () => {
  await Promise.all(trees.splice(0).map((tree) => tree.cleanup()));
});

interface Harness {
  discovery: Discovery;
  warnings: Warning[];
  tree: FixtureTree;
}

/** Discovery over `shared/root-tree` — the case that exists to exercise these rules. */
async function rootTree(
  roots?: (tree: FixtureTree) => string[],
  statDeadlineMs = 2000,
): Promise<Harness> {
  const tree = await loadFixture("shared/root-tree", { platform: "darwin" });
  trees.push(tree);
  const warnings: Warning[] = [];
  const discovery = createDiscovery({
    home: tree.home,
    roots: roots === undefined ? [...tree.roots] : roots(tree),
    cwd: tree.root,
    platform: "darwin",
    identity: pathIdentity("darwin"),
    statDeadlineMs,
    warn: (warning) => warnings.push(warning),
  });
  return { discovery, warnings, tree };
}

describe("discovery: Roots", () => {
  it("selects a Project whole when the Root sits inside it (D24)", async () => {
    // `roots: [<ROOT>/monorepo/apps]` — the Project directory is the monorepo, above the Root.
    const { discovery, tree } = await rootTree((item) => [item.path("root/monorepo/apps")]);
    const located = await discovery.locate(tree.path("root/monorepo"), "breadcrumb");
    expect(located.outsideRoots).toBe(false);
    expect(located.project?.path).toBe(tree.path("root/monorepo"));
    // A breadcrumb below the Root folds into the same Project, with its relative path.
    const nested = await discovery.locate(tree.path("root/monorepo/apps/web"), "breadcrumb");
    expect(nested.project?.id).toBe(located.project?.id);
    expect(nested.relativePath).toBe("apps/web");
  });

  it("still drops a Project that neither lies under a Root nor encloses one (D24)", async () => {
    const { discovery, tree } = await rootTree((item) => [item.path("root/monorepo/apps")]);
    const located = await discovery.locate(tree.path("root/plain-with-markers"), "breadcrumb");
    expect(located.outsideRoots).toBe(true);
    expect(located.project).toBeNull();
    expect(discovery.projects()).toHaveLength(0);
  });
});

describe("discovery: the marker walk", () => {
  it("prunes vendor/, so a nested repository is a Project only when a breadcrumb names it (D26)", async () => {
    const { discovery, tree } = await rootTree();
    await discovery.walkRoots();
    const vendored = tree.path("root/monorepo/vendor/lib");
    expect(discovery.projects().map((project) => project.path)).not.toContain(vendored);
    // A breadcrumb reaches it: the nearest `.git` wins and it becomes its own Project.
    const located = await discovery.locate(vendored, "breadcrumb");
    expect(located.project?.path).toBe(vendored);
    expect(located.project?.kind).toBe("repository");
  });

  it("never treats `.git` alone as a marker: wt-detached needs a breadcrumb (D27)", async () => {
    const { discovery, tree } = await rootTree();
    await discovery.walkRoots();
    const detached = tree.path("root/wt-detached");
    expect(await markersIn(detached)).toEqual([]);
    expect(discovery.projects().map((project) => project.path)).not.toContain(detached);
    const located = await discovery.locate(detached, "breadcrumb");
    expect(located.project?.kind).toBe("detached-worktree");
  });

  it("records nested markers, stops at skills, prunes and honours the depth limit", async () => {
    const { discovery, tree } = await rootTree();
    await discovery.walkRoots();
    const monorepo = discovery.projects().find((p) => p.path === tree.path("root/monorepo"));
    expect(monorepo?.nestedMarkers.map((marker) => marker.relativePath).toSorted()).toEqual([
      "apps/api/AGENTS.md",
      "apps/web/CLAUDE.md",
      "packages/ui/.cursor",
    ]);
    // `node_modules/`, `dist/` and the depth-7 file are never reported.
    for (const marker of monorepo?.nestedMarkers ?? []) {
      expect(marker.relativePath).not.toContain("node_modules");
      expect(marker.relativePath).not.toContain("dist/");
    }
    const paths = discovery.projects().map((project) => project.path);
    expect(paths).toContain(tree.path("root/plain-with-markers"));
    expect(paths).toContain(tree.path("root/wt-main"));
    expect(paths).not.toContain(tree.path("root/bare"));
    expect(paths).not.toContain(tree.path("root/deep/1/2/3/4/5/6/7"));
  });

  it("does not follow the directory symlink, so link-to-monorepo is not walked", async () => {
    const { discovery, tree } = await rootTree();
    await discovery.walkRoots();
    // The link's target carries markers, so only `walkDir`'s symlink filter can explain the
    // absence of a second Project — the walk never enters it.
    expect((await markersIn(tree.path("root/link-to-monorepo"))).length).toBeGreaterThan(0);
    expect(discovery.projects().map((project) => project.path)).not.toContain(
      tree.path("root/link-to-monorepo"),
    );
    // Located explicitly, realpath folds it onto the same Project (a separate rule, 06 §2).
    const located = await discovery.locate(tree.path("root/link-to-monorepo"), "breadcrumb");
    expect(located.project?.path).toBe(tree.path("root/monorepo"));
  });

  it("adds a linked worktree as a member and keeps the stale registration as an orphan", async () => {
    const { discovery, tree } = await rootTree();
    await discovery.walkRoots();
    const main = discovery.projects().find((p) => p.path === tree.path("root/wt-main"));
    const members = (main?.members ?? []).map((member) => ({
      role: member.role,
      name: member.name,
      reachability: member.reachability,
    }));
    expect(members).toContainEqual({ role: "worktree", name: "feature", reachability: "present" });
    expect(members).toContainEqual({ role: "worktree", name: "dead", reachability: "orphan" });
  });
});

describe("discovery: re-folding and gone paths", () => {
  it("re-folds a gone subdirectory located before its repository existed (D28)", async () => {
    const { discovery, tree } = await rootTree();
    // Located first, when nothing is registered: it becomes a gone Project of its own.
    const located = await discovery.locate(tree.path("root/monorepo/gone-sub"), "breadcrumb");
    expect(located.project?.kind).toBe("unknown");
    expect(located.project?.path).toBe(tree.path("root/monorepo/gone-sub"));

    await discovery.walkRoots();
    await discovery.includeCwd();
    await discovery.refold();

    // The same object the adapter is holding now names the repository.
    expect(located.project?.path).toBe(tree.path("root/monorepo"));
    expect(located.relativePath).toBe("gone-sub");
    expect(located.reachability).toBe("orphan");
    expect(discovery.projects().map((project) => project.path)).not.toContain(
      tree.path("root/monorepo/gone-sub"),
    );
  });

  it("keeps a gone path that folds into nothing as a Project of its own", async () => {
    const { discovery, tree } = await rootTree();
    const located = await discovery.locate(tree.path("root/never-existed"), "breadcrumb");
    await discovery.walkRoots();
    await discovery.refold();
    expect(located.project?.kind).toBe("unknown");
    expect(located.project?.reachability).toBe("orphan");
    expect(located.project?.path).toBe(tree.path("root/never-existed"));
  });
});

describe("discovery: what a breadcrumb can name", () => {
  it("folds a breadcrumb naming a file through its parent directory (D32)", async () => {
    const { discovery, tree } = await rootTree();
    const located = await discovery.locate(tree.path("root/monorepo/CLAUDE.md"), "breadcrumb");
    expect(located.project?.path).toBe(tree.path("root/monorepo"));
    expect(located.relativePath).toBe("CLAUDE.md");
    // A present file is never `orphan`: Orphan means the target is gone.
    expect(located.reachability).toBe("present");
    expect(located.strayReason).toBeNull();
  });

  it("makes a file in a bare directory Stray, never an orphan (D32)", async () => {
    const { discovery, tree } = await rootTree();
    const located = await discovery.locate(tree.path("root/bare/README.md"), "breadcrumb");
    expect(located.project).toBeNull();
    expect(located.strayReason).toBe("bare-directory");
    expect(located.reachability).toBe("present");
  });

  it("makes a bare directory Stray (ticket 06 §4)", async () => {
    const { discovery, tree } = await rootTree();
    const located = await discovery.locate(tree.path("root/bare"), "breadcrumb");
    expect(located.project).toBeNull();
    expect(located.strayReason).toBe("bare-directory");
  });

  it("gives a record that names no folder a path of null and a stray reason (D31)", () => {
    expect(unresolvedTarget(null)).toEqual({
      path: null,
      project: null,
      resolution: "unresolved",
      strayReason: "unresolved-slug",
      reachability: "orphan",
      remote: false,
    });
  });

  it("calls a record naming a remote scheme unreachable (D31)", () => {
    for (const raw of ["vscode-remote://wsl+ubuntu/home/x", "ssh://host/srv/project"]) {
      expect(unresolvedTarget(raw)).toMatchObject({ reachability: "unreachable", remote: true });
    }
    // A `file:` URI is not remote: it names a folder on this machine.
    expect(unresolvedTarget("file:///tmp/project")).toMatchObject({
      reachability: "orphan",
      remote: false,
    });
  });
});

describe("discovery: the stat deadline", () => {
  it("emits the stat-deadline warning it detects (D36)", async () => {
    const { discovery, warnings, tree } = await rootTree(undefined, 0);
    const located = await discovery.locate(tree.path("root/monorepo"), "breadcrumb");
    expect(located.reachability).toBe("unreachable");
    expect(located.project?.unreachableReason).toBe("stat-timeout");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "stat-deadline",
      harness: null,
      path: tree.path("root/monorepo"),
      effect: "partial",
    });
    expect(warnings[0]?.message).toContain("passed the 0 ms deadline");
    // One warning per path, however many times it is located.
    await discovery.locate(tree.path("root/monorepo"), "breadcrumb");
    expect(warnings).toHaveLength(1);
  });
});

describe("discovery on win32 (paths are strings; no real drive needed)", () => {
  it("calls an absent drive letter unreachable through the mount-root rule (D35)", async () => {
    const presence = await presenceOf("D:\\proj\\app", "win32", 2000, realpathOrSelf);
    expect(presence).toEqual({ kind: "unreachable", reason: "mount-root" });
    const share = await presenceOf("\\\\server\\share\\proj", "win32", 2000, realpathOrSelf);
    expect(share).toEqual({ kind: "unreachable", reason: "mount-root" });
  });

  it("keeps a POSIX ghost an orphan, so the rule is about mount roots and not about win32", async () => {
    const { tree } = await rootTree();
    const presence = await presenceOf(
      tree.path("root/never-existed"),
      "darwin",
      2000,
      realpathOrSelf,
    );
    expect(presence).toEqual({ kind: "orphan" });
  });

  it("folds `\\` and `/` to one identity on win32, and neither on linux (D141)", () => {
    const win = pathIdentity("win32");
    expect(win.fold("C:\\Users\\X\\Work")).toBe("c:/users/x/work");
    expect(win.same("C:\\Users\\X\\Work", "c:/users/x/work")).toBe(true);
    const linux = pathIdentity("linux");
    expect(linux.fold("/home/X/Work")).toBe("/home/X/Work");
    expect(linux.same("/home/x/work", "/home/X/Work")).toBe(false);
    // darwin folds case but keeps separators: a backslash is a legal file name character there.
    const darwin = pathIdentity("darwin");
    expect(darwin.fold("/Users/X/a\\b")).toBe("/users/x/a\\b");
  });
});

describe("aggregateSessionCwds (D30)", () => {
  const fold = pathIdentity("linux").fold;

  it("emits one entry per distinct path with count, first and last", () => {
    const aggregated = aggregateSessionCwds(
      [
        { path: "/w/a", first: "2026-08-01T00:00:00Z", last: "2026-08-02T00:00:00Z", source: "s1" },
        { path: "/w/b", first: "2026-07-01T00:00:00Z", last: "2026-07-01T00:00:00Z", source: "s2" },
        { path: "/w/a", first: "2026-08-03T00:00:00Z", last: "2026-08-09T00:00:00Z", source: "s3" },
        { path: "/w/a", first: null, last: null, source: "s4" },
      ],
      fold,
    );
    expect(aggregated).toEqual([
      {
        path: "/w/a",
        occurrences: { count: 3, first: "2026-08-01T00:00:00Z", last: "2026-08-09T00:00:00Z" },
        newestSource: "s3",
        sources: ["s1", "s3", "s4"],
      },
      {
        path: "/w/b",
        occurrences: { count: 1, first: "2026-07-01T00:00:00Z", last: "2026-07-01T00:00:00Z" },
        newestSource: "s2",
        sources: ["s2"],
      },
    ]);
  });

  it("groups two spellings of one directory when the platform folds case", () => {
    const aggregated = aggregateSessionCwds(
      [
        { path: "/W/API-Nestjs", source: "row-1" },
        { path: "/w/api-nestjs", source: "row-2" },
      ],
      pathIdentity("darwin").fold,
    );
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]?.path).toBe("/W/API-Nestjs");
    expect(aggregated[0]?.occurrences.count).toBe(2);
  });

  it("is sorted by folded path, so two scans produce the same order", () => {
    const order = (paths: string[]): string[] =>
      aggregateSessionCwds(
        paths.map((path) => ({ path, source: path })),
        fold,
      ).map((item) => item.path);
    expect(order(["/w/c", "/w/a", "/w/b"])).toEqual(["/w/a", "/w/b", "/w/c"]);
    expect(order(["/w/b", "/w/c", "/w/a"])).toEqual(["/w/a", "/w/b", "/w/c"]);
  });
});
