/**
 * §7.7 shadow-memory: memory files kept outside the Project they describe — under the harness's
 * own user scope, not git-tracked, invisible from the repository. One finding per memory unit,
 * the index first and the facts after it, never preselected.
 *
 * D84 files one more finding under this category: a legacy `## Gemini Added Memories` section
 * inside a context file, which is memory a harness wrote into a file a human owns. It is `low`
 * and `open` — index v0 has no locator for a section, so moldig shows it and touches nothing.
 */
import type { ContextFile, Finding, Index, MemoryFile } from "../index/types.js";
import { containerOf, displayNameOf, flagsOf, harnessNameOf, plural } from "./shared.js";

function unitFindings(index: Index): Finding[] {
  const units = new Map<string, MemoryFile[]>();
  for (const entity of index.entities) {
    if (entity.kind !== "memory-file" || entity.scope !== "user") continue;
    if (entity.owner.startsWith("agent:")) continue;
    // Shadow memory describes a Project (CONTEXT.md); a stray unit (the home directory's
    // memory) describes none: it is listed under the user scope, not filed here.
    if (entity.project === null) continue;
    units.set(entity.unit, [...(units.get(entity.unit) ?? []), entity]);
  }
  const out: Finding[] = [];
  for (const [unit, files] of units) {
    const sorted = files.toSorted((a, b) =>
      a.role === "index" ? -1 : b.role === "index" ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const projectId = sorted[0]?.project ?? null;
    const container = projectId ?? `harness:${sorted[0]?.harness ?? "unknown"}`;
    const tokens = sorted.reduce((sum, file) => sum + (file.metrics.tokens?.o200k ?? 0), 0);
    const neverRead = sorted.filter((file) => file.neverRead === true).length;
    const where = `invisible from ${displayNameOf(index, projectId)}`;
    const readNote = sorted.some((file) => file.readSignal.source === "transcript-tool-use")
      ? `; ${plural(neverRead, "fact")} never read`
      : "";
    out.push({
      id: `finding:shadow-memory:${sorted[0]?.id ?? unit}`,
      category: "shadow-memory",
      severity: "medium",
      container,
      targets: sorted.map((file) => ({ id: file.id, role: "subject" as const, preselect: false })),
      message: `1 memory unit (${plural(sorted.length, "file")}, ${tokens} tokens) kept under ${harnessNameOf(index, sorted[0]?.harness ?? null)}'s user scope, ${where}${readNote}`,
      evidence: [
        {
          kind: "loading-rule",
          detail: `auto-memory unit ${unit} lives under the harness's user scope, not in the repository`,
        },
      ],
      confidence: "certain",
      impact: {
        bytes: sorted.reduce((sum, file) => sum + file.metrics.bytes, 0),
        tokens,
        files: sorted.length,
      },
      flags: ["memory"],
      action: { kind: "clean", preselect: false, locator: null },
    });
  }
  return out;
}

/** D84: the legacy section a harness appended to a context file instead of a memory unit. */
function memorySectionFindings(index: Index): Finding[] {
  const files = index.entities.filter(
    (entity): entity is ContextFile =>
      entity.kind === "context-file" && entity.containsMemorySection,
  );
  return files.map((entity) => ({
    id: `finding:shadow-memory:${entity.id}`,
    category: "shadow-memory" as const,
    severity: "low" as const,
    container: containerOf(entity),
    targets: [{ id: entity.id, role: "subject" as const }],
    message: `${entity.label} carries a legacy "## Gemini Added Memories" section, loaded with the file in every ${harnessNameOf(index, entity.harness)} session`,
    evidence: [
      {
        kind: "loading-rule",
        detail: "the harness appended memory to a context file instead of its memory unit",
      },
    ],
    confidence: "certain" as const,
    impact: {
      bytes: entity.metrics.bytes,
      tokens: entity.metrics.tokens?.o200k ?? null,
      files: 1,
    },
    flags: flagsOf([entity]),
    action: { kind: "open" as const, preselect: false, locator: entity.locator },
  }));
}

export function shadowMemoryFindings(index: Index): Finding[] {
  return [...unitFindings(index), ...memorySectionFindings(index)];
}
