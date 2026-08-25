/**
 * THROWAWAY PROTOTYPE — ticket 13 (ego-graph screen), folded into ticket 09.
 */
import { describe, expect, it } from "vitest";
import { buildEgoGraph, LEGEND_KINDS, MAX_HOPS, NEIGHBOURHOOD_CAP } from "./ego-graph.js";
import { contextFile, graphFixture, IDS, makeIndex, names, ROOT, skill } from "./fixture.js";

const ids = (graph: ReturnType<typeof buildEgoGraph>): string[] =>
  graph.neighbours.map((n) => n.node.id);

describe("buildEgoGraph — hop 1", () => {
  const graph = buildEgoGraph(graphFixture(), IDS.focus, 1);

  it("resolves the focus from the index", () => {
    expect(graph.focus).toMatchObject({
      id: IDS.focus,
      kind: "skill",
      label: "agent-browser",
      scope: "user",
      harness: null,
      shared: false,
    });
    expect(graph.hops).toBe(1);
  });

  it("lists the 8 hop-1 neighbours in legend order, outgoing first, then by label", () => {
    expect(ids(graph)).toEqual([
      IDS.projectClaudeMd, // names ← (high)
      IDS.userClaudeMd, // names ← (medium)
      `unresolved:edge:names-tool:${IDS.focus}::linear`, // names a tool → nothing
      IDS.posthog, // names a tool →
      IDS.claudeCode, // loaded by →
      IDS.cursor, // loaded by →
      IDS.copy, // duplicates →
      IDS.lock, // originates from →
    ]);
    expect(graph.neighbours.every((n) => n.hop === 1 && n.via === IDS.focus)).toBe(true);
    expect(graph.omitted).toBe(0);
  });

  it("carries direction, confidence and the loaded-by mode", () => {
    const byId = new Map(graph.neighbours.map((n) => [n.node.id, n]));
    expect(byId.get(IDS.projectClaudeMd)).toMatchObject({
      kind: "names",
      direction: "incoming",
      confidence: "high",
      mode: null,
    });
    expect(byId.get(IDS.userClaudeMd)?.confidence).toBe("medium");
    expect(byId.get(IDS.claudeCode)).toMatchObject({
      kind: "loaded-by",
      direction: "outgoing",
      mode: "description-only",
      node: { kind: "harness", label: "Claude Code", harness: "claude-code" },
    });
    expect(byId.get(IDS.cursor)?.mode).toBe("never");
    expect(byId.get(IDS.copy)).toMatchObject({ kind: "duplicates", confidence: "medium" });
  });

  it("marks flags: shared, dangling (incl. a tool configured nowhere)", () => {
    const byId = new Map(graph.neighbours.map((n) => [n.node.id, n.node]));
    expect(byId.get(IDS.projectClaudeMd)).toMatchObject({ shared: true, scope: "project" });
    expect(byId.get(`unresolved:edge:names-tool:${IDS.focus}::linear`)).toMatchObject({
      kind: "unresolved",
      label: "linear",
      dangling: true,
    });
  });

  it("counts the edges of the other kinds touching the shown nodes", () => {
    // imports (from CLAUDE.md), shadows (copy → focus), references (reviewer → focus)
    expect(graph.hiddenEdges).toBe(3);
  });
});

