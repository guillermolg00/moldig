import { useEffect, useState } from "react";
import { COMMANDS, RUNNERS } from "../data/commands";
import { Wheel } from "./wheel";

const RUNNER_ITEMS = RUNNERS.map((runner) => ({ id: runner.id, label: runner.token }));
const COMMAND_ITEMS = COMMANDS.map((command) => ({
  id: command.id,
  label: command.label,
  quiet: command.token === "",
}));

export function CommandHero() {
  const [runnerIndex, setRunnerIndex] = useState(0);
  const [commandIndex, setCommandIndex] = useState(2);
  const [copied, setCopied] = useState(false);

  const runner = RUNNERS[runnerIndex] ?? RUNNERS[0]!;
  const command = COMMANDS[commandIndex] ?? COMMANDS[0]!;
  const commandLine = `${runner.token} moldig${command.token ? ` ${command.token}` : ""}`;

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1800);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    navigator.clipboard
      ?.writeText(commandLine)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <section className="grid items-center gap-10 lg:grid-cols-2 lg:gap-14">
      <div>
        <div className="relative">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-1/2 h-11 -translate-y-1/2 rounded-xl border border-line bg-surface dark:border-line-dark dark:bg-surface-dark"
          />
          <div className="relative flex items-center justify-center gap-x-3 text-base sm:gap-x-5 sm:text-xl lg:text-2xl">
            <Wheel
              items={RUNNER_ITEMS}
              index={runnerIndex}
              onIndexChange={setRunnerIndex}
              align="end"
              label="runner"
            />
            <span className="font-mono font-medium">moldig</span>
            <Wheel
              items={COMMAND_ITEMS}
              index={commandIndex}
              onIndexChange={setCommandIndex}
              align="start"
              label="command"
            />
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            onClick={copy}
            className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px] text-muted transition-colors hover:border-accent/40 hover:text-accent dark:border-line-dark dark:text-muted-dark dark:hover:border-accent-dark/40 dark:hover:text-accent-dark"
          >
            <CopyGlyph done={copied} />
            {copied ? "Copied" : "Copy"}
            <span className="sr-only">{commandLine}</span>
          </button>
          <p className="text-[13px] text-muted/70 dark:text-muted-dark/70">
            Scroll, drag or click either wheel
          </p>
        </div>
      </div>

      <div aria-live="polite" className="max-w-[46ch]">
        <div key={command.id} className="animate-rise">
          <p className="text-xl font-semibold tracking-tight sm:text-2xl">{command.headline}</p>
          <p className="mt-3 text-[17px]/relaxed text-muted dark:text-muted-dark">
            {command.blurb}
          </p>
        </div>
      </div>
    </section>
  );
}

function CopyGlyph({ done }: { done: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {done ? (
        <path d="M3 8.5 6.4 12 13 4.5" />
      ) : (
        <>
          <rect x="5.5" y="5.5" width="8" height="8" rx="1.6" />
          <path d="M10.5 3.5a1.6 1.6 0 0 0-1.6-1.6H4a1.6 1.6 0 0 0-1.6 1.6v5a1.6 1.6 0 0 0 1.6 1.6" />
        </>
      )}
    </svg>
  );
}
