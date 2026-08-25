// THROWAWAY PROTOTYPE (ticket 09) — screen 1: scan progress with the mascot placeholder
// and one line per harness with its counts; auto-advances to the overview.
import { Box, Text } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { Frame } from "../components/Frame.js";
import { formatBytes, plural } from "../lib/format.js";
import { useStore } from "../lib/store.js";

const STEPS = 10;

const MASCOT = [
  " ┌─────────┐ ",
  " │  ◕   ◕  │ ",
  " │    ▽    │   moldig",
  " │  ─────  │   digging through what your harnesses left behind…",
  " └─────────┘ ",
];

export function ScanScreen({ onDone }: { readonly onDone: () => void }): ReactElement {
  const { index } = useStore();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const timer = setTimeout(
      () => {
        if (tick >= STEPS) onDone();
        else setTick(tick + 1);
      },
      tick >= STEPS ? 350 : 110,
    );
    return () => clearTimeout(timer);
  }, [tick, onDone]);

  const progress = tick / STEPS;
  const scaled = (n: number): number => Math.round(n * progress);

  return (
    <Frame title="scan" keys="scanning… · q quit">
      <Box flexDirection="column" paddingTop={1}>
        {MASCOT.map((line, i) => (
          <Text key={String(i)} color="cyan">
            {line}
          </Text>
        ))}
        <Box flexDirection="column" paddingTop={1}>
          {index.harnesses.map((h) => {
            const projects = index.projects.filter(
              (p) => p.perHarness[h.harness] !== undefined,
            ).length;
            const entities = index.entities.filter((e) => e.harness === h.harness);
            const cacheBytes = entities
              .filter((e) => e.kind === "harness-cache")
              .reduce((acc, e) => acc + e.metrics.bytes, 0);
            const done = tick >= STEPS;
            return (
              <Text key={h.id}>
                <Text color={done ? "green" : "yellow"}>{done ? "✓" : "…"} </Text>
                <Text bold>{h.displayName.padEnd(12)}</Text>
                <Text>
                  {plural(scaled(projects), "project")} ·{" "}
                  {plural(scaled(entities.length), "entity", "entities")} ·{" "}
                  {formatBytes(scaled(cacheBytes))} harness cache
                </Text>
              </Text>
            );
          })}
        </Box>
        <Box paddingTop={1}>
          <Text dimColor>
            {"█".repeat(tick * 3)}
            {"░".repeat((STEPS - tick) * 3)}{" "}
            {index.scan.roots.length > 0
              ? `roots: ${index.scan.roots.join(", ")}`
              : "no root: every project the breadcrumbs name"}
          </Text>
        </Box>
      </Box>
    </Frame>
  );
}
