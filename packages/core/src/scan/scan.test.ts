import { afterEach, describe, expect, it } from "vitest";
import { scan } from "../index.js";
import { loadFixture, type FixtureTree } from "../testing/index.js";

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
    const projectFile = index.entities.find(
      (entity) => entity.path === `${tree.root}/project-a/CLAUDE.md`,
    );
    expect(projectFile?.gitStatus).toBeNull();
    expect(projectFile?.shared).toBeNull();
    const userFile = index.entities.find(
      (entity) => entity.path === `${tree.home}/.claude/CLAUDE.md`,
    );
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
    const gone = index.projects.find((project) => project.path === `${tree.root}/gone`);
    expect(gone?.reachability).toBe("orphan");
    expect(index.projects.some((project) => project.path === tree.home)).toBe(false);
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
});
