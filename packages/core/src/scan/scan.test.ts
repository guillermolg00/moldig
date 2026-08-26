import { afterEach, describe, expect, it } from "vitest";
import { scan, type ScanProgress } from "../index.js";
import { loadFixture, treePaths, type FixtureTree } from "../testing/index.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");
const trees: FixtureTree[] = [];

afterEach(async () => {
  await Promise.all(trees.splice(0).map((tree) => tree.cleanup()));
});

describe("scan", () => {
  it("survives git failing on the fixture's HEAD-only repository and degrades to gitStatus null", async () => {
    const tree = await loadFixture("claude-code/breadcrumbs", { cwd: "root/project-a", now: NOW });
    trees.push(tree);
    const index = await scan({
      home: tree.home,
      roots: tree.roots,
      cwd: tree.cwd,
      platform: tree.platform,
      env: tree.env,
      git: true,
      now: NOW,
    });
    const gitWarnings = index.warnings.filter((warning) => warning.code === "git-missing");
    expect(gitWarnings.length).toBeGreaterThan(0);
    // With git installed the fixture's HEAD-only `.git` makes `git ls-files` fail per repository.
    const perRepoWarning = gitWarnings.some((warning) => warning.path !== null);
    expect(perRepoWarning || !index.scan.git.available).toBe(true);
    const { home, root } = treePaths(tree);
    const projectFile = index.entities.find(
      (entity) => entity.path === root("project-a/CLAUDE.md"),
    );
    expect(projectFile?.gitStatus).toBeNull();
    expect(projectFile?.shared).toBeNull();
    const userFile = index.entities.find((entity) => entity.path === home(".claude/CLAUDE.md"));
    expect(userFile?.gitStatus).toBe("outside-repo");
    const memory = index.entities.find((entity) => entity.kind === "memory-file");
    expect(memory?.kind === "memory-file" && memory.readSignal.source).toBe("not-computed");
  });

  it("without a Root keeps the unreachable volume and the gone directory as Projects", async () => {
    // Ticket 06 §5/§7: a Root narrows the scan; without one every breadcrumb names a Project.
    const tree = await loadFixture("claude-code/breadcrumbs", {
      cwd: "root/project-a",
      now: NOW,
      platform: "darwin",
    });
    trees.push(tree);
    const index = await scan({
      home: tree.home,
      roots: [],
      cwd: tree.cwd,
      platform: "darwin",
      env: tree.env,
      git: false,
      now: NOW,
    });
    const volume = index.projects.find((project) => project.path === "/Volumes/Backup/old");
    expect(volume).toMatchObject({
      kind: "unknown",
      reachability: "unreachable",
      unreachableReason: "mount-root",
    });
    const volumeCrumb = index.breadcrumbs.find((crumb) => crumb.raw === "/Volumes/Backup/old");
    expect(volumeCrumb?.project).toBe(volume?.id);
    expect(volumeCrumb?.reachability).toBe("unreachable");
    const gone = index.projects.find((project) => project.path === treePaths(tree).root("gone"));
    expect(gone?.reachability).toBe("orphan");
    expect(index.projects.some((project) => project.path === tree.home)).toBe(false);
  });

  it("rejects a platform it does not scan instead of recording it as darwin (D125)", async () => {
    const tree = await loadFixture("shared/root-tree", { platform: "darwin" });
    trees.push(tree);
    await expect(
      scan({
        home: tree.home,
        roots: tree.roots,
        cwd: tree.root,
        // The CLI validates first (exit 2); the engine is the second line of defence, so the
        // assertion here stands in for a value the type system already rejects.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- D125: the runtime guard
        platform: "freebsd" as "linux",
        env: {},
        git: false,
        now: NOW,
      }),
    ).rejects.toThrow(/unsupported platform "freebsd"/);
  });

  it("fills Project.parent with the enclosing Project (D25)", async () => {
    // `root-tree` has no `home/`, so the walk and the cwd are the only discovery sources.
    const tree = await loadFixture("shared/root-tree", { platform: "darwin" });
    trees.push(tree);
    const index = await scan({
      home: tree.home,
      roots: tree.roots,
      cwd: tree.root,
      platform: "darwin",
      env: {},
      git: false,
      now: NOW,
    });
    const { root } = treePaths(tree);
    const monorepo = index.projects.find((project) => project.path === root("monorepo"));
    expect(monorepo?.parent).toBeNull();
    // Every Project the walk found sits directly under the Root: none has a parent yet.
    expect(index.projects.map((project) => project.parent)).toEqual(index.projects.map(() => null));
    // D26/D27: the walk registers neither the pruned nested repository nor the marker-less
    // detached worktree.
    const paths = index.projects.map((project) => project.path);
    expect(paths).not.toContain(root("monorepo/vendor/lib"));
    expect(paths).not.toContain(root("wt-detached"));
  });

  it("takes an injected live guard (D50)", async () => {
    const tree = await loadFixture("claude-code/breadcrumbs", { cwd: "root/project-a", now: NOW });
    trees.push(tree);
    const asked: number[] = [];
    const index = await scan({
      home: tree.home,
      roots: tree.roots,
      cwd: tree.cwd,
      platform: tree.platform,
      env: tree.env,
      git: false,
      now: NOW,
      isProcessAlive: (pid) => {
        asked.push(pid);
        return false;
      },
    });
    // The option is accepted and changes nothing about the shape of the index.
    expect(index.schemaVersion).toBe(0);
    expect(asked.every((pid) => Number.isInteger(pid))).toBe(true);
  });

  it("is deterministic across two scans of the same tree", async () => {
    const tree = await loadFixture("claude-code/breadcrumbs", { cwd: "root/project-a", now: NOW });
    trees.push(tree);
    const options = {
      home: tree.home,
      roots: tree.roots,
      cwd: tree.cwd,
      platform: tree.platform,
      env: tree.env,
      git: false,
      now: NOW,
    };
    const [first, second] = await Promise.all([scan(options), scan(options)]);
    expect(JSON.stringify({ ...first, scan: { ...first.scan, durationMs: 0 } })).toBe(
      JSON.stringify({ ...second, scan: { ...second.scan, durationMs: 0 } }),
    );
    expect(first.entities.map((entity) => entity.id)).toEqual(
      first.entities.map((entity) => entity.id).toSorted(),
    );
  });

  it("reports every phase through onProgress and produces the same index without it", async () => {
    // D145: the hook is additive. It is called synchronously, never awaited, and a scan that
    // does not pass one behaves identically — which is what the second scan here checks.
    const tree = await loadFixture("claude-code/breadcrumbs", { cwd: "root/project-a", now: NOW });
    trees.push(tree);
    const options = {
      home: tree.home,
      roots: tree.roots,
      cwd: tree.cwd,
      platform: tree.platform,
      env: tree.env,
      git: false,
      now: NOW,
    };
    const events: ScanProgress[] = [];
    const withHook = await scan({ ...options, onProgress: (event) => events.push(event) });
    const withoutHook = await scan(options);
    expect(JSON.stringify({ ...withHook, scan: { ...withHook.scan, durationMs: 0 } })).toBe(
      JSON.stringify({ ...withoutHook, scan: { ...withoutHook.scan, durationMs: 0 } }),
    );
    expect(new Set(events.map((event) => event.phase))).toEqual(
      new Set(["discover", "git", "collect", "assemble"]),
    );
    // Every adapter announces itself before it runs, and each phase ends on `done === total`.
    const collect = events.filter((event) => event.phase === "collect");
    expect(collect.map((event) => event.harness).filter((id) => id !== undefined)).toContain(
      "claude-code",
    );
    expect(collect.at(-1)).toEqual({
      phase: "collect",
      done: collect.length - 1,
      total: collect.length - 1,
    });
    expect(events.every((event) => event.done <= event.total)).toBe(true);
    // `git: false` runs no repository, and the phase still reports itself once.
    expect(events.filter((event) => event.phase === "git")).toEqual([
      { phase: "git", done: 0, total: 0 },
    ]);
  });
});
