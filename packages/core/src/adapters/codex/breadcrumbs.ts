/**
 * Codex's breadcrumbs (ticket 06 §1 rule 1). Two sources are read in v1: the `[projects."<path>"]`
 * trust map of `config.toml` — trust entries are evidence of a place sessions ran — and the `cwd`
 * column of `state_5.sqlite`'s `threads` table, aggregated to **one breadcrumb per distinct path**
 * with its occurrence counts (D30).
 *
 * Not read: the `cwd` on line 1 of a rollout, `.codex-global-state.json`'s `local-projects`, and
 * the desktop `sqlite/codex-dev.db` — all three are listed in `breadcrumbSources` with
 * `readInV1: false`. `history.jsonl` and `session_index.jsonl` carry no path at all.
 */
import type { Breadcrumb } from "../../index/types.js";
import type { Located } from "../../scan/discovery.js";
import { isUnder } from "../../scan/paths.js";
import { HARNESS, type CodexScan } from "./model.js";
import { stampOf } from "./threads.js";

function crumb(
  scan: CodexScan,
  locatorText: string,
  kind: Breadcrumb["kind"],
  raw: string,
  located: Located | null,
  locator: Breadcrumb["locator"],
  occurrences: Breadcrumb["occurrences"],
  refs: Breadcrumb["refs"],
  state: string[],
): Breadcrumb {
  return {
    id: `breadcrumb:${HARNESS}:${scan.ctx.identity.fold(locatorText)}`,
    harness: HARNESS,
    kind,
    raw,
    // Every value Codex records is an absolute path.
    recordedForm: "path",
    path: located?.path ?? null,
    resolution: "direct",
    project: located?.project?.id ?? null,
    strayReason: located?.strayReason ?? null,
    relativePathInProject: located?.relativePath ?? null,
    reachability: located?.reachability ?? "orphan",
    locator,
    occurrences,
    refs,
    state,
  };
}

/** Harness-owned entity ids whose path lies under `dir` — the state behind a breadcrumb. */
function stateUnder(scan: CodexScan, dir: string): string[] {
  const fold = scan.ctx.identity.fold;
  return [...scan.entities.values()]
    .filter((entity) => entity.ownership === "harness" && isUnder(fold(entity.path), fold(dir)))
    .map((entity) => entity.id)
    .toSorted();
}

export function collectBreadcrumbs(scan: CodexScan): void {
  for (const entry of scan.trust) {
    scan.breadcrumbs.push(
      crumb(
        scan,
        `${entry.file}#projects/${entry.key}`,
        "trust-entry",
        entry.key,
        entry.located,
        { type: "entry", file: entry.file, format: "toml", keyPath: ["projects", entry.key] },
        { count: 1, first: null, last: null },
        {},
        [],
      ),
    );
  }

  for (const { crumb: aggregated, located } of scan.cwds) {
    const newest = aggregated.newestSource;
    const refs: Breadcrumb["refs"] = { lastSessionId: newest.id };
    // The state behind the breadcrumb: the rollout files the rows that named this cwd point at.
    // A `rollout_path` that names a missing file simply contributes nothing — the database is an
    // index and its stale rows are Codex's business (fixture edge case 4).
    const state = [
      ...new Set(
        aggregated.sources
          .map((row) =>
            row.rolloutPath === null
              ? undefined
              : scan.rolloutUnits.get(scan.ctx.identity.fold(row.rolloutPath)),
          )
          .filter((id): id is string => id !== undefined),
      ),
    ].toSorted();
    scan.breadcrumbs.push(
      crumb(
        scan,
        `${scan.threadsFile}#threads/cwd/${aggregated.path}`,
        "session-cwd",
        aggregated.path,
        located,
        {
          type: "sqlite",
          file: scan.threadsFile,
          table: "threads",
          keyColumn: "cwd",
          keyValue: aggregated.path,
        },
        aggregated.occurrences,
        refs,
        state,
      ),
    );
  }

  // `project_roots` is empty on every machine observed; a future Codex that fills it yields
  // `project-row` breadcrumbs by the same rule, the path column taken verbatim (§1.3).
  for (const row of scan.projectRoots) {
    scan.breadcrumbs.push(
      crumb(
        scan,
        `${scan.threadsFile}#project_roots/path/${row.path}`,
        "project-row",
        row.path,
        row.located,
        {
          type: "sqlite",
          file: scan.threadsFile,
          table: "project_roots",
          keyColumn: "path",
          keyValue: row.path,
        },
        { count: 1, first: null, last: null },
        {},
        [],
      ),
    );
  }

  scan.breadcrumbs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** `occurrences.first` / `.last` of an aggregated session-cwd group, as ISO strings. */
export function occurrenceStamps(
  first: number | null,
  last: number | null,
): {
  first: string | null;
  last: string | null;
} {
  return { first: stampOf(first), last: stampOf(last) };
}

/** Ids of the state a stray breadcrumb points at, exported for the user-scope listing. */
export { stateUnder };
