/** Explicit orphan-Project deletion: one target per harness store, never one row per file. */
import type { AuditIndex, Entity, Locator } from "../index/types.js";
import { locatorKey } from "./data-dir.js";
import { isLive } from "./selection.js";
import type { Selection, SelectionTarget } from "./types.js";

export interface ProjectCleanup {
  readonly selection: Selection;
  readonly projectCount: number;
  readonly breadcrumbCount: number;
  readonly bytes: number;
  readonly blocked: readonly string[];
}

interface PathCandidate {
  readonly path: string;
  readonly project: string;
}

function pathsOf(locator: Locator): string[] {
  if (locator.type === "file" || locator.type === "dir") return [locator.path];
  return locator.type === "paths" ? [...locator.paths] : [];
}

function fileOf(locator: Locator): string | null {
  switch (locator.type) {
    case "entry":
    case "array-value":
    case "sqlite":
      return locator.file;
    default:
      return null;
  }
}

function normal(path: string, platform: string): string {
  const slashed = path.replaceAll("\\", "/").replace(/\/+$/u, "");
  return platform === "win32" ? slashed.toLowerCase() : slashed;
}

function isUnder(path: string, directory: string, platform: string): boolean {
  const child = normal(path, platform);
  const parent = normal(directory, platform);
  return child === parent || child.startsWith(`${parent}/`);
}

function blocked(entity: Entity): boolean {
  // A running harness wins even over an explicit Project-level selection.
  return isLive(entity);
}

function harnessName(index: AuditIndex, harness: string): string {
  return index.harnesses.find((entry) => entry.harness === harness)?.displayName ?? harness;
}

/**
 * Every selected Project must already be orphan. Paths collapse into one recoverable trash target;
 * store entries remain precise backup-edits. A live child blocks its ancestor.
 */
export function projectCleanup(
  index: AuditIndex,
  selectedProjectIds: ReadonlySet<string>,
): ProjectCleanup {
  const projects = index.projects.filter(
    (project) => project.reachability === "orphan" && selectedProjectIds.has(project.id),
  );
  const wanted = new Set(projects.map((project) => project.id));
  const projectById = new Map(projects.map((project) => [project.id, project]));
  const entityById = new Map(index.entities.map((entity) => [entity.id, entity]));
  const seenEntities = new Set<string>();
  const blockedPaths: string[] = [];
  const blockedLabels = new Set<string>();
  const candidates: PathCandidate[] = [];
  const precise: SelectionTarget[] = [];
  const seenPrecise = new Set<string>();

  const addEntity = (entity: Entity): void => {
    if (seenEntities.has(entity.id)) return;
    seenEntities.add(entity.id);
    if (blocked(entity)) {
      blockedLabels.add(entity.label);
      for (const path of pathsOf(entity.locator)) blockedPaths.push(path);
      return;
    }
    const paths = pathsOf(entity.locator);
    for (const path of paths) {
      if (entity.project !== null) candidates.push({ path, project: entity.project });
    }
    // Entry/SQLite state is already owned by the breadcrumb's enclosing store target.
  };

  let breadcrumbCount = 0;
  for (const breadcrumb of index.breadcrumbs) {
    if (breadcrumb.project === null || !wanted.has(breadcrumb.project)) continue;
    breadcrumbCount += 1;
    const project = projectById.get(breadcrumb.project);
    if (project === undefined) continue;
    const state = breadcrumb.state
      .map((id) => entityById.get(id))
      .filter((entity): entity is Entity => entity !== undefined);
    for (const entity of state) addEntity(entity);
    if (state.some(blocked)) {
      blockedLabels.add(`${project.displayName} · ${harnessName(index, breadcrumb.harness)}`);
      continue;
    }

    const paths = pathsOf(breadcrumb.locator);
    if (paths.length > 0) {
      for (const path of paths) candidates.push({ path, project: project.id });
      continue;
    }
    const key = locatorKey(breadcrumb.locator);
    if (seenPrecise.has(key)) continue;
    seenPrecise.add(key);
    precise.push({
      action: "delete",
      locator: breadcrumb.locator,
      label: `${project.displayName} · ${harnessName(index, breadcrumb.harness)} · ${breadcrumb.kind.replaceAll("-", " ")}`,
      kind: "project-state",
      harness: breadcrumb.harness,
      project: project.id,
    });
  }

  const platform = index.scan.platform;
  const uniquePaths = [
    ...new Map(
      candidates.map((candidate) => [normal(candidate.path, platform), candidate]),
    ).values(),
  ]
    .filter(
      (candidate) =>
        !blockedPaths.some(
          (path) =>
            isUnder(path, candidate.path, platform) || isUnder(candidate.path, path, platform),
        ),
    )
    .toSorted(
      (left, right) => left.path.length - right.path.length || left.path.localeCompare(right.path),
    )
    .filter(
      (candidate, candidateIndex, all) =>
        !all
          .slice(0, candidateIndex)
          .some((parent) => isUnder(candidate.path, parent.path, platform)),
    );

  const covered = (locator: Locator): boolean => {
    const file = fileOf(locator);
    return (
      file !== null && uniquePaths.some((candidate) => isUnder(file, candidate.path, platform))
    );
  };
  const targets = precise.filter(
    (target) => target.locator === undefined || !covered(target.locator),
  );
  const bytes = [...seenEntities]
    .map((id) => entityById.get(id)?.metrics.bytes ?? 0)
    .reduce((sum, value) => sum + value, 0);
  if (uniquePaths.length > 0) {
    const bytesByProject = new Map<string, number>();
    for (const id of seenEntities) {
      const entity = entityById.get(id);
      if (entity?.project === null || entity?.project === undefined) continue;
      bytesByProject.set(
        entity.project,
        (bytesByProject.get(entity.project) ?? 0) + entity.metrics.bytes,
      );
    }
    const pathsByProject = new Map<string, string[]>();
    for (const candidate of uniquePaths) {
      const paths = pathsByProject.get(candidate.project) ?? [];
      paths.push(candidate.path);
      pathsByProject.set(candidate.project, paths);
    }
    const pathTargets: SelectionTarget[] = [];
    for (const project of projects) {
      const paths = pathsByProject.get(project.id);
      if (paths === undefined || paths.length === 0) continue;
      pathTargets.push({
        action: "delete",
        locator: { type: "paths", paths },
        label: `${project.displayName} · all on-disk harness state`,
        kind: "project-state",
        project: project.id,
        bytes: bytesByProject.get(project.id) ?? 0,
      });
    }
    targets.unshift(...pathTargets);
  }

  return {
    selection: targets,
    projectCount: projects.length,
    breadcrumbCount,
    bytes,
    blocked: [...blockedLabels].toSorted(),
  };
}
