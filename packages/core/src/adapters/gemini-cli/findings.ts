/**
 * The Orphan-style findings only this adapter can file, because no general detector can see them.
 *
 * D84: a `GEMINI.md` carrying the legacy `## Gemini Added Memories` heading holds memory the
 * harness wrote into a human-owned context file. Index v0 has no section locator, so the row can
 * only point at the file and the action is `open` — moldig shows it and never edits it.
 *
 * `audit` wires the harness adapters' own finding builders (it already imports Claude Code's);
 * this export is the Gemini one.
 */
import type { ContextFile, Finding, Index } from "../../index/types.js";
import { HARNESS, HARNESS_ID } from "./paths.js";

export function geminiFindings(index: Index): Finding[] {
  const out: Finding[] = [];
  for (const entity of index.entities) {
    if (entity.kind !== "context-file" || entity.harness !== HARNESS) continue;
    const file: ContextFile = entity;
    if (!file.containsMemorySection) continue;
    out.push({
      id: `finding:shadow-memory:${file.id}`,
      category: "shadow-memory",
      severity: "low",
      container: file.project ?? HARNESS_ID,
      targets: [{ id: file.id, role: "subject", preselect: false }],
      message: `${file.label} carries a legacy "## Gemini Added Memories" section: memory the harness wrote into a context file you own`,
      evidence: [
        {
          kind: "body-mention",
          detail: "## Gemini Added Memories",
          locator: file.locator,
        },
      ],
      confidence: "certain",
      impact: { bytes: file.metrics.bytes, tokens: file.metrics.tokens?.o200k ?? null, files: 1 },
      flags: ["memory"],
      // v0 has no section locator: the row opens the file, it never edits it.
      action: { kind: "open", preselect: false, locator: file.locator },
    });
  }
  return out.toSorted((a, b) => a.id.localeCompare(b.id));
}
