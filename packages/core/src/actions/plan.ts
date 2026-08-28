/**
 * `plan(index, selection, env)` — the Selection becomes a Plan: one row per target, its
 * Disposition decided before anything moves (CONTEXT.md Disposition), grouped
 * Clean → Delete → Update → Open (14 §3). Pure: the only probe is `env.deviceOf`, injected, so
 * a network volume is testable without mounting one (15 Answer).
 *
 * The Delete table of ticket 14 §1 lives in `dispositionFor`, row by row. A `protection: never`
 * row, a Live row, a size-only row and a `paths` unit with one refused member are never
 * actionable (D89, D142, 08 §3).
 */
import type {
  AuditIndex,
  Entity,
  Flag,
  HarnessCache,
  Locator,
  MemoryFile,
  Skill,
} from "../index/types.js";
import { backupDirFor, backupPathFor, locatorKey, manifestPathFor, runIdFor } from "./data-dir.js";
import {
  delegateCwdFor,
  parseDelegate,
  updateBatchDelegateFor,
  updateDelegateFor,
  type DelegateCommand,
} from "./delegates.js";
import {
  canUpdate,
  inCleanUniverse,
  isLive,
  isProtected,
  isSizeOnly,
  isTickable,
  placementLinks,
} from "./selection.js";
import {
  ACTION_ORDER,
  ACTION_TITLES,
  type Action,
  type Badge,
  type Disposition,
  type Plan,
  type PlanBackup,
  type PlanEdit,
  type PlanEnv,
  type PlanGroup,
  type PlanRow,
  type PlanTarget,
  type Selection,
  type SelectionTarget,
  type VolumeClass,
} from "./types.js";

/** D89, verbatim: the four reasons a volume refuses a row. */
const VOLUME_REASONS: Readonly<Record<Exclude<VolumeClass, "home" | "local">, string>> = {
  network: "network volume — no trash available",
  "read-only": "read-only volume — nothing can be moved",
  unknown: "volume moldig cannot classify — no trash available",
  "dropped-mount": "mount outside the system's trash table — no trash available",
};

/** The row string is the short half of the reason: `refused: network volume` (08 §4). */
function shortReason(reason: string): string {
  return reason.split(" — ")[0] ?? reason;
}

function refused(reason: string): Disposition {
  return {
    kind: "refused",
    display: `refused: ${shortReason(reason)}`,
    command: null,
    argv: null,
    cwd: null,
    permanent: false,
    runnable: false,
    reason,
  };
}

function trashDisposition(): Disposition {
  return {
    kind: "trash",
    display: "→ Trash",
    command: null,
    argv: null,
    cwd: null,
    permanent: false,
    runnable: true,
    reason: null,
  };
}

function editDisposition(): Disposition {
  return {
    kind: "backup-edit",
    display: "→ backup + edit",
    command: null,
    argv: null,
    cwd: null,
    permanent: false,
    runnable: true,
    reason: null,
  };
}

function delegateDisposition(
  delegate: DelegateCommand,
  kind: "delegate" | "update",
  backedUp: boolean,
): Disposition {
  const permanent = delegate.permanent ? " (permanent)" : "";
  return {
    kind,
    display: `→ ${backedUp ? "backup + " : ""}${delegate.display}${permanent}`,
    command: delegate.display,
    argv: delegate.argv,
    cwd: delegate.cwd,
    permanent: delegate.permanent,
    runnable: delegate.runnable,
    reason: delegate.reason,
  };
}

function openDisposition(): Disposition {
  return {
    kind: "open",
    display: "→ open in editor",
    command: null,
    argv: null,
    cwd: null,
    permanent: false,
    runnable: false,
    reason: null,
  };
}

function pathsOf(locator: Locator): string[] {
  switch (locator.type) {
    case "file":
    case "dir": {
      return [locator.path];
    }
    case "paths": {
      return [...locator.paths];
    }
    default: {
      return [];
    }
  }
}

function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut === -1 ? path : path.slice(cut + 1);
}

function harnessIdOf(harnessEntityId: string): string {
  return harnessEntityId.startsWith("harness:")
    ? harnessEntityId.slice("harness:".length)
    : harnessEntityId;
}

