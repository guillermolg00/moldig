/**
 * Screen 2 — Overview: the Headline number per harness ("what every session pays + what the
 * focused Project adds"), the eight Categories with their count and worst severity, and the way
 * into Projects, the graph and the selection panel.
 */
import type { Category, Finding } from "@moldig/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { SeverityBadge } from "../components/Badges.js";
import { Frame } from "../components/Frame.js";
import {
  CATEGORIES,
  categoryLabel,
  formatBytes,
  formatRange,
  formatTokens,
  plural,
} from "../lib/format.js";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { useStore } from "../lib/store.js";
import { focusName, harnessName } from "../lib/summary.js";
import { useList } from "../lib/use-list.js";

const RANK: Readonly<Record<Finding["severity"], number>> = { low: 1, medium: 2, high: 3 };

export function worstSeverity(findings: readonly Finding[]): Finding["severity"] | null {
  let worst: Finding["severity"] | null = null;
  for (const finding of findings) {
    if (worst === null || RANK[finding.severity] > RANK[worst]) worst = finding.severity;
  }
  return worst;
}

export function OverviewScreen(): ReactElement {
  const store = useStore();
  const { index } = store;
  const categories: readonly Category[] = CATEGORIES;
  const list = useList(categories, categories.length, (category) => category);

  useKeys((input, key) => {
    if (isUp(input, key)) list.move(-1);
    else if (isDown(input, key)) list.move(1);
    else if (key.return && list.current !== undefined) {
      store.push({ screen: "findings", category: list.current });
    } else if (input === "p") store.push({ screen: "projects" });
    else if (input === "g") {
      const focus = index.headline.focus.project ?? index.entities[0]?.id;
      if (focus !== undefined) store.push({ screen: "graph", focusId: focus });
    }
  }, !store.helpOpen);

  const present = index.projects.filter((p) => p.reachability === "present").length;
  const gone = index.projects.filter((p) => p.reachability === "orphan").length;
  const unreachable = index.projects.filter((p) => p.reachability === "unreachable").length;
  const focus = focusName(index);
  const reason = index.headline.focus.reason;

  return (
    <Frame
      title="overview"
      keys="↑↓ move · enter category · p projects · g graph · s selection · ? help · q quit"
    >
      <Box flexDirection="column">
        <Text bold>
          Headline — {focus} ({reason === "cwd" ? "encloses cwd" : reason})
        </Text>
        {index.headline.perHarness.map((entry) => (
          <Text key={entry.harness}>
            {"  "}
            <Text color="cyan">{harnessName(index, `harness:${entry.harness}`).padEnd(12)}</Text>
            <Text>every session pays </Text>
            <Text bold>{formatTokens(entry.baseline.mid)}</Text>
            <Text> + {focus} adds </Text>
            <Text bold>{formatTokens(entry.project.mid)}</Text>
            <Text> = </Text>
            <Text bold color="yellow">
              {formatTokens(entry.total.mid)} tokens/session
            </Text>
            <Text dimColor>
              {"\n"}
              {"              "}
              {formatRange(entry.total)}
              {entry.pctOfContext === null || entry.contextWindowTokens === null
                ? ""
                : ` · ${entry.pctOfContext}% of ${formatTokens(entry.contextWindowTokens)} context`}
              {entry.modelFamily === null ? "" : ` · ${entry.modelFamily} multipliers`}
            </Text>
          </Text>
        ))}
        <Box paddingTop={1}>
          <Text bold>Findings</Text>
        </Box>
        {categories.map((category, i) => {
          const findings = index.findings.filter((finding) => finding.category === category);
          const worst = worstSeverity(findings);
          const bytes = findings.reduce((sum, finding) => sum + finding.impact.bytes, 0);
          const tokens = findings.reduce((sum, finding) => sum + (finding.impact.tokens ?? 0), 0);
          const current = i === list.cursor;
          return (
            <Text key={category} inverse={current}>
              {current ? "> " : "  "}
              <Text bold={current}>{categoryLabel(category).padEnd(16)}</Text>
              <Text>{String(findings.length).padStart(3)} </Text>
              {worst === null ? <Text dimColor>○ none </Text> : <SeverityBadge severity={worst} />}
              <Text dimColor>
                {"  "}
                {findings.length === 0
                  ? ""
                  : `${formatBytes(bytes)}${tokens > 0 ? ` · ${formatTokens(tokens)} tokens/session` : ""}`}
              </Text>
            </Text>
          );
        })}
        <Box paddingTop={1}>
          <Text dimColor>
            Projects: {present} present · {gone} gone · {unreachable} unreachable ·{" "}
            {plural(index.harnesses.length, "harness", "harnesses")}
            {index.warnings.length > 0 ? ` · ${plural(index.warnings.length, "warning")}` : ""}
          </Text>
        </Box>
      </Box>
    </Frame>
  );
}
