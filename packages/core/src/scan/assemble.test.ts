import { afterEach, describe, expect, it } from "vitest";
import type { AdapterOutput } from "../adapters/adapter.js";
import type { Edge, Harness, HarnessId, Placement, Skill } from "../index/types.js";
import { loadFixture, type FixtureTree } from "../testing/index.js";
import { mergeOutputs, parentIdOf } from "./assemble.js";
import { createDiscovery } from "./discovery.js";
import { pathIdentity } from "./paths.js";

const fold = pathIdentity("darwin").fold;
const trees: FixtureTree[] = [];

afterEach(async () => {
  await Promise.all(trees.splice(0).map((tree) => tree.cleanup()));
});

function harnessRow(id: HarnessId, ownDir: string): Harness {
  return {
    id: `harness:${id}`,
    harness: id,
    displayName: id,
    surfaces: ["cli"],
    presence: "installed",
    version: null,
    effectiveModel: null,
    modelFamily: null,
    contextWindowTokens: null,
    capabilities: {
      memoryLocation: "none",
      memoryReadSignal: "not-applicable",
      contextFileNames: [],
      sweepDocumented: false,
    },
    caps: {
      memoryIndexLines: null,
      memoryIndexBytes: null,
      chainMaxBytes: null,
      skillDescriptionChars: null,
      importDepth: null,
    },
    effectiveSettings: {},
    breadcrumbSources: [],
    userScope: {
      paths: [{ path: ownDir, role: "data", source: "default", envVar: null }],
      stray: [],
      baseline: { items: [], tokens: 0 },
    },
  };
}

function placement(path: string, harness: HarnessId | null): Placement {
  return {
    path,
    harness,
    surface: "cli",
    scope: "user",
    project: null,
    gitStatus: "outside-repo",
    shared: null,
    isSymlink: true,
    linkTarget: "../../.agents/skills/agent-browser",
    dangling: false,
  };
}

/** One Skill, as one adapter sees it. `path` is the real directory: the id folds it. */
function skill(options: {
  realPath: string;
  harness: HarnessId | null;
  label: string;
  layout: Skill["layout"];
  placements: Placement[];
}): Skill {
  return {
    id: `skill:${fold(options.realPath)}`,
    kind: "skill",
    harness: options.harness,
    producer: null,
    project: null,
    scope: "user",
    ownership: "human",
    shared: null,
    gitStatus: "outside-repo",
    path: options.realPath,
    relativePath: null,
    locator: { type: "dir", path: options.realPath },
    format: "dir",
    label: options.label,
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: {
      bytes: 10,
      files: 1,
      lines: null,
      mtime: null,
      ageDays: null,
      tokens: null,
      lastUsed: null,
    },
    form: "skill-dir",
    name: "agent-browser",
    dirName: "agent-browser",
    frontmatterName: "agent-browser",
    layout: options.layout,
    placements: options.placements,
    frontmatter: {},
    sidecars: [],
    contentHash: [],
    origin: null,
    drift: "unknown",
  };
}

function output(harness: Harness | null, entities: Skill[], edges: Edge[] = []): AdapterOutput {
  return { harness, breadcrumbs: [], entities, edges, projectFacts: new Map() };
}

const CANONICAL = "/home/u/.agents/skills/agent-browser";

