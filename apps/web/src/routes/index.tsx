import { createFileRoute } from "@tanstack/react-router";
import { CommandHero } from "../components/command-hero";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main className="isolate mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-20">
      <CommandHero />

      <aside
        aria-labelledby="early-development-title"
        className="mt-10 rounded-xl border border-amber-600/20 bg-amber-50/70 p-4 sm:p-5 dark:border-amber-300/15 dark:bg-amber-300/5"
      >
        <div className="flex gap-3">
          <span
            aria-hidden="true"
            className="mt-2 size-2 shrink-0 rounded-full bg-amber-600 dark:bg-amber-300"
          />
          <div className="min-w-0">
            <p
              id="early-development-title"
              className="font-mono text-base font-medium text-amber-950 sm:text-sm dark:text-amber-100"
            >
              Early development · not recommended for regular use
            </p>
            <p className="mt-1 max-w-[72ch] text-pretty text-base/7 text-amber-950/75 sm:text-sm/6 dark:text-amber-100/70">
              moldig is not stable yet and still needs substantial testing and hardening before it
              can be relied on. Contributions, bug reports, and feedback are welcome through{" "}
              <a
                className="font-medium text-amber-950 underline decoration-amber-700/30 underline-offset-4 transition-colors hover:decoration-amber-700 dark:text-amber-100 dark:decoration-amber-200/30 dark:hover:decoration-amber-200"
                href="https://github.com/guillermolg00/moldig/issues"
                rel="noreferrer"
              >
                GitHub issues
              </a>{" "}
              and{" "}
              <a
                className="font-medium text-amber-950 underline decoration-amber-700/30 underline-offset-4 transition-colors hover:decoration-amber-700 dark:text-amber-100 dark:decoration-amber-200/30 dark:hover:decoration-amber-200"
                href="https://github.com/guillermolg00/moldig/pulls"
                rel="noreferrer"
              >
                pull requests
              </a>
              .
            </p>
          </div>
        </div>
      </aside>

      <h1 className="mt-24 mb-5 text-2xl font-semibold tracking-tight sm:text-3xl">
        Clean up everything your AI tools leave behind, all in one place.
      </h1>

      <div className="max-w-[68ch] space-y-4 text-[17px]/relaxed text-muted dark:text-muted-dark">
        <p>
          Every harness you try leaves its own copy of everything behind: skills installed six times
          over, the same MCP server configured in five files, context files piling up in every
          repository you opened last year, and transcripts and caches growing quietly into
          gigabytes.
        </p>
        <p>
          moldig makes one read-only pass over all of it, shows what every session costs you in
          tokens before you have typed anything, and cleans only where you say so.
        </p>
      </div>

      <p className="mt-8 text-[15px] text-muted/80 dark:text-muted-dark/80">
        No install, no account, no configuration file, no telemetry. macOS, Linux and Windows.
      </p>
    </main>
  );
}
