/**
 * §7.3 duplicate [D79; D133]: the same skill or MCP server present in more than one place as
 * distinct copies. Connected components of the `duplicates` edges the adapters emit, one finding
 * per component, the member with the lowest id as subject.
 *
 * **Context files never file a duplicate finding** — the glossary scopes Duplicate to skills and
 * MCP servers — but their `duplicates` edges stay and feed the graph [D79]. MCP servers sharing
 * an `endpointKey` **do** file one: 07 Q2's "sameness = edge only" settled identity, not findings
 * [D133]. Copies are never merged: the action is `open` and each copy keeps its own scope.
 */
import type { Confidence, Entity, Finding, Index } from "../index/types.js";
import { containerOf, flagsOf, scopeOf } from "./shared.js";

type Same = "content" | "origin" | "endpoint" | "name";

/** The most precise statement a component can make, when its edges disagree. */
const SAME_RANK: readonly Same[] = ["content", "origin", "endpoint", "name"];

/** D79: how much a given kind of sameness is worth as evidence. */
const SAME_CONFIDENCE: Record<Same, Confidence> = {
  content: "certain",
  origin: "high",
  endpoint: "high",
  name: "medium",
};

class Components {
  private readonly parent = new Map<string, string>();

  find(id: string): string {
    const seen = this.parent.get(id);
    if (seen === undefined || seen === id) {
      this.parent.set(id, id);
      return id;
    }
    const root = this.find(seen);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB)
      this.parent.set(rootA < rootB ? rootB : rootA, rootA < rootB ? rootA : rootB);
  }
}

export function duplicateFindings(index: Index): Finding[] {
  const byId = new Map(index.entities.map((entity) => [entity.id, entity]));
  const components = new Components();
  const same = new Map<string, Same>();
  const confidence = new Map<string, Confidence>();
  for (const edge of index.edges) {
    if (edge.kind !== "duplicates") continue;
    components.union(edge.from, edge.to);
  }
  const members = new Map<string, string[]>();
  for (const edge of index.edges) {
    if (edge.kind !== "duplicates") continue;
    const root = components.find(edge.from);
    const list = members.get(root) ?? [];
    if (!list.includes(edge.from)) list.push(edge.from);
    if (!list.includes(edge.to)) list.push(edge.to);
    members.set(root, list);
    const known = same.get(root);
    if (known === undefined || SAME_RANK.indexOf(edge.same) < SAME_RANK.indexOf(known))
      same.set(root, edge.same);
    // The finding is only as strong as the weakest edge that put the component together.
    const weakest = confidence.get(root);
    const order: Confidence[] = ["certain", "high", "medium", "low"];
    if (weakest === undefined || order.indexOf(edge.confidence) > order.indexOf(weakest))
      confidence.set(root, edge.confidence);
  }

  const out: Finding[] = [];
  for (const [root, ids] of members) {
    const copies = ids
      .map((id) => byId.get(id))
      .filter((entity): entity is Entity => entity !== undefined)
      .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const subject = copies[0];
    if (subject === undefined) continue;
    // D79: skills and MCP servers only — a duplicated context file keeps its edge and no finding.
    if (subject.kind !== "skill" && subject.kind !== "mcp-server") continue;
    const sameness = same.get(root) ?? "name";
    const counterparts = copies.slice(1);
    const label = subject.kind === "mcp-server" ? `MCP server ${subject.label}` : subject.label;
    const places = [...new Set(copies.map((entity) => scopeOf(index, entity)))];

    const evidence: Finding["evidence"] = [];
    if (sameness === "content") evidence.push({ kind: "content-hash", detail: "identical bytes" });
    else if (sameness === "endpoint")
      evidence.push({
        kind: "endpoint",
        detail: subject.kind === "mcp-server" ? subject.endpointKey : "the same endpoint",
      });
    else if (sameness === "origin")
      for (const copy of copies) {
        if (copy.kind !== "skill" || copy.origin === null) continue;
        evidence.push({ kind: "lock-entry", detail: copy.name, locator: copy.origin.lock });
      }
    else evidence.push({ kind: "name-only", detail: subject.label });

    out.push({
      id: `finding:duplicate:${subject.id}`,
      category: "duplicate",
      severity: "low",
      container: containerOf(subject),
      targets: copies.map((entity, position) => ({
        id: entity.id,
        role: position === 0 ? ("subject" as const) : ("counterpart" as const),
      })),
      message:
        sameness === "content"
          ? `${subject.label} has the same content as ${counterparts.map((entity) => entity.label).join(", ")}`
          : `${label} is configured ${copies.length} times with the same ${sameness} (${places.join(", ")})`,
      evidence,
      confidence:
        sameness === "endpoint" ? (confidence.get(root) ?? "high") : SAME_CONFIDENCE[sameness],
      // §7.1: for duplicates only the counterparts count — the subject is the copy that stays.
      impact: {
        bytes: counterparts.reduce((sum, entity) => sum + entity.metrics.bytes, 0),
        tokens: null,
        files: counterparts.reduce((sum, entity) => sum + (entity.metrics.files ?? 0), 0),
      },
      flags: flagsOf(copies),
      action: { kind: "open", preselect: false, locator: subject.locator },
    });
  }
  return out.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