/**
 * Tokens per session a row frees, per harness: the maximum `tokensLoaded` over the entity's
 * `loaded-by` edges that count toward the headline (08 §4). Clean and Delete rows only.
 */
function tokensOf(index: AuditIndex, entityId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const edge of index.edges) {
    if (edge.kind !== "loaded-by" || edge.from !== entityId) continue;
    if (!edge.countsTowardHeadline || edge.tokensLoaded === null) continue;
    const harness = harnessIdOf(edge.to);
    out[harness] = Math.max(out[harness] ?? 0, edge.tokensLoaded);
  }
  return sortedTokens(out);
}

function flagsOf(entity: Entity): Flag[] {
  const flags: Flag[] = [];
  if (entity.shared === true) flags.push("shared");
  if (entity.sensitive) flags.push("sensitive");
  if (entity.kind === "memory-file") flags.push("memory");
  if (isLive(entity)) flags.push("live");
  if (entity.kind === "harness-cache" && entity.userContent) flags.push("user-content");
  return flags;
}

function badgesOf(entity: Entity, permanent: boolean): Badge[] {
  const badges: Badge[] = [];
  if (permanent) badges.push("permanent");
  if (entity.kind === "memory-file" && entity.neverRead === true) badges.push("never-read");
  if (entity.kind === "skill" && entity.drift === "local-modified") badges.push("locally-modified");
  if (entity.kind === "skill" && entity.placements.some((placement) => placement.dangling)) {
    badges.push("dangling");
  }
  if (entity.kind === "harness-cache" && entity.rule === "kept") badges.push("kept");
  if (isSizeOnly(entity)) badges.push("size-only");
  if (entity.kind === "mcp-server" && entity.invalid !== null) badges.push("invalid");
  if (entity.kind === "mcp-server" && entity.secretKeys.length > 0) badges.push("secret");
  return badges;
}

interface Steps {
  disposition: Disposition;
  paths: string[];
  backups: PlanBackup[];
  edits: PlanEdit[];
}

function edited(
  file: string,
  keyPath: readonly string[],
  format: "json" | "jsonc",
  backupDir: string,
): Steps {
  return {
    disposition: editDisposition(),
    paths: [],
    backups: [{ path: file, to: backupPathFor(backupDir, file), recursive: false }],
    edits: [{ kind: "json-entry", file, format, keyPath: [...keyPath] }],
  };
}

function editedArrayValue(
  locator: Extract<Locator, { type: "array-value" }>,
  backupDir: string,
): Steps {
  if (locator.format !== "json" && locator.format !== "jsonc") {
    return emptySteps(refused(`moldig cannot edit ${locator.format} arrays`));
  }
  return {
    disposition: editDisposition(),
    paths: [],
    backups: [
      {
        path: locator.file,
        to: backupPathFor(backupDir, locator.file),
        recursive: false,
      },
    ],
    edits: [
      {
        kind: "json-array-value",
        file: locator.file,
        format: locator.format,
        keyPath: [...locator.keyPath],
        value: locator.value,
      },
    ],
  };
}

function editedTomlTable(locator: Extract<Locator, { type: "entry" }>, backupDir: string): Steps {
  return {
    disposition: editDisposition(),
    paths: [],
    backups: [
      {
        path: locator.file,
        to: backupPathFor(backupDir, locator.file),
        recursive: false,
      },
    ],
    edits: [{ kind: "toml-table", file: locator.file, keyPath: [...locator.keyPath] }],
  };
}

function editedSqliteRows(locator: Extract<Locator, { type: "sqlite" }>, backupDir: string): Steps {
  return {
    disposition: editDisposition(),
    paths: [],
    backups: [
      {
        path: locator.file,
        to: backupPathFor(backupDir, locator.file),
        recursive: false,
        sqlite: true,
      },
    ],
    edits: [
      {
        kind: "sqlite-rows",
        file: locator.file,
        table: locator.table,
        keyColumn: locator.keyColumn,
        keyValue: locator.keyValue,
      },
    ],
  };
}

