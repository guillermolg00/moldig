/** The eight audit Categories, kept one level below the minimal home screen. */
import type { Category, Finding } from "@moldig/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { SeverityBadge } from "../components/Badges.js";
import { Frame } from "../components/Frame.js";
import { CATEGORIES, categoryLabel, formatBytes, plural } from "../lib/format.js";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { useStore } from "../lib/store.js";
import { useList } from "../lib/use-list.js";

const RANK: Readonly<Record<Finding["severity"], number>> = { low: 1, medium: 2, high: 3 };

export function worstSeverity(findings: readonly Finding[]): Finding["severity"] | null {
  let worst: Finding["severity"] | null = null;
  for (const finding of findings) {
    if (worst === null || RANK[finding.severity] > RANK[worst]) worst = finding.severity;
  }
  return worst;
}

export function CategoriesScreen(): ReactElement {
  const store = useStore();
  const categories: readonly Category[] = CATEGORIES;
  const list = useList(categories, categories.length, (category) => category);

  useKeys((input, key) => {
    if (isUp(input, key)) list.move(-1);
    else if (isDown(input, key)) list.move(1);
    else if (key.home) list.jump("home");
    else if (key.end) list.jump("end");
    else if (key.escape) store.pop();
    else if (key.return && list.current !== undefined) {
      store.push({ screen: "findings", category: list.current });
    }
  }, !store.helpOpen);

  return (
    <Frame
      title="findings"
      subtitle={`${plural(store.index.findings.length, "finding")} across eight categories.`}
      keys="↑↓ navigate   enter open   esc back   ? shortcuts"
    >
      <Box flexDirection="column">
        {categories.map((category, i) => {
          const findings = store.index.findings.filter((finding) => finding.category === category);
          const worst = worstSeverity(findings);
          const bytes = findings.reduce((sum, finding) => sum + finding.impact.bytes, 0);
          const current = i === list.cursor;
          return (
            <Text key={category} {...(current ? { color: "cyan" as const } : {})}>
              {current ? "› " : "  "}
              <Text>{categoryLabel(category).padEnd(20)}</Text>
              <Text dimColor={!current}>{String(findings.length).padStart(4)}</Text>
              <Text>{"   "}</Text>
              {worst === null ? <Text dimColor>none</Text> : <SeverityBadge severity={worst} />}
              {bytes > 0 ? (
                <Text dimColor>
                  {"   "}
                  {formatBytes(bytes)}
                </Text>
              ) : null}
            </Text>
          );
        })}
      </Box>
    </Frame>
  );
}
