/**
 * §7.4 bloat [D7; D81]: a context file, a rule or a memory index that costs tokens in every
 * session of a harness. One finding per entity, using the **maximum** `tokensLoaded` across its
 * readers; only `mode: "full"` edges count (on-demand, description-only, disabled, shadowed and
 * never-loaded verdicts cost a session nothing). A memory index the harness truncates is bloat
 * whatever the count, and the message names the portion that never reaches a session.
 *
 * The action is **always `open`**: bloat is advice, never a sweep, and rewriting the prose of a
 * context file is out of v1.
 */
import type { Entity, Finding, Index, LoadedByEdge } from "../index/types.js";
import { containerOf, flagsOf, harnessNameOf, harnessOf, loadedByOf } from "./shared.js";

/** D7: the two thresholds, in o200k tokens loaded in full. */
const MEDIUM_TOKENS = 2000;
const HIGH_TOKENS = 8000;

/** Context files, local files and rules; memory **indexes** only — a fact file is never bloat. */
function isCandidate(entity: Entity): boolean {
  return (
    entity.kind === "context-file" || (entity.kind === "memory-file" && entity.role === "index")
  );
}

/** `metrics.lines`/`metrics.bytes` beyond the cap the harness documents for its memory index. */
function truncationOf(index: Index, entity: Entity): string | null {
  if (entity.kind !== "memory-file" || entity.role !== "index") return null;
  const caps = harnessOf(index, entity.harness)?.caps;
  if (caps === undefined) return null;
  const overLines =
    caps.memoryIndexLines !== null && (entity.metrics.lines ?? 0) > caps.memoryIndexLines;
  const overBytes = caps.memoryIndexBytes !== null && entity.metrics.bytes > caps.memoryIndexBytes;
  if (!overLines && !overBytes) return null;
  const portion = entity.loadedPortion ?? {
    lines: caps.memoryIndexLines ?? 0,
    bytes: caps.memoryIndexBytes ?? 0,
  };
  const lines = Math.max(0, (entity.metrics.lines ?? 0) - portion.lines);
  const bytes = Math.max(0, entity.metrics.bytes - portion.bytes);
  return `${lines} lines / ${bytes} bytes never reach a session`;
}

function widestReader(index: Index, entityId: string): LoadedByEdge | null {
  let widest: LoadedByEdge | null = null;
  for (const edge of loadedByOf(index, entityId)) {
    if (edge.mode !== "full" || edge.tokensLoaded === null) continue;
    if (widest === null || edge.tokensLoaded > (widest.tokensLoaded ?? 0)) widest = edge;
  }
  return widest;
}

export function bloatFindings(index: Index): Finding[] {
  const out: Finding[] = [];
  for (const entity of index.entities) {
    if (!isCandidate(entity)) continue;
    const reader = widestReader(index, entity.id);
    const loaded =
      reader?.tokensLoaded ??
      (entity.kind === "memory-file" ? (entity.loadedPortion?.tokens ?? 0) : 0);
    const truncated = truncationOf(index, entity);
    if (loaded < MEDIUM_TOKENS && truncated === null) continue;
    // A file the shared stores own (an `AGENTS.md` several harnesses read) has no harness of its
    // own, so the widest reader names the cost; with no reader either, the sentence stays true
    // without naming anyone.
    const readerName =
      reader === null
        ? null
        : (index.harnesses.find((harness) => harness.id === reader.to)?.displayName ?? null);
    const harnessName = entity.harness === null ? readerName : harnessNameOf(index, entity.harness);
    const evidence: Finding["evidence"] = [];
    if (reader !== null) evidence.push({ kind: "loading-rule", detail: reader.reason });
    evidence.push({
      kind: "token-count",
      detail:
        harnessName === null
          ? `${loaded} o200k tokens loaded in full`
          : `${loaded} o200k tokens loaded in full by ${harnessName}`,
    });
    out.push({
      id: `finding:bloat:${entity.id}`,
      category: "bloat",
      severity: loaded >= HIGH_TOKENS ? "high" : "medium",
      container: containerOf(entity),
      targets: [{ id: entity.id, role: "subject" }],
      message: `${entity.label} costs ${loaded} tokens in every ${
        harnessName === null ? "session that loads it" : `${harnessName} session`
      }${truncated === null ? "" : ` (${truncated})`}`,
      evidence,
      // D81: a count that fell back to `bytes/4` is an estimate, not a measurement.
      confidence: entity.metrics.tokens?.method === "bytes/4" ? "medium" : "certain",
      impact: { bytes: entity.metrics.bytes, tokens: loaded, files: 1 },
      flags: flagsOf([entity]),
      action: { kind: "open", preselect: false, locator: entity.locator },
    });
  }
  return out;
}