describe("mergeOutputs (D38)", () => {
  it("makes two adapters' view of one Skill a single entity with both placements", () => {
    const claude = output(harnessRow("claude-code", "/home/u/.claude"), [
      skill({
        realPath: CANONICAL,
        harness: "claude-code",
        label: "agent-browser (claude)",
        layout: "synced",
        placements: [placement("/home/u/.claude/skills/agent-browser", "claude-code")],
      }),
    ]);
    const codex = output(harnessRow("codex", "/home/u/.codex"), [
      skill({
        realPath: CANONICAL,
        harness: "codex",
        label: "agent-browser (codex)",
        layout: "copy",
        placements: [placement("/home/u/.codex/skills/agent-browser", "codex")],
      }),
    ]);

    const merged = mergeOutputs([claude, codex], fold);

    expect(merged.entities).toHaveLength(1);
    const [entity] = merged.entities;
    expect(entity?.kind === "skill" && entity.placements.map((item) => item.path)).toEqual([
      "/home/u/.claude/skills/agent-browser",
      "/home/u/.codex/skills/agent-browser",
    ]);
  });

  it("takes the scalars from the shared store, which owns `~/.agents/**`", () => {
    const harnessView = output(harnessRow("claude-code", "/home/u/.claude"), [
      skill({
        realPath: CANONICAL,
        harness: "claude-code",
        label: "seen through Claude Code",
        layout: "copy",
        placements: [placement("/home/u/.claude/skills/agent-browser", "claude-code")],
      }),
    ]);
    // D127: the shared-stores adapter emits entities without a Harness row of its own.
    const store = output(null, [
      skill({
        realPath: CANONICAL,
        harness: null,
        label: "agent-browser",
        layout: "canonical",
        placements: [placement(CANONICAL, null)],
      }),
    ]);

    // The order of the adapters must not decide the answer.
    for (const outputs of [
      [harnessView, store],
      [store, harnessView],
    ]) {
      const [entity] = mergeOutputs(outputs, fold).entities;
      expect(entity).toMatchObject({ harness: null, label: "agent-browser" });
      expect(entity?.kind === "skill" && entity.layout).toBe("canonical");
      expect(entity?.kind === "skill" && entity.placements).toHaveLength(2);
    }
  });

  it("falls back to the adapter whose own directory holds the real path", () => {
    const own = "/home/u/.claude/skills/local-only";
    const owner = output(harnessRow("claude-code", "/home/u/.claude"), [
      skill({
        realPath: own,
        harness: "claude-code",
        label: "owned by Claude Code",
        layout: "copy",
        placements: [placement(own, "claude-code")],
      }),
    ]);
    const visitor = output(harnessRow("codex", "/home/u/.codex"), [
      skill({
        realPath: own,
        harness: "codex",
        label: "seen by Codex",
        layout: "copy",
        placements: [placement("/home/u/.codex/skills/local-only", "codex")],
      }),
    ]);
    const [entity] = mergeOutputs([visitor, owner], fold).entities;
    expect(entity?.label).toBe("owned by Claude Code");
  });

  it("unions the edges, writing an edge two adapters justify exactly once", () => {
    const edge: Edge = {
      id: "edge:provided-by:skill:x:plugin:p",
      kind: "provided-by",
      from: "skill:x",
      to: "plugin:p",
      confidence: "certain",
      evidence: [],
    };
    const merged = mergeOutputs(
      [
        output(harnessRow("claude-code", "/home/u/.claude"), [], [edge]),
        output(harnessRow("codex", "/home/u/.codex"), [], [{ ...edge }]),
      ],
      fold,
    );
    expect(merged.edges).toHaveLength(1);
  });

  it("is deterministic: the same outputs merge to the same JSON twice", () => {
    const outputs = [
      output(harnessRow("claude-code", "/home/u/.claude"), [
        skill({
          realPath: CANONICAL,
          harness: "claude-code",
          label: "a",
          layout: "synced",
          placements: [placement("/home/u/.claude/skills/agent-browser", "claude-code")],
        }),
      ]),
      output(harnessRow("codex", "/home/u/.codex"), [
        skill({
          realPath: CANONICAL,
          harness: "codex",
          label: "b",
          layout: "copy",
          placements: [placement("/home/u/.codex/skills/agent-browser", "codex")],
        }),
      ]),
    ];
    expect(JSON.stringify(mergeOutputs(outputs, fold))).toBe(
      JSON.stringify(mergeOutputs(outputs, fold)),
    );
  });
});

describe("parentIdOf (D25)", () => {
  it("links a nested repository to the Project that encloses it", async () => {
    const tree = await loadFixture("shared/root-tree", { platform: "darwin" });
    trees.push(tree);
    const discovery = createDiscovery({
      home: tree.home,
      roots: [...tree.roots],
      cwd: tree.root,
      platform: "darwin",
      identity: pathIdentity("darwin"),
      statDeadlineMs: 2000,
      warn: () => {},
    });
    await discovery.walkRoots();
    // D26: `vendor/` is pruned, so the nested repository arrives through a breadcrumb.
    await discovery.locate(tree.path("root/monorepo/vendor/lib"), "breadcrumb");
    const projects = discovery.projects();
    const nested = projects.find((p) => p.path === tree.path("root/monorepo/vendor/lib"));
    const monorepo = projects.find((p) => p.path === tree.path("root/monorepo"));

    expect(nested).toBeDefined();
    expect(parentIdOf(nested!, projects, fold)).toBe(monorepo?.id);
    // The enclosing Project has no parent of its own, and nothing is its own parent.
    expect(parentIdOf(monorepo!, projects, fold)).toBeNull();
  });
});
