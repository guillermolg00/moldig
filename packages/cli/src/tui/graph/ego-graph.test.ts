/**
 * The pure ego-graph builder (ticket 13): the five legend kinds, the deterministic order, the
 * `MAX_HOPS` clamp and the 60-neighbour cap. Over the real fixture index and over a synthetic
 * index wide enough to reach the cap.
 */
import { audit, scan, type AuditIndex, type Edge } from "@moldig/core";
import { loadFixture, type FixtureTree } from "@moldig/core/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildEgoGraph, LEGEND_KINDS, MAX_HOPS, NEIGHBOURHOOD_CAP } from "./ego-graph.js";
import { LAYOUTS, renderLayout, textWidth } from "./layouts.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");
let tree: FixtureTree;
let index: AuditIndex;

beforeAll(async () => {
  tree = await loadFixture("claude-code/breadcrumbs", {
    cwd: "root/project-a",
    now: NOW,
    platform: "darwin",
  });
  const scanned = await scan({
    home: tree.home,
    roots: [...tree.roots],
    cwd: tree.cwd,
    platform: "darwin",
    env: tree.env,
    git: false,
    now: NOW,
  });
  index = await audit(scanned);
}, 60_000);

afterAll(async () => {
  await tree.cleanup();
});

function harnessNode(): string {
  const harness = index.harnesses[0]?.id;
  if (harness === undefined) throw new Error("no harness in the fixture index");
  return harness;
}

describe("buildEgoGraph over the fixture", () => {
  it("resolves the focus and keeps only the legend kinds", () => {
    const graph = buildEgoGraph(index, harnessNode(), 1);
    expect(graph.focus).toMatchObject({ kind: "harness", label: "Claude Code" });
    expect(graph.hops).toBe(1);
    for (const neighbour of graph.neighbours) {
      expect(LEGEND_KINDS).toContain(neighbour.kind);
      expect(neighbour.hop).toBe(1);
    }
    // `shadows` and `imports` never draw a node; they are counted in the footer instead.
    expect(graph.hiddenEdges).toBeGreaterThan(0);
  });

  it("is deterministic: the same index always yields the same order", () => {
    const once = buildEgoGraph(index, harnessNode(), 2).neighbours.map((n) => n.node.id);
    const twice = buildEgoGraph(index, harnessNode(), 2).neighbours.map((n) => n.node.id);
    expect(once).toEqual(twice);
    expect(new Set(once).size).toBe(once.length); // one node per id: first reach wins
  });

  it("clamps the hops to 1..MAX_HOPS", () => {
    expect(buildEgoGraph(index, harnessNode(), 0).hops).toBe(1);
    expect(buildEgoGraph(index, harnessNode(), 9).hops).toBe(MAX_HOPS);
    expect(buildEgoGraph(index, harnessNode(), Number.NaN).hops).toBe(1);
  });

  it("shows a Project's verdicts as incoming hop-1 neighbours", () => {
    const project = index.headline.focus.project ?? "";
    const graph = buildEgoGraph(index, project, 1);
    expect(graph.focus.kind).toBe("project");
    expect(graph.neighbours.length).toBeGreaterThan(0);
    for (const neighbour of graph.neighbours) {
      expect(neighbour.kind).toBe("loaded-by");
      expect(neighbour.direction).toBe("incoming");
    }
  });

  it("both layouts fit their width and their height", () => {
    const graph = buildEgoGraph(index, harnessNode(), 2);
    for (const layout of LAYOUTS) {
      const lines = renderLayout(layout, graph, { width: 80, height: 15, selectedId: null });
      expect(lines.length).toBeLessThanOrEqual(15);
      for (const line of lines) {
        const width = line.segments.reduce((sum, segment) => sum + textWidth(segment.text), 0);
        expect(width).toBeLessThanOrEqual(80);
      }
    }
  });
});

describe("the neighbourhood cap", () => {
  /** One skill named by 70 context files: more hop-1 neighbours than the cap allows. */
  function wideIndex(): AuditIndex {
    const edges: Edge[] = [];
    const entities = [...index.entities];
    const skill = entities.find((entity) => entity.kind === "skill");
    if (skill === undefined) throw new Error("no skill in the fixture index");
    const context = entities.find((entity) => entity.kind === "context-file");
    if (context === undefined) throw new Error("no context file in the fixture index");
    for (let i = 0; i < 70; i++) {
      const id = `context-file:/synthetic/${String(i).padStart(3, "0")}.md`;
      entities.push({ ...context, id, path: id, label: `synthetic-${String(i).padStart(3, "0")}` });
      edges.push({
        id: `edge:names:${id}:${skill.id}`,
        kind: "names",
        from: id,
        to: skill.id,
        confidence: "high",
        evidence: [{ kind: "body-mention" }],
      });
    }
    return { ...index, entities, edges };
  }

  it("caps the neighbourhood at 60 and counts the rest", () => {
    const wide = wideIndex();
    const skill = wide.entities.find((entity) => entity.kind === "skill");
    const graph = buildEgoGraph(wide, skill?.id ?? "", 1);
    expect(graph.neighbours).toHaveLength(NEIGHBOURHOOD_CAP);
    expect(graph.omitted).toBe(10);
  });

  it("still fits 24 rows when the cap is reached", () => {
    const wide = wideIndex();
    const skill = wide.entities.find((entity) => entity.kind === "skill");
    const graph = buildEgoGraph(wide, skill?.id ?? "", 1);
    // The graph screen keeps 24 rows minus its own chrome for the body.
    const lines = renderLayout("columns", graph, { width: 80, height: 15, selectedId: null });
    expect(lines.length).toBeLessThanOrEqual(15);
  });
});
