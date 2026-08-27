/**
 * `runCli` — the whole CLI behind one testable seam. Everything the process provides (the two
 * streams, the terminal, the environment, the working directory, the home directory, the clock)
 * arrives as `Io`, so the tests drive real commands over a fixture tree without spawning a
 * process or touching a real home directory. `main.ts` is the only file that reads `process`.
 *
 * stdout carries the report and nothing else; every Warning goes to stderr as one line (spec
 * § "stdout / stderr contract"). Exit codes: 0 nothing to report, 1 Findings at or above
 * `--fail-on`, 2 a usage or environment error or a refused `clean` [D2, D3, D4, D18, D23].
 */
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  audit,
  dataDirFor,
  HARNESSES,
  scan,
  type AuditIndex,
  type Executors,
  type Finding,
  type Index,
} from "@moldig/core";
import { parseArgs, severityRank, type Options } from "./args.js";
import {
  applyPlan,
  cleanPlan,
  dryRun,
  exitCodeFor,
  planLines,
  planSummaryLines,
  summaryFor,
  type CleanContext,
} from "./clean.js";
import { createDeviceProbe, createExecutors, ensureDirFor } from "./executors/index.js";
import { helpPage, usageSynopsis } from "./help.js";
import { createPalette } from "./palette.js";
import { auditReport, scanReport, type ReportStyle } from "./report.js";
import type { OpenTui } from "./tui/index.js";
import { createRunner } from "./tui/lib/runner.js";
import { initialMarks } from "./tui/lib/selection.js";
import { summaryText } from "./tui/lib/summary.js";
import { moldigVersion } from "./version.js";

export interface Io {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  isTTY: boolean;
  columns: number;
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
  /**
   * The platform the scan runs as; defaults to the host's. Pinned by the snapshot tests so one
   * snapshot holds on every operating system (D100).
   */
  platform?: NodeJS.Platform;
  /** Deterministic `generatedAt` and `ageDays`; defaults to the real clock. */
  now?: Date;
  /** stdin's TTY-ness: the TUI needs both streams to be terminals; `isTTY` covers stdout only. */
  stdinIsTTY?: boolean;
  /**
   * The interactive TUI, injected by `main.ts` so `runCli` stays free of Ink and the tests can
   * drive the decision to open it without a terminal. Absent = the printed report path.
   */
  openTui?: OpenTui;
  /**
   * Everything the actions engine can do to the disk (08 §9). Injected by the tests so a run
   * over a fixture tree never reaches the real trash; defaults to the real executors.
   */
  executors?: Executors;
}

const PLATFORMS = ["darwin", "linux", "win32"] as const;
type Platform = (typeof PLATFORMS)[number];

function isSupported(platform: NodeJS.Platform): platform is Platform {
  return (PLATFORMS as readonly string[]).includes(platform);
}

/** Widest report; a wider terminal only makes the Finding column longer than it needs to be. */
const MAX_WIDTH = 120;
const MIN_WIDTH = 60;

function writer(sink: (chunk: string) => void): (line: string) => void {
  return (line) => {
    sink(`${line}\n`);
  };
}

