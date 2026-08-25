// THROWAWAY PROTOTYPE (ticket 09) — entry point of the Ink 7 TUI prototype.
//
//   bun run proto                    the rich fake index (default: --fake)
//   bun run proto -- --fixture       claude-code/breadcrumbs through scan() + audit()
//   bun run proto -- --summary       print only the shareable summary, no TUI
//   bun run proto -- --no-alt        inline instead of the alternate screen (debugging)
//
// Non-TTY (piped) runs render the final frame only and then print the summary; exit 0.
import { type AuditIndex, audit, scan } from "@moldig/core";
import { loadFixture } from "@moldig/core/testing";
import { render } from "ink";
import os from "node:os";
import { App } from "./App.js";
import { fakeIndex } from "./data/fake-index.js";
import { supportsHyperlinks } from "./lib/hyperlink.js";
import { initialMarks } from "./lib/selection.js";
import { summaryText } from "./lib/summary.js";

interface Args {
  readonly fake: boolean;
  readonly fixture: string | null;
  readonly summary: boolean;
  readonly noAlt: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  let fake = true;
  let fixture: string | null = null;
  let summary = false;
  let noAlt = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--fake") fake = true;
    else if (arg === "--fixture") {
      fake = false;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        fixture = next;
        i++;
      } else fixture = "claude-code/breadcrumbs";
    } else if (arg === "--summary") summary = true;
    else if (arg === "--no-alt") noAlt = true;
    else if (arg === "--help" || arg === "-h") {
      process.stdout.write("moldig proto [--fake] [--fixture [case]] [--summary] [--no-alt]\n");
      process.exit(0);
    }
  }
  return { fake, fixture, summary, noAlt };
}

async function loadIndex(args: Args): Promise<{ index: AuditIndex; cleanup: () => Promise<void> }> {
  if (args.fake || args.fixture === null) return { index: fakeIndex, cleanup: async () => {} };
  // The fixture path: the helper of ticket 15 + the Claude Code adapter slice (scan + audit).
  const tree = await loadFixture(args.fixture);
  try {
    const scanned = await scan({
      home: tree.home,
      roots: tree.roots,
      cwd: tree.path("root/project-a"),
      platform: tree.platform,
      env: tree.env,
      git: false,
    });
    return { index: await audit(scanned), cleanup: () => tree.cleanup() };
  } catch (error) {
    await tree.cleanup();
    throw error;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { index, cleanup } = await loadIndex(args);
  const env = process.env;
  const platform = process.platform;
  const isTTY = process.stdout.isTTY;
  const interactive = isTTY && process.stdin.isTTY && !args.summary;

  if (args.summary) {
    process.stdout.write(
      summaryText({
        index,
        marks: initialMarks(index),
        run: null,
        home: index.scan.home,
        platform,
      }),
    );
    await cleanup();
    return;
  }

  let latest = summaryText({
    index,
    marks: initialMarks(index),
    run: null,
    home: index.scan.home,
    platform,
  });
  const app = render(
    <App
      index={index}
      env={env}
      platform={platform}
      hostname={os.hostname()}
      interactive={interactive}
      linksSupported={supportsHyperlinks(env, isTTY)}
      onSummary={(text) => {
        latest = text;
      }}
    />,
    {
      alternateScreen: interactive && !args.noAlt,
      exitOnCtrlC: true,
      interactive,
      patchConsole: interactive,
    },
  );

  if (!interactive) {
    // Ink writes the final frame at unmount when non-interactive: let the overview render once.
    await app.waitUntilRenderFlush();
    app.unmount();
  }
  const result = await app.waitUntilExit();
  // The alternate screen is gone here: the shareable summary lands on the primary screen.
  process.stdout.write(`\n${typeof result === "string" ? result : latest}`);
  await cleanup();
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
