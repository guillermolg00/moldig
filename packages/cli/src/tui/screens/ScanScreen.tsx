/**
 * Screen 1 — Scan: the mascot, one line per harness with its real counts as it completes, and
 * an auto-advance to the Overview. Skipped when the run is not interactive.
 *
 * The counts are never invented: a harness line stays `…` with no numbers until its turn, then
 * shows what the index actually holds for it. `scan()` exposes no progress hook yet, so the
 * reveal is staged here rather than driven by the scanner; when core gains per-harness events
 * this screen only changes where `done` comes from.
 */
import { Box, Text } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { Frame } from "../components/Frame.js";
import { formatBytes, plural } from "../lib/format.js";
import { useStore } from "../lib/store.js";

/** D99: a fixed four-line ASCII mark, no colour. */
const MASCOT: readonly string[] = ["  ╭───────╮", "  │ ●   ● │", "  │   ▾   │", "  ╰──┬─┬──╯"];

const STEP_MS = 40;
const HOLD_MS = 120;
const BAR_CELLS = 3;

export function ScanScreen({ onDone }: { readonly onDone: () => void }): ReactElement {
  const { index } = useStore();
  const total = index.harnesses.length;
  const [done, setDone] = useState(0);

  useEffect(() => {
    const timer = setTimeout(
      () => {
        if (done >= total) onDone();
        else setDone(done + 1);
      },
      done >= total ? HOLD_MS : STEP_MS,
    );
    return () => {
      clearTimeout(timer);
    };
  }, [done, total, onDone]);

  return (
    <Frame title="scan" keys="scanning… · q quit">
      <Box flexDirection="column" paddingTop={1}>
        {MASCOT.map((line, i) => (
          <Text key={String(i)}>
            {line}
            {i === 1 ? "   moldig" : ""}
            {i === 2 ? "   digging through what your harnesses left behind…" : ""}
          </Text>
        ))}
        <Box flexDirection="column" paddingTop={1}>
          {index.harnesses.map((harness, i) => {
            const complete = i < done;
            const projects = index.projects.filter(
              (project) => project.perHarness[harness.harness] !== undefined,
            ).length;
            const entities = index.entities.filter((e) => e.harness === harness.harness);
            const cacheBytes = entities
              .filter((e) => e.kind === "harness-cache")
              .reduce((sum, e) => sum + e.metrics.bytes, 0);
            return (
              <Text key={harness.id}>
                <Text color={complete ? "green" : "yellow"}>{complete ? "✓" : "…"} </Text>
                <Text bold>{harness.displayName.padEnd(12)}</Text>
                {complete ? (
                  <Text>
                    {plural(projects, "project")} · {plural(entities.length, "entity", "entities")}{" "}
                    · {formatBytes(cacheBytes)} harness cache
                  </Text>
                ) : (
                  <Text dimColor>reading what it left behind…</Text>
                )}
              </Text>
            );
          })}
        </Box>
        <Box paddingTop={1}>
          <Text dimColor>
            {"█".repeat(done * BAR_CELLS)}
            {"░".repeat(Math.max(0, total - done) * BAR_CELLS)}{" "}
            {index.scan.roots.length > 0
              ? `roots: ${index.scan.roots.join(", ")}`
              : "no root: every project the breadcrumbs name"}
          </Text>
        </Box>
      </Box>
    </Frame>
  );
}
