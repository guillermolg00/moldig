import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { audit, dataDirFor, scan, type AuditIndex } from "@moldig/core";
import { loadFixture, type FixtureTree } from "@moldig/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeExecutors } from "../../executors/fake.js";
import { ensureDirFor } from "../../executors/files.js";
import { projectCleanup } from "./projects.js";
import { createRunner, withExtraConfirmation } from "./runner.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");
let tree: FixtureTree;
let index: AuditIndex;

async function readIndex(on: FixtureTree = tree): Promise<AuditIndex> {
  return audit(
    await scan({
      home: on.home,
      roots: [...on.roots],
      cwd: on.cwd,
      platform: "darwin",
      env: on.env,
      git: false,
      now: NOW,
    }),
  );
}

beforeEach(async () => {
  tree = await loadFixture("claude-code/breadcrumbs", {
    cwd: "root/project-a",
    platform: "darwin",
    now: NOW,
  });
  index = await readIndex();
});

afterEach(async () => {
  await tree.cleanup();
});

describe("Project-level cleanup", () => {
  it("deletes a missing Project as two harness-store targets, then it disappears on refresh", async () => {
    const gone = index.projects.find((project) => project.reachability === "orphan");
    if (gone === undefined) throw new Error("fixture has no missing Project");
    const cleanup = projectCleanup(index, new Set([gone.id]));

    expect(cleanup.projectCount).toBe(1);
    expect(cleanup.breadcrumbCount).toBe(2);
    expect(cleanup.selection).toHaveLength(2);
    expect(cleanup.selection.some((target) => target.locator?.type === "paths")).toBe(true);
    expect(cleanup.selection.some((target) => target.locator?.type === "entry")).toBe(true);
    expect(cleanup.selection.every((target) => target.id === undefined)).toBe(true);

    const fake = createFakeExecutors({
      trashDir: join(tree.dir, "fake-trash"),
      now: NOW,
      move: true,
    });
    const runner = createRunner({
      index,
      executors: fake.executors,
      deviceOf: () => ({ dev: 1, kind: "local" }),
      dataDir: dataDirFor({ platform: "darwin", env: {}, home: tree.home }),
      platform: "darwin",
      home: tree.home,
      version: "0.0.0",
      command: "moldig",
      prepare: (runPlan) => ensureDirFor(runPlan.manifestPath),
    });
    const runPlan = withExtraConfirmation(
      runner.planSelection(cleanup.selection),
      "complete state for the selected missing projects",
    );
    expect(runPlan.groups).toHaveLength(1);
    expect(runPlan.groups[0]?.extraConfirmation).toEqual({
      required: true,
      reason: "complete state for the selected missing projects",
    });

    const manifest = await runner.apply(runPlan, () => Promise.resolve("run"));
    expect(manifest.rows.map((row) => row.result.status).toSorted()).toEqual(["edited", "moved"]);
    expect(fake.trashed).toHaveLength(1);
    expect(fake.trashed[0]).toHaveLength(1);
    expect(fake.trashed[0]?.[0]).toContain("/.claude/projects/");
    expect(fake.trashed.flat().some((path) => path.endsWith("topic-gone.md"))).toBe(false);

    const refreshed = await readIndex();
    expect(refreshed.projects.some((project) => project.id === gone.id)).toBe(false);
    expect(refreshed.projects.some((project) => project.displayName === "project-a")).toBe(true);

    const edited = manifest.rows.find((row) => row.result.status === "edited");
    const backup = edited?.target.backupPaths[0];
    expect(backup).toBeDefined();
    expect(existsSync(backup ?? "")).toBe(true);
    const original: unknown = JSON.parse(await readFile(backup ?? "", "utf8"));
    expect(original).toMatchObject({ projects: { [gone.path]: expect.any(Object) } });
  }, 60_000);

  it.each([
    "codex/trust-and-state",
    "copilot/trust-and-sessions",
    "cursor/workspaces",
    "gemini-cli/from-docs",
    "opencode/db-and-config",
  ])(
    "removes every missing Project in %s through its native breadcrumb stores",
    async (fixture) => {
      const other = await loadFixture(fixture, { platform: "darwin", now: NOW });
      try {
        const before = await readIndex(other);
        const missing = before.projects.filter((project) => project.reachability === "orphan");
        expect(missing.length).toBeGreaterThan(0);
        const cleanup = projectCleanup(before, new Set(missing.map((project) => project.id)));
        expect(cleanup.blocked).toEqual([]);
        const fake = createFakeExecutors({
          trashDir: join(other.dir, "fake-trash"),
          now: NOW,
          move: true,
        });
        const runner = createRunner({
          index: before,
          executors: fake.executors,
          deviceOf: () => ({ dev: 1, kind: "local" }),
          dataDir: dataDirFor({ platform: "darwin", env: {}, home: other.home }),
          platform: "darwin",
          home: other.home,
          version: "0.0.0",
          command: "moldig",
          prepare: (runPlan) => ensureDirFor(runPlan.manifestPath),
        });
        const manifest = await runner.apply(
          withExtraConfirmation(
            runner.planSelection(cleanup.selection),
            "complete state for the selected missing projects",
          ),
          () => Promise.resolve("run"),
        );
        expect(
          manifest.rows.filter(
            (row) => row.result.status === "failed" || row.result.status === "refused",
          ),
        ).toEqual([]);
        const after = await readIndex(other);
        expect(after.projects.filter((project) => project.reachability === "orphan")).toEqual([]);
        expect(fake.trashed.length).toBeLessThanOrEqual(1);
      } finally {
        await other.cleanup();
      }
    },
    60_000,
  );
});
