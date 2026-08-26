/**
 * §7.5 orphan [D11; D84; D111]: a configured item nothing references, or whose target no longer
 * exists on disk. Two of the five rules are index-wide and live here — a Project whose directory
 * is gone, and a `names-tool` edge nothing resolves. The three that need a lock, a registry or a
 * settings key open those files themselves and live in the adapter that owns them
 * (`claudeOrphanFindings`); an unreachable target never produces an orphan at all.
 */
import type { Entity, Finding, Index, NamesToolEdge } from "../index/types.js";
import { isCleanable, isPreselected } from "./harness-cache.js";
import { containerOf, flagsOf, harnessNameOf, plural } from "./shared.js";

/**
 * D111: swept and undocumented cache and memory get `action: "clean"`; the `kept` state a gone
 * Project left behind is listed with `action: "delete"`, and never enters a clean group.
 */
function cleanableState(state: Entity[]): Entity[] {
  return state.filter(
    (entity) =>
      entity.kind === "memory-file" || (entity.kind === "harness-cache" && isCleanable(entity)),
  );
}

function goneProjectFindings(index: Index): Finding[] {
  const out: Finding[] = [];
  for (const project of index.projects) {
    if (project.reachability !== "orphan") continue;
    const crumbs = index.breadcrumbs.filter((crumb) => crumb.project === project.id);
    const state = index.entities.filter(
      (entity) =>
        entity.project === project.id &&
        entity.ownership === "harness" &&
        entity.protection === "none",
    );
    const targets: Finding["targets"] = [
      // Breadcrumb entries are informational in v1: they carry no preselect at all.
      ...crumbs.map((crumb) => ({ id: crumb.id, role: "breadcrumb" as const })),
      ...state.map((entity) => ({
        id: entity.id,
        role: "state" as const,
        preselect: entity.kind === "harness-cache" ? isPreselected(entity) : false,
      })),
    ];
    const evidence: Finding["evidence"] = [{ kind: "path-missing", detail: project.path }];
    for (const crumb of crumbs) {
      const lastSessionId = crumb.refs.lastSessionId;
      if (lastSessionId === undefined) continue;
      const known = index.entities.some(
        (entity) => entity.kind === "harness-cache" && entity.session === lastSessionId,
      );
      if (!known)
        evidence.push({
          kind: "breadcrumb-ref",
          detail: `lastSessionId ${lastSessionId} names a transcript that exists in no slug directory`,
        });
    }
    const memory = state.filter((entity) => entity.kind === "memory-file");
    const cache = state.filter((entity) => entity.kind === "harness-cache");
    const parts: string[] = [plural(crumbs.length, "breadcrumb")];
    if (memory.length > 0) parts.push(plural(memory.length, "memory file"));
    if (cache.length > 0) parts.push(plural(cache.length, "harness cache unit"));
    const harnesses = [...new Set(crumbs.map((crumb) => crumb.harness))].map((id) =>
      harnessNameOf(index, id),
    );
    const cleanable = cleanableState(state);
    const kept = state.filter((entity) => !cleanable.includes(entity));
    const action: Finding["action"] =
      cleanable.length > 0
        ? {
            kind: "clean",
            preselect: cleanable.some(
              (entity) => entity.kind === "harness-cache" && isPreselected(entity),
            ),
            locator: null,
          }
        : kept.length > 0
          ? { kind: "delete", preselect: false, locator: null }
          : { kind: "none", preselect: false, locator: null };
    out.push({
      id: `finding:orphan:${project.id}`,
      category: "orphan",
      severity: "medium",
      container: project.id,
      targets,
      message: `${project.displayName}: directory gone; ${parts.join(", ")} left behind by ${harnesses.join(", ") || "a harness"}`,
      evidence,
      confidence: "certain",
      impact: {
        bytes: state.reduce((sum, entity) => sum + entity.metrics.bytes, 0),
        tokens:
          memory.length > 0
            ? memory.reduce((sum, entity) => sum + (entity.metrics.tokens?.o200k ?? 0), 0)
            : null,
        files: state.reduce((sum, entity) => sum + (entity.metrics.files ?? 0), 0),
      },
      flags: flagsOf(state),
      action,
    });
  }
  return out;
}

/**
 * §7.5 rule 4: a context file or skill that names an MCP server or tool configured for no
 * harness. The weakest rule of the eight — a name nothing resolves — so `low` twice over.
 */
function namesNothingFindings(index: Index): Finding[] {
  const byId = new Map(index.entities.map((entity) => [entity.id, entity]));
  const out: Finding[] = [];
  const edges = index.edges.filter(
    (edge): edge is NamesToolEdge => edge.kind === "names-tool" && edge.to === null,
  );
  for (const edge of edges) {
    const entity = byId.get(edge.from);
    if (entity === undefined) continue;
    out.push({
      id: `finding:orphan:${entity.id}:${edge.tool}`,
      category: "orphan",
      severity: "low",
      container: containerOf(entity),
      targets: [{ id: entity.id, role: "subject" }],
      message: `${entity.label} names the MCP server ${edge.tool}, which is configured for no harness`,
      evidence: [{ kind: "name-only", detail: edge.evidence[0]?.detail ?? edge.tool }],
      confidence: "low",
      impact: {
        bytes: entity.metrics.bytes,
        tokens: null,
        files: entity.metrics.files ?? 0,
      },
      flags: flagsOf([entity]),
      action: { kind: "open", preselect: false, locator: entity.locator },
    });
  }
  return out;
}

export function orphanFindings(index: Index): Finding[] {
  return [...goneProjectFindings(index), ...namesNothingFindings(index)];
}