/** Every lock entry that records a Skill: the Origin's own entry and every `originates-from`. */
function lockEntriesOf(index: AuditIndex, skill: Skill): Extract<Locator, { type: "entry" }>[] {
  const out: Extract<Locator, { type: "entry" }>[] = [];
  const seen = new Set<string>();
  const add = (locator: Locator | undefined): void => {
    if (locator === undefined || locator.type !== "entry") return;
    const key = locatorKey(locator);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(locator);
  };
  add(skill.origin?.lock);
  for (const edge of index.edges) {
    if (edge.kind !== "originates-from" || edge.from !== skill.id) continue;
    for (const evidence of edge.evidence) add(evidence.locator);
  }
  return out;
}

/** The memory index of a unit: the `role: "index"` file the fact shares its directory with. */
function memoryIndexOf(index: AuditIndex, fact: MemoryFile): MemoryFile | null {
  for (const entity of index.entities) {
    if (entity.kind !== "memory-file" || entity.role !== "index") continue;
    if (entity.unit === fact.unit) return entity;
  }
  return null;
}

function keptReason(unit: HarnessCache): string {
  return `kept — the harness documents no sweep for this ${unit.cacheKind.replaceAll("-", " ")}; Delete only`;
}

/**
 * The Delete table of ticket 14 §1 and the Clean dispositions of ticket 08 §3, row by row.
 * Every branch decides its backups and edits here: `apply()` executes, it never re-decides.
 */
function dispositionFor(
  index: AuditIndex,
  entity: Entity,
  target: SelectionTarget,
  env: PlanEnv,
  backupDir: string,
): Steps {
  const locator = entity.locator;
  // A whole Skill: the placement links first, then the real directory, then the locks (D94).
  if (entity.kind === "skill" && entity.removal.method === "trash") {
    if (target.placement !== undefined) {
      return { disposition: trashDisposition(), paths: [target.placement], backups: [], edits: [] };
    }
    const locks = lockEntriesOf(index, entity);
    return {
      disposition: trashDisposition(),
      paths: [...placementLinks(entity), entity.path],
      backups: locks.map((lock) => ({
        path: lock.file,
        to: backupPathFor(backupDir, lock.file),
        recursive: false,
      })),
      edits: locks.map((lock) => ({
        kind: "json-entry" as const,
        file: lock.file,
        format: lock.format === "jsonc" ? ("jsonc" as const) : ("json" as const),
        keyPath: [...lock.keyPath],
      })),
    };
  }
  // A memory fact: trash the file, then rewrite `MEMORY.md` by the evidenced rule (08 §2).
  // A memory index on its own trashes that file and leaves the facts (D98).
  if (entity.kind === "memory-file" && entity.role === "fact") {
    const memoryIndex = memoryIndexOf(index, entity);
    if (memoryIndex === null) {
      return { disposition: trashDisposition(), paths: [entity.path], backups: [], edits: [] };
    }
    return {
      disposition: trashDisposition(),
      paths: [entity.path],
      backups: [
        {
          path: memoryIndex.path,
          to: backupPathFor(backupDir, memoryIndex.path),
          recursive: false,
        },
      ],
      edits: [{ kind: "memory-index", file: memoryIndex.path, fact: basename(entity.path) }],
    };
  }
  if (entity.removal.method === "trash") {
    return { disposition: trashDisposition(), paths: pathsOf(locator), backups: [], edits: [] };
  }
  if (entity.removal.method === "backup-edit") {
    if (locator.type !== "entry" || (locator.format !== "json" && locator.format !== "jsonc")) {
      return {
        disposition: refused("moldig has no editor for this format"),
        paths: [],
        backups: [],
        edits: [],
      };
    }
    return edited(locator.file, locator.keyPath, locator.format, backupDir);
  }
  if (entity.removal.method === "delegate") {
    const command = entity.removal.command;
    if (command === undefined) {
      return {
        disposition: refused("no editor and no delegate for this file"),
        paths: [],
        backups: [],
        edits: [],
      };
    }
    const delegate = parseDelegate(command, delegateCwdFor(index, entity, env.home));
    if (delegate === null) {
      return {
        disposition: refused("moldig cannot run this delegate safely"),
        paths: [],
        backups: [],
        edits: [],
      };
    }
    // Codex TOML: `config.toml` is copied to the run's backup directory first; moldig never
    // edits TOML, and the delegate does not run when the backup fails (14 §1).
    const backups: PlanBackup[] =
      locator.type === "entry" && locator.format === "toml"
        ? [
            {
              path: locator.file,
              to: backupPathFor(backupDir, locator.file),
              recursive: false,
            },
          ]
        : [];
    return {
      disposition: delegateDisposition(delegate, "delegate", backups.length > 0),
      paths: [],
      backups,
      edits: [],
    };
  }
  // `removal.method: "none"` — the last-resort row of the Delete table (14 §1).
  if (locator.type === "entry" && locator.format === "toml") {
    return {
      disposition: refused(
        "moldig never edits TOML and `codex mcp remove` targets the user configuration",
      ),
      paths: [],
      backups: [],
      edits: [],
    };
  }
  if (locator.type === "entry" && locator.keyPath[0] === "projects") {
    return {
      disposition: refused(
        "the project directory this entry is keyed by is gone — the harness's own command has nowhere to run",
      ),
      paths: [],
      backups: [],
      edits: [],
    };
  }
  return {
    disposition: refused("no editor and no delegate for this file"),
    paths: [],
    backups: [],
    edits: [],
  };
}

