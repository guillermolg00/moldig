/**
 * Copilot's breadcrumbs (ticket 06 §1): the `trusted_folders[]` of `~/.copilot/config.json`
 * (trust entries are breadcrumbs), the `cwd` of every `session-state/<uuid>/workspace.yaml`,
 * and VS Code's `workspaceStorage/<id>/workspace.json` records. D30 aggregates the session
 * source: **one breadcrumb per distinct path**, with `occurrences {count, first, last}` filled
 * and the locator pointing at the newest session file that named it — never one row per session.
 *
 * The sources moldig does not read in v1 (VS Code's `state.vscdb` recents and trust model, and
 * `storage.json`'s path maps) are still listed on the harness with `readInV1: false` (D29).
 */
import type { Breadcrumb } from "../../index/types.js";
import { aggregateSessionCwds, type SessionCwdRecord } from "../../scan/discovery.js";
import { isUnder } from "../../scan/paths.js";
import { HARNESS, type CopilotScan, type SessionRecord } from "./model.js";
import { workspacePathOf } from "./records.js";

interface CrumbInput {
  locatorText: string;
  kind: Breadcrumb["kind"];
  raw: string;
  recordedForm: Breadcrumb["recordedForm"];
  located: SessionRecord["located"];
  resolution: Breadcrumb["resolution"];
  locator: Breadcrumb["locator"];
  occurrences: Breadcrumb["occurrences"];
  refs: Breadcrumb["refs"];
  state: string[];
  /** D31: a record that names no folder at all is Stray whatever the path resolution said. */
  strayReason?: Breadcrumb["strayReason"];
  reachability?: Breadcrumb["reachability"];
}

function crumb(scan: CopilotScan, input: CrumbInput): Breadcrumb {
  const { located } = input;
  return {
    id: `breadcrumb:${HARNESS}:${scan.ctx.identity.fold(input.locatorText)}`,
    harness: HARNESS,
    kind: input.kind,
    raw: input.raw,
    recordedForm: input.recordedForm,
    path: located?.path ?? null,
    resolution: input.resolution,
    project: located?.project?.id ?? null,
    strayReason:
      input.strayReason ??
      located?.strayReason ??
      (input.resolution === "unresolved" ? "unresolved-slug" : null),
    relativePathInProject: located?.relativePath ?? null,
    reachability: input.reachability ?? located?.reachability ?? "orphan",
    locator: input.locator,
    occurrences: input.occurrences,
    refs: input.refs,
    state: input.state,
  };
}

const ONCE: Breadcrumb["occurrences"] = { count: 1, first: null, last: null };

/** The `harness-cache` unit ids whose path lies under `dir` (a session or storage directory). */
function stateUnder(scan: CopilotScan, dir: string): string[] {
  const fold = scan.ctx.identity.fold;
  return [...scan.entities.values()]
    .filter((entity) => entity.kind === "harness-cache" && isUnder(fold(entity.path), fold(dir)))
    .map((entity) => entity.id)
    .toSorted();
}

export function collectBreadcrumbs(scan: CopilotScan): void {
  for (const entry of scan.trust) {
    scan.breadcrumbs.push(
      crumb(scan, {
        locatorText: `${scan.config.path}#trusted_folders/${entry.raw}`,
        kind: "trust-entry",
        raw: entry.raw,
        recordedForm: "path",
        located: entry.located,
        resolution: "direct",
        locator: {
          type: "array-value",
          file: scan.config.path,
          format: "json",
          keyPath: ["trusted_folders"],
          value: entry.raw,
        },
        occurrences: ONCE,
        refs: {},
        // A trust entry has no state of its own: `config.json` is never edited.
        state: [],
      }),
    );
  }

  const records: SessionCwdRecord<SessionRecord>[] = scan.sessions
    .filter((session) => session.cwd !== null && session.located !== null)
    .map((session) => ({
      path: session.cwd ?? "",
      first: session.createdAt,
      last: session.updatedAt,
      source: session,
    }));
  for (const group of aggregateSessionCwds(records, scan.ctx.identity.fold)) {
    const newest = group.newestSource;
    const state = group.sources
      .map((session) => scan.ctx.id("harness-cache", session.dir))
      .filter((id) => scan.entities.has(id))
      .toSorted();
    scan.breadcrumbs.push(
      crumb(scan, {
        locatorText: `${scan.paths.sessionState}#cwd/${group.path}`,
        kind: "session-cwd",
        raw: group.path,
        recordedForm: "path",
        located: newest.located,
        resolution: "direct",
        // D30: the locator points at the newest session file that named this path.
        locator: { type: "entry", file: newest.file, format: "yaml", keyPath: ["cwd"] },
        occurrences: group.occurrences,
        refs: { lastSessionId: newest.id },
        state,
      }),
    );
  }

  for (const record of scan.workspaces) {
    const path = workspacePathOf(record);
    const unresolved = record.raw === null || path === null;
    scan.breadcrumbs.push(
      crumb(scan, {
        locatorText: record.file,
        kind: "workspace-record",
        raw: record.raw ?? "",
        recordedForm:
          record.raw !== null && /^[A-Za-z][\w+.-]*:\/\//.test(record.raw) ? "file-uri" : "path",
        located: unresolved ? null : record.located,
        resolution: unresolved ? "unresolved" : "direct",
        locator: { type: "entry", file: record.file, format: "json", keyPath: ["folder"] },
        occurrences: ONCE,
        refs: { workspaceStorageId: record.storageId },
        state: stateUnder(scan, record.dir),
        ...(unresolved
          ? {
              strayReason: "unresolved-slug" as const,
              reachability: record.remote ? ("unreachable" as const) : ("orphan" as const),
            }
          : {}),
      }),
    );
  }

  scan.breadcrumbs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