/** One line on stderr and the usage synopsis, exit 2 (spec § "Usage errors"). */
function usageError(io: Io, message: string): number {
  io.stderr(`moldig: ${message}\n`);
  io.stderr(usageSynopsis());
  return 2;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `warning <code>: <message> [<harness>] <path>` — the format the spec fixes. One line per
 * Warning, always: a message that carries a newline of its own (a spawn failure quoting the
 * command it ran) is folded back onto one line here.
 */
function warningLines(index: Index): string[] {
  return index.warnings.map((warning) => {
    const message = warning.message.replaceAll(/\s+/gu, " ").trim();
    const harness = warning.harness === null ? "" : ` [${warning.harness}]`;
    const path = warning.path === null ? "" : ` ${warning.path}`;
    return `warning ${warning.code}: ${message}${harness}${path}`;
  });
}

function keep(finding: Finding, options: Options): boolean {
  if (options.categories.length > 0 && !options.categories.includes(finding.category)) return false;
  if (
    options.severity !== null &&
    severityRank(finding.severity) < severityRank(options.severity)
  ) {
    return false;
  }
  return true;
}

/** D15: `--category` / `--severity` filter the table, `findings[]` and the `--fail-on` check. */
function filtered(index: AuditIndex, options: Options): AuditIndex {
  if (options.categories.length === 0 && options.severity === null) return index;
  return { ...index, findings: index.findings.filter((finding) => keep(finding, options)) };
}

function exitFor(index: AuditIndex, options: Options): number {
  if (options.failOn === "never") return 0;
  const threshold = severityRank(options.failOn);
  return index.findings.some((finding) => severityRank(finding.severity) >= threshold) ? 1 : 0;
}

function serialise(document: unknown, pretty: boolean): string {
  return `${JSON.stringify(document, null, pretty ? 2 : undefined)}\n`;
}

/** D124: an unattended `clean` needs both `--yes` and a filter, and is told which is missing. */
function cleanRefusal(io: Io, options: Options): string | null {
  const hasFilter =
    options.categories.length > 0 || options.olderThanDays !== null || options.harnesses.length > 0;
  const filters = "--category <c>, --older-than <days>, --harness <id>";
  // D4: nothing can be confirmed without a terminal, so the message is the same even when a
  // filter is given. `--json` is a document, not a place to answer a question, either.
  if (!canOpenPanel(io, options) && !options.yes) {
    return `moldig clean: no terminal to confirm in. Re-run with --yes and a filter (${filters}) to run unattended, or --dry-run to print the plan.`;
  }
  if (options.yes && !hasFilter) {
    return `moldig clean: --yes needs a filter as well (${filters}), so an unattended run can never remove more than it was told to.`;
  }
  return null;
}

/**
 * Unattended `clean` (§1.10): the plan on stdout before the run, the run itself, the shareable
 * summary after it — or, with `--json`, the run manifest and nothing else. `--dry-run` prints
 * the same plan (as the manifest document with `--json`, D115) and writes nothing at all.
 */
async function runClean(io: Io, options: Options, context: CleanContext): Promise<number> {
  const out = writer(io.stdout);
  const runPlan = cleanPlan(options, context);
  const rows = runPlan.groups.reduce((sum, group) => sum + group.count, 0);

  if (options.dryRun) {
    if (options.json) {
      io.stdout(serialise(await dryRun(runPlan, context), options.pretty));
      return 0;
    }
    for (const line of planLines(runPlan, context.index)) out(line);
    if (rows > 0) out("");
    for (const line of planSummaryLines(runPlan, context.index)) out(line);
    out("dry run: nothing was moved, and no manifest and no backup were written.");
    return 0;
  }

  if (!options.json) {
    for (const line of planLines(runPlan, context.index)) out(line);
    if (rows > 0) out("");
  }
  const manifest = await applyPlan(runPlan, context);
  if (options.json) {
    io.stdout(serialise(manifest, options.pretty));
  } else {
    for (const line of summaryFor(manifest, context.index)) out(line);
  }
  return exitCodeFor(manifest);
}

/**
 * Whether the selection panel can be opened at all: both streams are terminals, the TUI is
 * there, and stdout is not carrying a JSON document instead (D4, D14, D20).
 */
function canOpenPanel(io: Io, options: Options): boolean {
  return io.isTTY && io.stdinIsTTY === true && io.openTui !== undefined && !options.json;
}

/**
 * D1/D4: `moldig` with no command and `moldig clean` open the TUI, but only on a real terminal
 * with both streams attached. `--json` is always the audit document (D14) and the unattended
 * `clean` flags stay on the printed path.
 */
function wantsTui(io: Io, options: Options): boolean {
  if (!canOpenPanel(io, options)) return false;
  if (options.command === "default") return true;
  return options.command === "clean" && !options.dryRun && !options.yes;
}

/** The shareable summary: what the TUI prints on leaving, and what a pipe prints after the table. */
function previewSummary(index: AuditIndex, platform: NodeJS.Platform): string {
  return summaryText({
    index,
    marks: initialMarks(index),
    run: null,
    home: index.scan.home,
    platform,
  });
}

async function resolveRoots(io: Io, options: Options): Promise<string[] | { error: string }> {
  const roots: string[] = [];
  for (const raw of options.roots) {
    const root = resolve(io.cwd, raw);
    // oxlint-disable-next-line no-await-in-loop -- a handful of Roots; the first bad one wins
    const found = await stat(root).catch(() => null);
    if (found === null) return { error: `no such directory: ${root}` };
    if (!found.isDirectory()) return { error: `not a directory: ${root}` };
    roots.push(root);
  }
  return roots;
}

export async function runCli(argv: readonly string[], io: Io): Promise<number> {
  try {
    const parsed = parseArgs(argv);
    if (!parsed.ok) return usageError(io, parsed.message);
    const { options } = parsed;

    if (options.help) {
      io.stdout(helpPage(options.command));
      return 0;
    }
    if (options.version) {
      io.stdout(`${await moldigVersion()}\n`);
      return 0;
    }

    // D125: an unsupported platform is a usage error; it is never recorded as `darwin`.
    const platform = io.platform ?? process.platform;
    if (!isSupported(platform)) {
      return usageError(io, `moldig runs on ${PLATFORMS.join(", ")}, not on ${platform}`);
    }

    const interactive = wantsTui(io, options);
    // A refusal costs nothing: it is decided before the scan, not after it (D4, D124).
    if (options.command === "clean" && !interactive && !options.dryRun) {
      const refusal = cleanRefusal(io, options);
      if (refusal !== null) {
        io.stderr(`${refusal}\n`);
        return 2;
      }
    }

    const roots = await resolveRoots(io, options);
    if (!Array.isArray(roots)) return usageError(io, roots.error);

    const index = await scan({
      home: io.home,
      roots,
      cwd: io.cwd,
      platform,
      env: io.env,
      git: options.git,
      ...(options.harnesses.length > 0 ? { harnesses: options.harnesses } : {}),
      ...(io.now === undefined ? {} : { now: io.now }),
    });

    // `audit`, and `moldig` without a command. `audit()` can add a Warning of its own, so the
    // document is built before anything is written.
    const audited =
      options.command === "scan"
        ? null
        : filtered(await audit(index, { readSignal: options.readSignal }), options);
    const document: Index = audited ?? index;

    const err = writer(io.stderr);
    const warnings = warningLines(document);
    // D21: the CLI says which Harnesses it read; the index carries no partial-scan Warning.
    if (index.harnesses.length < HARNESSES.length) {
      const names = index.harnesses.map((harness) => harness.displayName).join(", ");
      warnings.push(`warning: scanning only: ${names.length === 0 ? "no Harness" : names}`);
    }
    // The TUI takes the alternate screen next, which would swallow them: they are written when
    // it gives the terminal back, right before the summary.
    if (!interactive) for (const line of warnings) err(line);

    // Both ways into the actions engine share one context: the same executors, the same data
    // directory, the same clock (08 §9). Nothing in it writes until a group is confirmed.
    const clock = io.now;
    const deviceOf = createDeviceProbe({ home: io.home, platform });
    const context = (auditedIndex: AuditIndex, version: string): CleanContext => ({
      index: auditedIndex,
      executors: io.executors ?? createExecutors(clock === undefined ? {} : { now: () => clock }),
      dataDir: dataDirFor({ platform, env: io.env, home: io.home }),
      platform,
      home: io.home,
      deviceOf,
      version,
      command: ["moldig", ...argv].join(" "),
    });

    const openTui = io.openTui;
    if (interactive && audited !== null && openTui !== undefined) {
      const outcome = await openTui({
        index: audited,
        env: io.env,
        platform,
        runner: createRunner({
          ...context(audited, await moldigVersion()),
          prepare: (runPlan) => ensureDirFor(runPlan.manifestPath),
        }),
      });
      for (const line of warnings) err(line);
      io.stdout(`\n${outcome.summary}`);
      // D17: leaving is 0, even with nothing done; one failed row makes the run 1.
      return outcome.failedRows > 0 ? 1 : 0;
    }

    if (options.command === "clean" && audited !== null) {
      return runClean(io, options, context(audited, await moldigVersion()));
    }

    if (options.json) {
      io.stdout(serialise(document, options.pretty));
    } else {
      const style: ReportStyle = {
        palette: createPalette(io),
        width: Math.max(MIN_WIDTH, Math.min(io.columns, MAX_WIDTH)),
      };
      const out = writer(io.stdout);
      if (audited === null) {
        for (const line of scanReport(index, style)) out(line);
      } else {
        for (const line of auditReport(audited, style)) out(line);
        // D5, D132: `moldig` outside a terminal prints the table the TUI would show, then the
        // same shareable summary the TUI leaves behind.
        if (options.command === "default") {
          out("");
          io.stdout(previewSummary(audited, platform));
        }
      }
    }
    if (audited === null || options.command === "default") return 0;
    return exitFor(audited, options);
  } catch (error) {
    io.stderr(`moldig: ${messageOf(error)}\n`);
    return 2;
  }
}
