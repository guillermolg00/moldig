/**
 * `apply(plan, executors)` — the Plan runs, group by group, in confirmation order
 * (Clean → Delete → Update; Open is never executed and never lands in the manifest). Every
 * side effect is an injected executor, a failed row never aborts its group nor the run
 * (08 §3, 14 §3), and the manifest is written after every group and rewritten at the end (D91).
 *
 * Per row, always in this order: the backups, then the trash, then the edits, then the
 * delegate. Pure on-disk Project rows share one native trash hand-off but retain independent
 * outcomes. Nothing is decided here — `plan()` decided it all before anything moved.
 */
import {
  removeJsonArrayValue,
  removeJsonEntry,
  removeTomlTable,
  rewriteMemoryIndex,
} from "./edits.js";
import type {
  ApplyOptions,
  ConfirmAnswer,
  Executors,
  ManifestGroup,
  ManifestGroupSummary,
  ManifestRow,
  Plan,
  PlanEdit,
  PlanGroup,
  PlanRow,
  RowStatus,
  RunManifest,
  StatResult,
} from "./types.js";

interface RowOutcome {
  status: RowStatus;
  reason: string | null;
  exitCode: number | null;
}

function statusOf(row: PlanRow): RowStatus {
  switch (row.disposition.kind) {
    case "trash": {
      return "moved";
    }
    case "backup-edit": {
      return "edited";
    }
    case "delegate":
    case "update": {
      return "delegated";
    }
    default: {
      return "refused";
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** D92: a failed delegate reports its exit code and the last line of its stderr. */
function lastLine(text: string): string {
  const lines = text.trimEnd().split(/\r?\n/u);
  return lines.at(-1)?.trim() ?? "";
}

/** Delegate stderr is untrusted network/process output; credentials never enter the manifest. */
function redactProcessFailure(text: string): string {
  return text
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/giu, "$1<redacted>@")
    .replace(/\b(Bearer)\s+[^\s,;]+/giu, "$1 <redacted>")
    .replace(
      /\b((?:api[_-]?key|auth|credential|password|passwd|secret|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1<redacted>",
    )
    .replace(
      /\b(?:AKIA[0-9A-Z]{16}|github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9_]+|npm_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]+)\b/gu,
      "<redacted>",
    )
    .replace(/\b[A-Za-z0-9_\-./+=]{24,}\b/gu, "<redacted>");
}

type ConfirmationSnapshot = Map<string, StatResult | null>;

function sourcePathsOf(group: PlanGroup): string[] {
  const paths = new Set<string>();
  for (const row of group.rows) {
    for (const path of row.paths) paths.add(path);
    for (const backup of row.backups) paths.add(backup.path);
    for (const edit of row.edits) paths.add(edit.file);
  }
  return [...paths];
}

async function snapshotOf(group: PlanGroup, executors: Executors): Promise<ConfirmationSnapshot> {
  const paths = sourcePathsOf(group);
  const found = await Promise.all(paths.map((path) => executors.stat(path)));
  return new Map(paths.map((path, index) => [path, found[index] ?? null]));
}

function sameSnapshot(before: StatResult, after: StatResult): boolean {
  if (before.exists !== after.exists) return false;
  if (!before.exists) return true;
  return before.identity !== null && after.identity !== null && before.identity === after.identity;
}

async function revalidate(
  path: string,
  snapshot: ConfirmationSnapshot,
  executors: Executors,
): Promise<{ found: StatResult | null; failure: string | null }> {
  const before = snapshot.get(path) ?? null;
  const after = await executors.stat(path);
  if (before === null || after === null) {
    return { found: after, failure: `${path} could not be verified after confirmation` };
  }
  if (!sameSnapshot(before, after)) {
    return { found: after, failure: `${path} changed after confirmation` };
  }
  return { found: after, failure: null };
}

async function refreshSnapshot(
  paths: readonly string[],
  snapshot: ConfirmationSnapshot,
  executors: Executors,
): Promise<void> {
  const found = await Promise.all(paths.map((path) => executors.stat(path)));
  for (const [index, path] of paths.entries()) snapshot.set(path, found[index] ?? null);
}

async function runBackups(
  row: PlanRow,
  executors: Executors,
  completed: Set<string>,
  snapshot: ConfirmationSnapshot,
): Promise<string | null> {
  for (const backup of row.backups) {
    const key = `${backup.sqlite === true ? "sqlite" : "file"}:${backup.to}`;
    // Several Project breadcrumbs can edit one store. Preserve the first, original backup.
    if (completed.has(key)) continue;
    try {
      // oxlint-disable-next-line no-await-in-loop -- every source is checked immediately before copy
      const checked = await revalidate(backup.path, snapshot, executors);
      if (checked.failure !== null) return checked.failure;
      const expectedIdentity = checked.found?.identity;
      if (backup.sqlite === true) {
        if (executors.backupSqlite === undefined) {
          throw new Error("SQLite backup executor is unavailable");
        }
        // oxlint-disable-next-line no-await-in-loop -- a backup must land before the next step
        await executors.backupSqlite(backup.path, backup.to, expectedIdentity);
      } else {
        // oxlint-disable-next-line no-await-in-loop -- a backup must land before the next step
        await executors.backup(backup.path, backup.to, expectedIdentity);
      }
      completed.add(key);
    } catch (error) {
      return `backup of ${backup.path} failed: ${messageOf(error)}`;
    }
  }
  return null;
}

/**
 * Every path of the target in one call; a path that is already gone is never handed to the
 * trash (the package ignores it silently, 08 §3). The row moved when nothing was left behind.
 */
async function runTrash(
  row: PlanRow,
  executors: Executors,
  snapshot: ConfirmationSnapshot,
): Promise<RowOutcome | null> {
  if (row.paths.length === 0) return null;
  const present: string[] = [];
  for (const path of row.paths) {
    // oxlint-disable-next-line no-await-in-loop -- each member is checked immediately before move
    const checked = await revalidate(path, snapshot, executors);
    if (checked.failure !== null) {
      return { status: "failed", reason: checked.failure, exitCode: null };
    }
    if (checked.found?.exists === true) present.push(path);
  }
  if (present.length === 0) {
    return { status: "moved", reason: "every path was already gone", exitCode: null };
  }
  const result = await executors.trash(present);
  await refreshSnapshot(present, snapshot, executors);
  if (result.left.length > 0 || result.error !== null) {
    const left = result.left.length > 0 ? `; still in place: ${result.left.join(", ")}` : "";
    return {
      status: "failed",
      reason: `${result.error ?? "the trash left files behind"}${left}`,
      exitCode: null,
    };
  }
  return null;
}

function isProjectTrashRow(row: PlanRow): boolean {
  return (
    row.target.kind === "project-state" &&
    row.disposition.kind === "trash" &&
    row.paths.length > 0 &&
    row.backups.length === 0 &&
    row.edits.length === 0
  );
}

/** One native trash hand-off for every selected Project, while outcomes stay per Project row. */
async function runProjectTrashRows(
  rows: readonly PlanRow[],
  executors: Executors,
  snapshot: ConfirmationSnapshot,
): Promise<Map<string, RowOutcome>> {
  const outcomes = new Map<string, RowOutcome>();
  const presentByRow = new Map<string, string[]>();
  const everyPath = new Set<string>();
  for (const row of rows) {
    const present: string[] = [];
    for (const path of row.paths) {
      // oxlint-disable-next-line no-await-in-loop -- classify each selected path before one move
      const checked = await revalidate(path, snapshot, executors);
      if (checked.failure !== null) {
        outcomes.set(row.key, { status: "failed", reason: checked.failure, exitCode: null });
        break;
      }
      if (checked.found?.exists === true) present.push(path);
    }
    if (outcomes.has(row.key)) continue;
    presentByRow.set(row.key, present);
    for (const path of present) everyPath.add(path);
  }
  const movedPaths = [...everyPath];
  const result =
    movedPaths.length === 0
      ? { moved: [], left: [], error: null }
      : await executors.trash(movedPaths);
  await refreshSnapshot(movedPaths, snapshot, executors);
  const left = new Set(result.left);
  for (const row of rows) {
    if (outcomes.has(row.key)) continue;
    const present = presentByRow.get(row.key) ?? [];
    if (present.length === 0) {
      outcomes.set(row.key, {
        status: "moved",
        reason: "every path was already gone",
        exitCode: null,
      });
      continue;
    }
    const rowLeft = present.filter((path) => left.has(path));
    const ambiguousFailure = result.error !== null && result.left.length === 0;
    if (rowLeft.length > 0 || ambiguousFailure) {
      const leftText = rowLeft.length === 0 ? "" : `; still in place: ${rowLeft.join(", ")}`;
      outcomes.set(row.key, {
        status: "failed",
        reason: `${result.error ?? "the trash left files behind"}${leftText}`,
        exitCode: null,
      });
      continue;
    }
    outcomes.set(row.key, { status: "moved", reason: null, exitCode: null });
  }
  return outcomes;
}

/** Text rewrites are atomic; SQLite runs one exact, parameterised delete after its online backup. */
async function runEdit(
  edit: PlanEdit,
  executors: Executors,
  snapshot: ConfirmationSnapshot,
): Promise<string | null> {
  const checked = await revalidate(edit.file, snapshot, executors);
  if (checked.failure !== null) return checked.failure;
  const expectedIdentity = checked.found?.identity;

  if (edit.kind === "sqlite-rows") {
    if (executors.deleteSqliteRows === undefined) {
      return "SQLite edit executor is unavailable";
    }
    const changed = await executors.deleteSqliteRows(
      edit.file,
      edit.table,
      edit.keyColumn,
      edit.keyValue,
      expectedIdentity,
    );
    await refreshSnapshot([edit.file], snapshot, executors);
    return changed > 0
      ? null
      : `no ${edit.table}.${edit.keyColumn} row for ${edit.keyValue} in ${edit.file}`;
  }

  // Re-read immediately before rewriting: several selected Projects can share this file.
  const text = await executors.readFile(edit.file);
  if (text === null) return `${edit.file} could not be read`;
  let next: string | null;
  let missing: string;
  if (edit.kind === "json-entry") {
    next = removeJsonEntry(text, edit.keyPath);
    missing = `no entry ${edit.keyPath.join(".")} in ${edit.file}`;
  } else if (edit.kind === "json-array-value") {
    next = removeJsonArrayValue(text, edit.keyPath, edit.value);
    missing = `no value ${edit.value} in ${edit.keyPath.join(".")}`;
  } else if (edit.kind === "toml-table") {
    next = removeTomlTable(text, edit.keyPath);
    missing = `no TOML table ${edit.keyPath.join(".")} in ${edit.file}`;
  } else {
    next = rewriteMemoryIndex(text, edit.fact);
    missing = `${edit.file} lists no line for ${edit.fact}; the index is untouched`;
  }
  if (next === null) return missing;
  await executors.writeFile(edit.file, next, expectedIdentity);
  await refreshSnapshot([edit.file], snapshot, executors);
  return null;
}

async function runRow(
  row: PlanRow,
  executors: Executors,
  completedBackups: Set<string>,
  snapshot: ConfirmationSnapshot,
): Promise<RowOutcome> {
  if (row.disposition.kind === "refused") {
    return { status: "refused", reason: row.disposition.reason, exitCode: null };
  }
  const backupFailure = await runBackups(row, executors, completedBackups, snapshot);
  if (backupFailure !== null) return { status: "failed", reason: backupFailure, exitCode: null };

  const trashed = await runTrash(row, executors, snapshot);
  if (trashed !== null && trashed.status === "failed") return trashed;

  const notes: string[] = [];
  if (trashed !== null && trashed.reason !== null) notes.push(trashed.reason);
  for (const edit of row.edits) {
    let failure: string | null;
    try {
      // oxlint-disable-next-line no-await-in-loop -- edits are ordered; one file at a time
      failure = await runEdit(edit, executors, snapshot);
    } catch (error) {
      failure = `${edit.file} could not be written: ${messageOf(error)}`;
    }
    if (failure === null) continue;
    // A trashed fact whose index lists no line is still `moved`, with the reason recorded
    // (08 §2); an edit that is the row's whole point fails the row.
    if (row.disposition.kind === "trash") notes.push(failure);
    else return { status: "failed", reason: failure, exitCode: null };
  }

  const { argv, cwd, runnable, kind } = row.disposition;
  if ((kind === "delegate" || kind === "update") && argv !== null) {
    if (!runnable) {
      return {
        status: "refused",
        reason: row.disposition.reason ?? "moldig shows this command and never runs it",
        exitCode: null,
      };
    }
    const result = await executors.spawn({ argv, cwd });
    if (result.exitCode !== 0) {
      const tail = redactProcessFailure(lastLine(result.stderr));
      return {
        status: "failed",
        reason: `exit ${result.exitCode ?? "none"}${tail === "" ? "" : `: ${tail}`}`,
        exitCode: result.exitCode,
      };
    }
    return { status: "delegated", reason: notes.join("; ") || null, exitCode: 0 };
  }
  return { status: statusOf(row), reason: notes.join("; ") || null, exitCode: null };
}

function manifestRow(row: PlanRow, outcome: RowOutcome, at: string | null): ManifestRow {
  return {
    target: {
      ...row.target,
      paths: row.paths,
      bytes: row.bytes,
      backupPaths: row.backups.map((backup) => backup.to),
      flags: row.flags,
      badges: row.badges,
    },
    finding: row.finding,
    disposition: row.disposition,
    tokensPerSession: row.tokensPerSession,
    result: { status: outcome.status, reason: outcome.reason, at, exitCode: outcome.exitCode },
  };
}

function summaryOf(group: PlanGroup, results: Map<string, RowStatus>): ManifestGroupSummary {
  const counted = { moved: 0, edited: 0, delegated: 0, refused: 0, failed: 0, planned: 0 };
  let bytes = 0;
  const tokens: Record<string, number> = {};
  for (const row of group.rows) {
    const status = results.get(row.key) ?? "planned";
    counted[status] += 1;
    if (status === "moved" || status === "edited" || status === "delegated") {
      bytes += row.bytes;
      for (const [harness, value] of Object.entries(row.tokensPerSession)) {
        tokens[harness] = (tokens[harness] ?? 0) + value;
      }
    }
  }
  return {
    rows: group.rows.length,
    bytes,
    tokensPerSession: tokens,
    shared: group.shared,
    ...counted,
  };
}

const alwaysRun = async (): Promise<ConfirmAnswer> => "run";

/**
 * Runs the Plan. `confirm` answers per group and stage (the TUI from keys, the non-interactive
 * path `run`); `mode: "dry-run"` runs nothing at all and leaves every row `planned` (D115).
 */
export async function apply(
  runPlan: Plan,
  executors: Executors,
  options: ApplyOptions = {},
): Promise<RunManifest> {
  const mode = options.mode ?? "run";
  const confirm = options.confirm ?? alwaysRun;
  const progress = options.onProgress ?? ((): void => {});
  const groups = runPlan.groups.filter((group) => group.action !== "open");
  const results = new Map<string, RowStatus>();
  const positionOf = new Map<string, number>();
  const selection: RunManifest["selection"] = [];
  const rows: ManifestRow[] = [];
  const manifestGroups: ManifestGroup[] = [];

  for (const group of groups) {
    for (const row of group.rows) {
      const status: RowStatus = row.disposition.kind === "refused" ? "refused" : "planned";
      if (mode === "run") results.set(row.key, status);
      selection.push({ key: row.key, action: group.action });
      positionOf.set(row.key, rows.length);
      rows.push(
        manifestRow(
          row,
          { status: mode === "run" ? status : "planned", reason: null, exitCode: null },
          null,
        ),
      );
    }
    manifestGroups.push({
      action: group.action,
      confirmation: {
        extraRequired: group.extraConfirmation.required,
        extraReason: group.extraConfirmation.reason,
        answer: null,
      },
      status: "planned",
      summary: summaryOf(group, results),
      rows: group.rows.map((row) => row.key),
    });
  }

  const manifest: RunManifest = {
    schemaVersion: 0,
    run: {
      id: runPlan.runId,
      startedAt: runPlan.startedAt,
      finishedAt: null,
      moldig: runPlan.moldig,
      command: runPlan.command,
      dataDir: runPlan.dataDir,
    },
    mode: mode === "run" ? "run" : "dry-run",
    manifestPath: runPlan.manifestPath,
    backupDir: runPlan.backupDir,
    selection,
    groups: manifestGroups,
    rows,
  };
  if (mode === "dry-run") return manifest;

  let skipRest = false;
  const completedBackups = new Set<string>();
  for (const [index, group] of groups.entries()) {
    const record = manifestGroups[index];
    if (record === undefined) continue;
    // Capture path identity before the user confirms; every side effect revalidates against it.
    let snapshot = new Map<string, StatResult | null>();
    if (!skipRest) {
      // oxlint-disable-next-line no-await-in-loop -- one group is confirmed and run at a time
      snapshot = await snapshotOf(group, executors);
    }
    // oxlint-disable-next-line no-await-in-loop -- one group is confirmed and run at a time
    let answer: ConfirmAnswer = skipRest ? "skip" : await confirm(group, "ask");
    if (answer === "skip-rest") {
      skipRest = true;
      answer = "skip";
    } else if (answer === "run" && group.extraConfirmation.required) {
      // oxlint-disable-next-line no-await-in-loop -- the extra stage follows the first answer
      const extra = await confirm(group, "extra");
      if (extra === "skip-rest") {
        skipRest = true;
        answer = "skip";
      } else answer = extra;
    }
    record.confirmation.answer = skipRest && answer === "skip" ? "skip-rest" : answer;
    if (answer !== "run") {
      record.status = "skipped";
      record.summary = summaryOf(group, results);
      // oxlint-disable-next-line no-await-in-loop -- the manifest lands after every group (D91)
      await executors.writeFile(runPlan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      continue;
    }
    record.status = "ran";
    const projectTrashRows = group.rows.filter(isProjectTrashRow);
    let projectTrashOutcomes = new Map<string, RowOutcome>();
    if (projectTrashRows.length > 0) {
      progress({
        action: group.action,
        completed: 0,
        total: group.rows.length,
        label: `on-disk state for ${projectTrashRows.length} missing ${projectTrashRows.length === 1 ? "project" : "projects"}`,
        status: null,
      });
      // oxlint-disable-next-line no-await-in-loop -- action groups still run in confirmation order
      projectTrashOutcomes = await runProjectTrashRows(projectTrashRows, executors, snapshot).catch(
        (error: unknown) =>
          new Map(
            projectTrashRows.map((row) => [
              row.key,
              {
                status: "failed",
                reason: messageOf(error),
                exitCode: null,
              },
            ]),
          ),
      );
    }
    for (const [rowIndex, row] of group.rows.entries()) {
      const batched = projectTrashOutcomes.get(row.key);
      if (batched === undefined) {
        progress({
          action: group.action,
          completed: rowIndex,
          total: group.rows.length,
          label: row.target.label,
          status: null,
        });
      }
      // Non-Project rows keep their per-row order; Project path rows already moved in one batch.
      let outcome: RowOutcome;
      if (batched !== undefined) outcome = batched;
      else {
        // oxlint-disable-next-line no-await-in-loop -- one failure never aborts the remaining rows
        outcome = await runRow(row, executors, completedBackups, snapshot).catch(
          (error: unknown) => ({
            status: "failed" as RowStatus,
            reason: messageOf(error),
            exitCode: null,
          }),
        );
      }
      results.set(row.key, outcome.status);
      const updated = manifestRow(row, outcome, executors.now().toISOString());
      const position = positionOf.get(row.key);
      if (position === undefined) manifest.rows.push(updated);
      else manifest.rows[position] = updated;
      progress({
        action: group.action,
        completed: rowIndex + 1,
        total: group.rows.length,
        label: row.target.label,
        status: outcome.status,
      });
    }
    record.summary = summaryOf(group, results);
    // oxlint-disable-next-line no-await-in-loop -- the manifest lands after every group (D91)
    await executors.writeFile(runPlan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  manifest.run.finishedAt = executors.now().toISOString();
  await executors.writeFile(runPlan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
