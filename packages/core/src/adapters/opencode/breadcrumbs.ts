/**
 * OpenCode's breadcrumbs (ticket 06 §1; §2.3): the `project` rows of `opencode.db` and the
 * legacy `<data>/storage/project/<id>.json` records the database superseded. Both are evidence
 * of a directory sessions ran in, so a record whose id also exists as a row yields a second
 * breadcrumb on the same Project (ADR-0006: breadcrumbs are evidence, not identity).
 *
 * D30: rows aggregate — one Breadcrumb per **distinct** worktree, with `occurrences {count,
 * first, last}` filled; the locator points at the newest row that named the path, keyed by the
 * `project` table's own primary key (§2.3). `session.directory`, `project_directory` and
 * `workspace` are not breadcrumb sources in v1 and are never selected.
 */
import type { Breadcrumb } from "../../index/types.js";
import { aggregateSessionCwds } from "../../scan/discovery.js";
import type { Located } from "../../scan/discovery.js";
import type { ProjectRow } from "./db.js";
import type { OpenCodeScan } from "./model.js";

function iso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function crumb(
  scan: OpenCodeScan,
  locatorText: string,
  kind: Breadcrumb["kind"],
  raw: string,
  located: Located | null,
  locator: Breadcrumb["locator"],
  occurrences: Breadcrumb["occurrences"],
  projectId: string,
  state: string[],
): Breadcrumb {
  return {
    id: `breadcrumb:opencode:${scan.ctx.identity.fold(locatorText)}`,
    harness: "opencode",
    kind,
    raw,
    recordedForm: "path",
    path: located?.path ?? null,
    resolution: "direct",
    project: located?.project?.id ?? null,
    strayReason: located?.strayReason ?? null,
    relativePathInProject: located?.relativePath ?? null,
    reachability: located?.reachability ?? "orphan",
    locator,
    occurrences,
    refs: { projectId },
    state,
  };
}

/** The session units of the rows a `project` row owns, sorted (`state` is evidence, ticket 07). */
function sessionsOf(scan: OpenCodeScan, projectRowIds: readonly string[]): string[] {
  const wanted = new Set(projectRowIds);
  return scan.database.sessions
    .filter((row) => wanted.has(row.projectId))
    .map((row) => scan.sessionUnits.get(row.id))
    .filter((id): id is string => id !== undefined)
    .toSorted();
}

export function collectBreadcrumbs(scan: OpenCodeScan): void {
  const { database } = scan;
  const aggregated = aggregateSessionCwds<ProjectRow>(
    database.projects.map((row) => ({
      path: row.worktree,
      first: iso(row.timeCreated),
      last: iso(row.timeUpdated),
      source: row,
    })),
    scan.ctx.identity.fold,
  );
  for (const group of aggregated) {
    const located = scan.rowLocated.get(group.path) ?? null;
    if (located?.outsideRoots === true) continue;
    const row = group.newestSource;
    scan.breadcrumbs.push(
      crumb(
        scan,
        `${database.path}#project/id/${row.id}`,
        "project-row",
        group.path,
        located,
        {
          type: "sqlite",
          file: database.path,
          table: "project",
          keyColumn: "id",
          keyValue: row.id,
        },
        group.occurrences,
        row.id,
        sessionsOf(
          scan,
          group.sources.map((source) => source.id),
        ),
      ),
    );
  }
  for (const record of scan.legacy) {
    const located = scan.legacyLocated.get(record.path) ?? null;
    if (located?.outsideRoots === true) continue;
    scan.breadcrumbs.push(
      crumb(
        scan,
        record.path,
        "legacy-project-record",
        record.worktree,
        located,
        { type: "file", path: record.path },
        { count: 1, first: iso(record.created), last: iso(record.updated) },
        record.id,
        scan.storageUnit === null ? [] : [scan.storageUnit],
      ),
    );
  }
  scan.breadcrumbs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