/** A locator-only target: a Finding target, or grouped state for explicitly chosen Projects. */
function locatorSteps(locator: Locator, backupDir: string): Steps {
  if (locator.type === "dir" || locator.type === "file" || locator.type === "paths") {
    return { disposition: trashDisposition(), paths: pathsOf(locator), backups: [], edits: [] };
  }
  if (locator.type === "entry" && (locator.format === "json" || locator.format === "jsonc")) {
    return edited(locator.file, locator.keyPath, locator.format, backupDir);
  }
  if (locator.type === "entry" && locator.format === "toml") {
    return editedTomlTable(locator, backupDir);
  }
  if (locator.type === "array-value") return editedArrayValue(locator, backupDir);
  if (locator.type === "sqlite") return editedSqliteRows(locator, backupDir);
  return {
    disposition: refused(`moldig cannot safely edit this ${locator.type} locator`),
    paths: [],
    backups: [],
    edits: [],
  };
}

/**
 * Every path the row touches is classified; `home` and `local` may move, everything else
 * refuses the row whole — a `paths` unit with one refused member included (D89, 08 §3.2).
 */
function volumeOf(
  paths: readonly string[],
  env: PlanEnv,
): { volume: VolumeClass | null; reason: string | null } {
  if (paths.length === 0) return { volume: null, reason: null };
  const homeDev = env.deviceOf(env.home).dev;
  let volume: VolumeClass = "home";
  for (const path of paths) {
    const device = env.deviceOf(path);
    if (device.kind !== "local") {
      return { volume: device.kind, reason: VOLUME_REASONS[device.kind] };
    }
    if (device.dev !== homeDev) volume = "local";
  }
  return { volume, reason: null };
}

function targetOf(entity: Entity): PlanTarget {
  return {
    key: entity.id,
    id: entity.id,
    locator: entity.locator,
    label: entity.label,
    kind: entity.kind,
    harness: entity.harness,
    project: entity.project,
  };
}

function rowForUpdateBatch(target: SelectionTarget, env: PlanEnv): PlanRow | null {
  const batch = target.updateBatch;
  if (target.action !== "update" || batch === undefined) return null;
  const delegate = updateBatchDelegateFor(batch, env.home);
  if (delegate === null) return null;
  const locator = batch.kind === "vercel-skills" ? batch.lock : batch.locator;
  return {
    key: batch.key,
    action: "update",
    target: {
      key: batch.key,
      id: null,
      locator,
      label: batch.label,
      kind: "update-batch",
      harness: null,
      project: target.project ?? null,
    },
    disposition: delegateDisposition(delegate, "update", false),
    paths: [],
    backups: [],
    edits: [],
    bytes: 0,
    tokensPerSession: {},
    flags: [],
    badges: [],
    volume: null,
    finding: target.finding ?? null,
  };
}