describe("buildEgoGraph — hop 2", () => {
  const graph = buildEgoGraph(graphFixture(), IDS.focus, 2);

  it("appends the hop-2 nodes after hop 1, deduplicated, never the focus", () => {
    expect(ids(graph).slice(0, 8)).toEqual(ids(buildEgoGraph(graphFixture(), IDS.focus, 1)));
    expect(ids(graph).slice(8)).toEqual([IDS.memory, IDS.plugin, IDS.dangling]);
    expect(new Set(ids(graph)).size).toBe(ids(graph).length);
    expect(ids(graph)).not.toContain(IDS.focus);
  });

  it("records where each hop-2 node came from", () => {
    const hop2 = graph.neighbours.filter((n) => n.hop === 2);
    expect(hop2.every((n) => n.via === IDS.claudeCode && n.direction === "incoming")).toBe(true);
    expect(hop2.map((n) => n.mode)).toEqual(["full", "full", "never"]);
    expect(hop2.map((n) => n.node.live)).toEqual([false, true, false]);
    expect(hop2.map((n) => n.node.dangling)).toEqual([false, false, true]);
  });

  it("counts one more hidden edge once the memory index is shown (lists → fact)", () => {
    expect(graph.hiddenEdges).toBe(4);
  });

  it("clamps hops to 1..MAX_HOPS", () => {
    expect(buildEgoGraph(graphFixture(), IDS.focus, 9).hops).toBe(MAX_HOPS);
    expect(buildEgoGraph(graphFixture(), IDS.focus, 0).hops).toBe(1);
    expect(buildEgoGraph(graphFixture(), IDS.focus, Number.NaN).hops).toBe(1);
  });
});

describe("buildEgoGraph — legend filter", () => {
  it("never follows imports, shadows, references or lists, at any hop", () => {
    for (const hops of [1, 2]) {
      const graph = buildEgoGraph(graphFixture(), IDS.focus, hops);
      const legend: readonly string[] = LEGEND_KINDS;
      expect(graph.neighbours.every((n) => legend.includes(n.kind))).toBe(true);
      expect(ids(graph)).not.toContain(IDS.agentsMd); // only reachable through imports
      expect(ids(graph)).not.toContain(IDS.reviewer); // only reachable through references
      expect(ids(graph)).not.toContain(IDS.fact); // only reachable through lists
    }
  });

  it("gives a harness focus its readers (incoming loaded-by)", () => {
    const graph = buildEgoGraph(graphFixture(), IDS.claudeCode, 1);
    expect(graph.focus.kind).toBe("harness");
    expect(ids(graph)).toEqual([
      IDS.projectClaudeMd,
      IDS.memory,
      IDS.focus,
      IDS.plugin,
      IDS.dangling,
    ]);
    expect(
      graph.neighbours.every((n) => n.kind === "loaded-by" && n.direction === "incoming"),
    ).toBe(true);
  });

  it("gives a project focus the loaded-by verdicts that hold for it", () => {
    const graph = buildEgoGraph(graphFixture(), IDS.vlue, 1);
    expect(graph.focus).toMatchObject({ kind: "project", label: "vlue" });
    expect(ids(graph)).toEqual([IDS.projectClaudeMd, IDS.memory, IDS.focus]);
    expect(graph.neighbours.map((n) => n.mode)).toEqual(["full", "full", "never"]);
  });

  it("returns an empty neighbourhood for an id the index does not know", () => {
    const graph = buildEgoGraph(graphFixture(), "skill:nowhere", 2);
    expect(graph.focus).toMatchObject({ kind: "unknown", label: "skill:nowhere" });
    expect(graph.neighbours).toEqual([]);
    expect(graph.hiddenEdges).toBe(0);
  });
});

describe("buildEgoGraph — cap", () => {
  it(`keeps ${NEIGHBOURHOOD_CAP} neighbours and counts the rest`, () => {
    const focus = skill(IDS.focus, `${ROOT}/x/.claude/skills/agent-browser`);
    const files = Array.from({ length: NEIGHBOURHOOD_CAP + 10 }, (_, i) =>
      contextFile(
        `context-file:${ROOT}/p${i}/claude.md`,
        `${ROOT}/p${String(i).padStart(2, "0")}/CLAUDE.md`,
      ),
    );
    const index = makeIndex({
      entities: [focus, ...files],
      edges: files.map((f) => names(f.id, IDS.focus)),
    });
    const graph = buildEgoGraph(index, IDS.focus, 1);
    expect(graph.neighbours).toHaveLength(NEIGHBOURHOOD_CAP);
    expect(graph.omitted).toBe(10);
  });
});
