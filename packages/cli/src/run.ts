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
import { audit, HARNESSES, scan, type AuditIndex, type Finding, type Index } from "@moldig/core";
import { parseArgs, severityRank, type Options } from "./args.js";
import { helpPage, usageSynopsis } from "./help.js";
import { createPalette } from "./palette.js";
import { auditReport, scanReport, type ReportStyle } from "./report.js";
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
  if (!io.isTTY && !options.yes) {
    return `moldig clean: no terminal to confirm in. Re-run with --yes and a filter (${filters}) to run unattended, or --dry-run to print the plan.`;
  }
  if (options.yes && !hasFilter) {
    return `moldig clean: --yes needs a filter as well (${filters}), so an unattended run can never remove more than it was told to.`;
  }
  return null;
}

/**
 * `clean` in this slice: the refusal path is real, the sweep is not. The actions engine is
 * ticket 24 and the selection panel ticket 26; nothing here pretends to have run either.
 */
function runClean(io: Io, options: Options): number {
  const out = writer(io.stdout);
  if (options.dryRun) {
    out("clean --dry-run is not implemented until the actions engine lands (ticket 24)");
    return 0;
  }
  const refusal = cleanRefusal(io, options);
  if (refusal !== null) {
    io.stderr(`${refusal}\n`);
    return 2;
  }
  out(
    options.yes
      ? "clean --yes is not implemented until the actions engine lands (ticket 24); nothing was removed"
      : "the clean selection panel arrives with ticket 26; nothing was removed",
  );
  return 0;
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

    if (options.command === "clean") return runClean(io, options);

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

    // `audit`, and `moldig` without a command: the audit output is what the TUI prints until
    // ticket 26 lands [D5, D14, D132]. `audit()` can add a Warning of its own, so the document
    // is built before anything is written.
    const audited =
      options.command === "scan"
        ? null
        : filtered(await audit(index, { readSignal: options.readSignal }), options);
    const document: Index = audited ?? index;

    const err = writer(io.stderr);
    for (const line of warningLines(document)) err(line);
    // D21: the CLI says which Harnesses it read; the index carries no partial-scan Warning.
    if (index.harnesses.length < HARNESSES.length) {
      const names = index.harnesses.map((harness) => harness.displayName).join(", ");
      err(`warning: scanning only: ${names.length === 0 ? "no Harness" : names}`);
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
        if (options.command === "default" && io.isTTY) {
          out("");
          out(
            "The interactive experience arrives with ticket 26; this is what moldig audit prints.",
          );
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
