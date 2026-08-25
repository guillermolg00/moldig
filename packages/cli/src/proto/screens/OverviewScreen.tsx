// THROWAWAY PROTOTYPE (ticket 09) — screen 2: the headline number for the focused Project
// per harness ("what every session pays + what <project> adds"), the eight categories with
// count and severity badge, and the way into projects / graph / selection.
import type { Category, Finding } from "@moldig/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { SeverityBadge } from "../components/Badges.js";
import { Frame } from "../components/Frame.js";
import {
  CATEGORIES,
  CATEGORY_LABEL,
  formatBytes,
  formatRange,
  formatTokens,
  plural,
} from "../lib/format.js";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { useStore } from "../lib/store.js";
import { focusName, harnessName } from "../lib/summary.js";
import { useList } from "../lib/useList.js";

const RANK: Record<Finding["severity"], number> = { low: 1, medium: 2, high: 3 };

export function worstSeverity(findings: readonly Finding[]): Finding["severity"] | null {
  let worst: Finding["severity"] | null = null;
  for (const f of findings)
    if (worst === null || RANK[f.severity] > RANK[worst]) worst = f.severity;
  return worst;
}

export function OverviewScreen(): ReactElement {
  const store = useStore();
  const { index } = store;
  const categories = CATEGORIES as readonly Category[];
  const list = useList(categories, categories.length, (c) => c);

  useKeys((input, key) => {
    if (isUp(input, key)) list.move(-1);
    else if (isDown(input, key)) list.move(1);
    else if (key.return && list.current) store.push({ screen: "findings", category: list.current });
    else if (input === "p") store.push({ screen: "projects" });
    else if (input === "g") {
      const focus = index.headline.focus.project ?? index.entities[0]?.id;
      if (focus) store.push({ screen: "graph", focusId: focus });
    }
  }, !store.helpOpen);

  const present = index.projects.filter((p) => p.reachability === "present").length;
  const gone = index.projects.filter((p) => p.reachability === "orphan").length;
  const unreachable = index.projects.filter((p) => p.reachability === "unreachable").length;
  const focus = focusName(index);

  return (
    <Frame
      title="overview"
      keys="↑↓ move · enter category · p projects · g graph · s selection · ? help · q quit"
    >
      <Box flexDirection="column">
        <Text bold>
          Headline — {focus} (
          {index.headline.focus.reason === "cwd" ? "encloses cwd" : index.headline.focus.reason})
        </Text>
        {index.headline.perHarness.map((h) => (
          <Text key={h.harness}>
            {"  "}
            <Text color="cyan">{harnessName(index, `harness:${h.harness}`).padEnd(12)}</Text>
            <Text>every session pays </Text>
            <Text bold>{formatTokens(h.baseline.mid)}</Text>
            <Text> + {focus} adds </Text>
            <Text bold>{formatTokens(h.project.mid)}</Text>
            <Text> = </Text>
            <Text bold color="yellow">
              {formatTokens(h.total.mid)} tokens/session
            </Text>
            <Text dimColor>
              {"\n"}
              {"              "}
              {formatRange(h.total)}
              {h.pctOfContext === null || h.contextWindowTokens === null
                ? ""
                : ` · ${h.pctOfContext}% of ${formatTokens(h.contextWindowTokens)} context`}
              {h.modelFamily ? ` · ${h.modelFamily} multipliers` : ""}
            </Text>
          </Text>
        ))}
        <Box paddingTop={1}>
          <Text bold>Findings</Text>
        </Box>
        {categories.map((category, i) => {
          const findings = index.findings.filter((f) => f.category === category);
          const worst = worstSeverity(findings);
          const bytes = findings.reduce((acc, f) => acc + f.impact.bytes, 0);
          const tokens = findings.reduce((acc, f) => acc + (f.impact.tokens ?? 0), 0);
          const current = i === list.cursor;
          return (
            <Text key={category} inverse={current}>
              {current ? "> " : "  "}
              <Text bold={current}>{(CATEGORY_LABEL[category] ?? category).padEnd(16)}</Text>
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
