/**
 * `apply(plan, executors)` — the Plan runs, group by group, in confirmation order
 * (Clean → Delete → Update; Open is never executed and never lands in the manifest). Every
 * side effect is an injected executor, a failed row never aborts its group nor the run
 * (08 §3, 14 §3), and the manifest is written after every group and rewritten at the end (D91).
 *
 * Per row, always in this order: the backups, then the trash, then the edits, then the
 * delegate. Nothing is decided here — `plan()` decided it all before anything moved.
 */
import { removeJsonEntry, rewriteMemoryIndex } from "./edits.js";
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

async function runBackups(row: PlanRow, executors: Executors): Promise<string | null> {
  for (const backup of row.backups) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- a backup must land before the next step
      await executors.backup(backup.path, backup.to);
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
async function runTrash(row: PlanRow, executors: Executors): Promise<RowOutcome | null> {
  if (row.paths.length === 0) return null;
  const present: string[] = [];
  for (const path of row.paths) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of members per unit
    const found = await executors.stat(path);
    if (found?.exists === true) present.push(path);
  }
  if (present.length === 0) {
    return { status: "moved", reason: "every path was already gone", exitCode: null };
  }
  const result = await executors.trash(present);
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

/** The two edit shapes; both write atomically (a temp file in the same directory + rename). */
async function runEdit(edit: PlanEdit, executors: Executors): Promise<string | null> {
  // Re-read immediately before rewriting: worktrees share the directory, no lock is documented.
  const text = await executors.readFile(edit.file);
  if (text === null) return `${edit.file} could not be read`;
  if (edit.kind === "json-entry") {
    const next = removeJsonEntry(text, edit.keyPath);
    if (next === null) return `no entry ${edit.keyPath.join(".")} in ${edit.file}`;
    await executors.writeFile(edit.file, next);
    return null;
  }
  const next = rewriteMemoryIndex(text, edit.fact);
  if (next === null) return `${edit.file} lists no line for ${edit.fact}; the index is untouched`;
  await executors.writeFile(edit.file, next);
  return null;
}

async function runRow(row: PlanRow, executors: Executors): Promise<RowOutcome> {
  if (row.disposition.kind === "refused") {
    return { status: "refused", reason: row.disposition.reason, exitCode: null };
  }
  const backupFailure = await runBackups(row, executors);
  if (backupFailure !== null) return { status: "failed", reason: backupFailure, exitCode: null };

  const trashed = await runTrash(row, executors);
  if (trashed !== null && trashed.status === "failed") return trashed;

  const notes: string[] = [];
  if (trashed !== null && trashed.reason !== null) notes.push(trashed.reason);
  for (const edit of row.edits) {
    let failure: string | null;
    try {
      // oxlint-disable-next-line no-await-in-loop -- edits are ordered; one file at a time
      failure = await runEdit(edit, executors);
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
      const tail = lastLine(result.stderr);
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
  for (const [index, group] of groups.entries()) {
    const record = manifestGroups[index];
    if (record === undefined) continue;
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
    for (const row of group.rows) {
      // oxlint-disable-next-line no-await-in-loop -- rows run in order; one failure never aborts
      const outcome = await runRow(row, executors).catch((error: unknown) => ({
        status: "failed" as RowStatus,
        reason: messageOf(error),
        exitCode: null,
      }));
      results.set(row.key, outcome.status);
      const updated = manifestRow(row, outcome, executors.now().toISOString());
      const position = positionOf.get(row.key);
      if (position === undefined) manifest.rows.push(updated);
      else manifest.rows[position] = updated;
    }
    record.summary = summaryOf(group, results);
    // oxlint-disable-next-line no-await-in-loop -- the manifest lands after every group (D91)
    await executors.writeFile(runPlan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  manifest.run.finishedAt = executors.now().toISOString();
  await executors.writeFile(runPlan.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