/**
 * Why an entity cannot be cleaned, deleted or updated — checked again here (08 §2). `null`
 * lets `dispositionFor` decide, including the precise reason a row with no removal method
 * carries (a TOML entry, a local-scope entry whose Project directory is gone).
 */
function eligibility(entity: Entity, action: Action): string | null {
  if (isProtected(entity)) return "protected — moldig never removes this file";
  if (isLive(entity)) return "live — a harness is using it right now";
  if (isSizeOnly(entity)) return "size only — moldig cannot say what this item is";
  if (action === "clean") {
    if (!inCleanUniverse(entity)) return "human-owned — Delete only";
    if (entity.kind === "harness-cache" && entity.rule === "kept") return keptReason(entity);
    if (!isTickable(entity) && entity.removal.method !== "none") {
      return "no editor and no delegate for this file";
    }
    return null;
  }
  // After the three guards above, only `removal.method: "none"` can still block a Delete, and
  // `dispositionFor` names that case precisely (the last-resort row of 14 §1).
  if (action === "delete") return null;
  if (action === "update") return canUpdate(entity) ? null : "no installer recognised";
  return null;
}

function rowFor(
  index: AuditIndex,
  target: SelectionTarget,
  env: PlanEnv,
  backupDir: string,
  entityById: Map<string, Entity>,
): PlanRow | null {
  if (target.updateBatch !== undefined) return rowForUpdateBatch(target, env);
  const entity = target.id === undefined ? undefined : entityById.get(target.id);
  const finding = target.finding ?? null;
  if (entity === undefined) {
    // A locator-only target: a lock entry whose directory is gone, or a whole memory unit.
    const locator = target.locator;
    if (locator === undefined) return null;
    const steps =
      target.action === "open" ? emptySteps(openDisposition()) : locatorSteps(locator, backupDir);
    const key = locatorKey(locator);
    const classified = [...steps.paths, ...steps.backups.map((backup) => backup.path)];
    const volume = volumeOf(classified, env);
    const disposition = volume.reason === null ? steps.disposition : refused(volume.reason);
    const stopped = volume.reason !== null;
    return {
      key,
      action: target.action,
      target: {
        key,
        id: null,
        locator,
        label: target.label ?? key,
        kind: target.kind ?? (locator.type === "dir" ? "memory-unit" : "lock-entry"),
        harness: target.harness ?? null,
        project: target.project ?? null,
      },
      disposition,
      paths: stopped ? [] : steps.paths,
      backups: stopped ? [] : steps.backups,
      edits: stopped ? [] : steps.edits,
      bytes: target.bytes ?? 0,
      tokensPerSession: {},
      flags: [],
      badges: [],
      volume: volume.volume,
      finding,
    };
  }

  const blocked = eligibility(entity, target.action);
  const weighted = target.action === "clean" || target.action === "delete";
  // One placement of a Skill is a row of its own ("remove for <harness>", 14 §1).
  const rowKey = target.placement === undefined ? entity.id : `${entity.id}#${target.placement}`;
  const base = {
    key: rowKey,
    action: target.action,
    target: targetOf(entity),
    bytes: weighted ? entity.metrics.bytes : 0,
    tokensPerSession: weighted ? tokensOf(index, entity.id) : {},
    flags: flagsOf(entity),
    finding,
  };
  if (blocked !== null) {
    return {
      ...base,
      disposition: refused(blocked),
      paths: [],
      backups: [],
      edits: [],
      badges: badgesOf(entity, false),
      volume: null,
    };
  }
  if (target.action === "open") {
    return {
      ...base,
      disposition: openDisposition(),
      paths: [],
      backups: [],
      edits: [],
      badges: badgesOf(entity, false),
      volume: null,
    };
  }
  const steps =
    target.action === "update"
      ? updateSteps(index, entity, env, backupDir)
      : dispositionFor(index, entity, target, env, backupDir);
  const classified = [...steps.paths, ...steps.backups.map((backup) => backup.path)];
  const volume = volumeOf(classified, env);
  const stopped = volume.reason !== null;
  const disposition = stopped ? refused(volume.reason ?? "") : steps.disposition;
  return {
    ...base,
    disposition,
    paths: stopped ? [] : steps.paths,
    backups: stopped ? [] : steps.backups,
    edits: stopped ? [] : steps.edits,
    badges: badgesOf(entity, disposition.permanent),
    volume: volume.volume,
  };
}

