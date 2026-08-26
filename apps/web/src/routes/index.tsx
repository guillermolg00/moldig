import { createFileRoute } from "@tanstack/react-router";
import { CommandHero } from "../components/command-hero";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return (
    <main className="mx-auto max-w-6xl px-5 py-14 sm:px-8 sm:py-20">
      <CommandHero />

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
