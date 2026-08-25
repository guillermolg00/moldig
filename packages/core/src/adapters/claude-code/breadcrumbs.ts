/**
 * Claude Code's breadcrumbs (ticket 06 §1, 07): the `projects` keys of `~/.claude.json`
 * (`projects-entry`) and the slug directories of `~/.claude/projects/` (`slug-directory`,
 * resolved key → known Project → transcript cwd → stray "unresolved slug"). A transcript's
 * `cwd` is only the third resolution step of a slug, never a breadcrumb of its own (06 rule
 * 6); `githubRepoPaths` and `history.jsonl` are not read (06).
 */
import type { Breadcrumb } from "../../index/types.js";
import type { Located } from "../../scan/discovery.js";
import { isUnder } from "../../scan/paths.js";
import type { ClaudeScan } from "./model.js";

function crumb(
  scan: ClaudeScan,
  locatorText: string,
  kind: Breadcrumb["kind"],
  raw: string,
  recordedForm: Breadcrumb["recordedForm"],
  located: Located | null,
  resolution: Breadcrumb["resolution"],
  locator: Breadcrumb["locator"],
  occurrences: Breadcrumb["occurrences"],
  refs: Breadcrumb["refs"],
  state: string[],
): Breadcrumb {
  return {
    id: `breadcrumb:claude-code:${scan.ctx.identity.fold(locatorText)}`,
    harness: "claude-code",
    kind,
    raw,
    recordedForm,
    path: located?.path ?? null,
    resolution,
    project: located?.project?.id ?? null,
    strayReason: located?.strayReason ?? (resolution === "unresolved" ? "unresolved-slug" : null),
    relativePathInProject: located?.relativePath ?? null,
    reachability: located?.reachability ?? "orphan",
    locator,
    occurrences,
    refs,
    state,
  };
}

/** Harness-owned entity ids whose path lies under `dir`. */
function stateUnder(scan: ClaudeScan, dir: string): string[] {
  const fold = scan.ctx.identity.fold;
  return [...scan.entities.values()]
    .filter((entity) => entity.ownership === "harness" && isUnder(fold(entity.path), fold(dir)))
    .map((entity) => entity.id)
    .toSorted();
}

function sessionUnitId(scan: ClaudeScan, sessionId: string): string | null {
  for (const { slug } of scan.slugs) {
    const head = slug.transcripts.find((transcript) => transcript.sessionId === sessionId);
    if (head !== undefined) return scan.ctx.id("harness-cache", head.path);
  }
  return null;
}

export function collectBreadcrumbs(scan: ClaudeScan): void {
  const { claudeJson } = scan;
  for (const entry of claudeJson.projects) {
    const located = scan.keyLocated.get(entry.key) ?? null;
    const refs: Breadcrumb["refs"] = {};
    if (entry.lastSessionId !== null) refs.lastSessionId = entry.lastSessionId;
    const unit = entry.lastSessionId === null ? null : sessionUnitId(scan, entry.lastSessionId);
    scan.breadcrumbs.push(
      crumb(
        scan,
        `${claudeJson.path}#projects/${entry.key}`,
        "projects-entry",
        entry.key,
        "path",
        located,
        "direct",
        { type: "entry", file: claudeJson.path, format: "json", keyPath: ["projects", entry.key] },
        { count: 1, first: null, last: null },
        refs,
        unit === null ? [] : [unit],
      ),
    );
  }
  for (const { slug, located, resolution } of scan.slugs) {
    scan.breadcrumbs.push(
      crumb(
        scan,
        slug.dir,
        "slug-directory",
        slug.slug,
        "slug",
        located,
        resolution,
        { type: "dir", path: slug.dir },
        { count: 1, first: null, last: null },
        {},
        stateUnder(scan, slug.dir),
      ),
    );
  }
  scan.breadcrumbs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
