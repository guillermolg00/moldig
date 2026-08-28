/**
 * The TUI entry point: mount Ink on the real streams, wait for the user to leave, and hand the
 * shareable summary back so `run.ts` can write it on the primary screen.
 *
 * The alternate screen is left at unmount — `waitUntilExit()` settles after Ink's own writes —
 * so whatever the caller prints next is the last thing in the scrollback.
 */
import type { AuditIndex, RunManifest } from "@moldig/core";
import { render } from "ink";
import { hostname } from "node:os";
import { App } from "./app.js";
import { recommendedCleanMarks } from "./lib/clean-plan.js";
import { type Env, supportsHyperlinks } from "./lib/hyperlink.js";
import { runTotals, type Runner } from "./lib/runner.js";
import { initialMarks, type Refusal } from "./lib/selection.js";
import { type RefreshTui, type Route } from "./lib/store.js";
import { summaryText } from "./lib/summary.js";

export interface TuiRequest {
  readonly index: AuditIndex;
  readonly env: Env;
  readonly platform: string;
  /** Optional test or embedding override; normal interactive runs open on the cleanup menu. */
  readonly initialRoute?: Route;
  readonly runner: Runner;
  /** Re-scan hook used after Project-level deletion. */
  readonly refresh?: RefreshTui;
  readonly stdout?: NodeJS.WriteStream;
  readonly stdin?: NodeJS.ReadStream;
}

export interface TuiOutcome {
  /** The shareable summary, ready to be written on the primary screen. */
  readonly summary: string;
  /** D17: one failed row makes the whole run exit 1. */
  readonly failedRows: number;
}

/** The port `run.ts` calls: injected by `main.ts`, so the CLI seam never imports Ink. */
export type OpenTui = (request: TuiRequest) => Promise<TuiOutcome>;

export async function openTui(request: TuiRequest): Promise<TuiOutcome> {
  const { index, env, platform } = request;
  const stdout = request.stdout ?? process.stdout;
  const stdin = request.stdin ?? process.stdin;
  const { runner } = request;
  const refusal: Refusal = (entity) => runner.refusal(entity);
  const interactive = stdout.isTTY && stdin.isTTY;
  const initialRoute = request.initialRoute;
  const marks =
    initialRoute?.screen === "clean-plan"
      ? recommendedCleanMarks(index, initialRoute.scope, refusal)
      : initialRoute?.screen === "update-plan" ||
          (initialRoute?.screen === "project-cleanup" && initialRoute.standalone === true)
        ? new Map()
        : initialMarks(index, refusal);
  const label =
    initialRoute?.screen === "clean-plan" && initialRoute.scope.kind === "global"
      ? "moldig · all projects"
      : initialRoute?.screen === "project-cleanup" && initialRoute.standalone === true
        ? "moldig purge"
        : initialRoute?.screen === "update-plan" && initialRoute.standalone === true
          ? "moldig update"
          : undefined;

  let latest = summaryText({
    index,
    marks,
    run: null,
    home: index.scan.home,
    platform,
    refusal,
    ...(label === undefined ? {} : { label }),
  });
  let lastRun: RunManifest | null = null;

  const app = render(
    <App
      index={index}
      env={env}
      platform={platform}
      hostname={hostname()}
      interactive={interactive}
      linksSupported={supportsHyperlinks(env, stdout.isTTY)}
      runner={runner}
      {...(request.refresh === undefined ? {} : { refresh: request.refresh })}
      {...(request.initialRoute === undefined ? {} : { initialRoute: request.initialRoute })}
      onSummary={(text) => {
        latest = text;
      }}
      onRun={(run) => {
        lastRun = run;
      }}
    />,
    {
      stdout,
      stdin,
      alternateScreen: interactive,
      exitOnCtrlC: true,
      interactive,
      // Ink's console patch needs `console.Console`; a test runner that swaps the global
      // console away has none, and crashing there would be a poor trade for tidy output.
      patchConsole: interactive && typeof console.Console === "function",
    },
  );

  if (!interactive) {
    // Ink writes only the final frame when non-interactive: let one render land, then leave.
    await app.waitUntilRenderFlush();
    app.unmount();
  }
  const result: unknown = await app.waitUntilExit();
  const summary = typeof result === "string" ? result : latest;
  // `lastRun` is assigned from a React effect, so TypeScript cannot see the write.
  const run = lastRun as RunManifest | null;
  return { summary, failedRows: run === null ? 0 : runTotals(run).counts.failed };
}
