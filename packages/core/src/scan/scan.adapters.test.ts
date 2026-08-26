/**
 * D127: an adapter may return no Harness at all — the adapter of the stores several harnesses
 * share emits entities (`harness: null`) but is not a harness. Both registered adapters are
 * stubbed here (the real shared-stores adapter always runs, D21) so `scan` runs over exactly one
 * such output.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Adapter, AdapterOutput } from "../adapters/adapter.js";
import type { ContextFile } from "../index/types.js";
import { loadFixture, treePaths, type FixtureTree } from "../testing/index.js";

const sharedOnly = vi.hoisted(() => ({ output: null as AdapterOutput | null }));

const emptyOutput = (): AdapterOutput => ({
  harness: null,
  breadcrumbs: [],
  entities: [],
  edges: [],
  projectFacts: new Map(),
});

vi.mock("../adapters/claude-code/index.js", () => ({
  createClaudeCodeAdapter: (): Adapter => ({
    id: "claude-code",
    discover: () => Promise.resolve(),
    collect: () => Promise.resolve(sharedOnly.output ?? emptyOutput()),
  }),
}));

vi.mock("../adapters/shared/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../adapters/shared/index.js")>()),
  createSharedAdapter: (): Adapter => ({
    id: "shared",
    discover: () => Promise.resolve(),
    collect: () => Promise.resolve(emptyOutput()),
  }),
}));

const { scan } = await import("./scan.js");

const NOW = new Date("2026-08-26T12:00:00.000Z");
const trees: FixtureTree[] = [];

afterEach(async () => {
  await Promise.all(trees.splice(0).map((tree) => tree.cleanup()));
  sharedOnly.output = null;
});

function sharedContextFile(path: string, project: string): ContextFile {
  return {
    id: `context-file:${path.toLowerCase()}`,
    kind: "context-file",
    harness: null,
    producer: null,
    project,
    scope: "project",
    ownership: "human",
    shared: null,
    gitStatus: null,
    path,
    relativePath: "AGENTS.md",
    locator: { type: "file", path },
    format: "md",
    label: "AGENTS.md",
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: {
      bytes: 20,
      files: 1,
      lines: 2,
      mtime: null,
      ageDays: null,
      tokens: null,
      lastUsed: null,
    },
    form: "context",
    fileName: "AGENTS.md",
    frontmatter: {},
    importCount: 0,
    containsMemorySection: false,
  };
}

describe("scan with an adapter that has no Harness (D127)", () => {
  it("files no harnesses[] row and no perHarness entry, and still lands its entities", async () => {
    const tree = await loadFixture("shared/root-tree", { platform: "darwin" });
    trees.push(tree);
    const { root, id } = treePaths(tree);
    const path = root("monorepo/AGENTS.md");
    const projectId = id("project", root("monorepo"));
    sharedOnly.output = {
      harness: null,
      breadcrumbs: [],
      entities: [sharedContextFile(path, projectId)],
      edges: [],
      projectFacts: new Map([[projectId, { trusted: true, effectiveSettings: { a: 1 } }]]),
    };

    const index = await scan({
      home: tree.home,
      roots: tree.roots,
      cwd: tree.root,
      platform: "darwin",
      env: {},
      git: false,
      now: NOW,
    });

    expect(index.harnesses).toEqual([]);
    expect(index.entities.map((entity) => entity.path)).toEqual([path]);
    expect(index.totals.entities).toBe(1);
    const monorepo = index.projects.find((project) => project.id === projectId);
    expect(monorepo).toBeDefined();
    expect(monorepo?.perHarness).toEqual({});
  });
});