function emptySteps(disposition: Disposition): Steps {
  return { disposition, paths: [], backups: [], edits: [] };
}

/** Update: the Installer's command, and a backup of a locally modified copy first (14 §2). */
function updateSteps(index: AuditIndex, entity: Entity, env: PlanEnv, backupDir: string): Steps {
  const delegate = updateDelegateFor(index, entity, env.home);
  if (delegate === null) return emptySteps(refused("no installer recognised"));
  const modified = entity.kind === "skill" && entity.drift === "local-modified";
  const backups: PlanBackup[] = modified
    ? [{ path: entity.path, to: backupPathFor(backupDir, entity.path), recursive: true }]
    : [];
  return {
    disposition: delegateDisposition(delegate, "update", modified),
    paths: [],
    backups,
    edits: [],
  };
}

function mergeTokens(into: Record<string, number>, from: Record<string, number>): void {
  for (const [harness, tokens] of Object.entries(from))
    into[harness] = (into[harness] ?? 0) + tokens;
}

function sortedTokens(tokens: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(tokens).toSorted(([a], [b]) => a.localeCompare(b)));
}

function groupFor(action: Action, rows: PlanRow[]): PlanGroup {
  const sorted = rows.toSorted(
    (a, b) =>
      b.bytes - a.bytes ||
      a.target.label.localeCompare(b.target.label) ||
      a.key.localeCompare(b.key),
  );
  const tokens: Record<string, number> = {};
  let bytes = 0;
  let shared = 0;
  const actionable = sorted.filter((row) => row.disposition.kind !== "refused");
  for (const row of actionable) {
    bytes += row.bytes;
    mergeTokens(tokens, row.tokensPerSession);
    if (row.flags.includes("shared")) shared += 1;
  }
  const userContent = actionable.some((row) => row.flags.includes("user-content"));
  const permanent = actionable.some((row) => row.badges.includes("permanent"));
  const warnings: string[] = [];
  if (shared > 0) {
    warnings.push(
      `⚠ ${shared} shared ${shared === 1 ? "row" : "rows"} — git-tracked, collaborators may rely on them`,
    );
  }
  const reason =
    userContent && permanent
      ? "user content and permanent rows"
      : userContent
        ? "user content"
        : permanent
          ? "permanent rows"
          : null;
  if (reason !== null) warnings.push(`⚠ holds ${reason} — confirmed separately`);
  return {
    action,
    title: ACTION_TITLES[action],
    rows: sorted,
    count: sorted.length,
    bytes,
    tokensPerSession: sortedTokens(tokens),
    shared,
    warnings,
    extraConfirmation: { required: reason !== null, reason },
  };
}

/**
 * The Plan: every Disposition, backup path and delegate decided before anything moves. Also
 * what `clean --dry-run` prints (D4) — `apply()` executes it without deciding anything again.
 */
export function plan(index: AuditIndex, selection: Selection, env: PlanEnv): Plan {
  const runId = runIdFor(env.now);
  const backupDir = backupDirFor(env.dataDir, runId, env.platform);
  const manifestPath = manifestPathFor(env.dataDir, runId, env.platform);
  const entityById = new Map(index.entities.map((entity) => [entity.id, entity]));
  const rows: PlanRow[] = [];
  const seen = new Set<string>();
  for (const target of selection) {
    const row = rowFor(index, target, env, backupDir, entityById);
    if (row === null) continue;
    const key = `${row.action}:${row.key}${target.placement ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(row);
  }
  const groups = ACTION_ORDER.map((action) =>
    groupFor(
      action,
      rows.filter((row) => row.action === action),
    ),
  ).filter((group) => group.count > 0);
  return {
    runId,
    startedAt: env.now.toISOString(),
    dataDir: env.dataDir,
    backupDir,
    manifestPath,
    command: env.command,
    moldig: env.moldig,
    groups,
  };
}
