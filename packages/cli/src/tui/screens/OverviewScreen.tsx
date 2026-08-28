/**
 * Minimal home: three explicit cleanup scopes, then the two review paths. The detailed headline
 * and category tables live below this screen instead of competing with the primary action.
 */
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { Frame, useSize } from "../components/Frame.js";
import { formatBytes, plural } from "../lib/format.js";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { projectCleanup } from "../lib/projects.js";
import { bulkCleanupMarks, selectedTotals, type ActionKind } from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { focusName } from "../lib/summary.js";
import { useList } from "../lib/use-list.js";

interface HomeRow {
  readonly key: string;
  readonly label: string;
  readonly detail: string;
  readonly disabled: boolean;
  readonly choose: () => void;
}

export function OverviewScreen(): ReactElement {
  const store = useStore();
  const { index } = store;
  const { columns } = useSize();
  const focusProject = index.headline.focus.project;
  const currentProjects = new Set<string>(focusProject === null ? [] : [focusProject]);
  const missingProjects = new Set(
    index.projects
      .filter((project) => project.reachability === "orphan")
      .map((project) => project.id),
  );

  const current = bulkCleanupMarks(index, { projects: currentProjects }, store.refusal);
  const missing = projectCleanup(index, missingProjects);
  const everything = bulkCleanupMarks(index, {}, store.refusal);

  const cleanupDetail = (marks: ReadonlyMap<string, ActionKind>): string => {
    const totals = selectedTotals(index, marks);
    return marks.size === 0
      ? "nothing removable"
      : `${plural(marks.size, "item")}   ${formatBytes(totals.bytes)}`;
  };
  const select = (marks: ReadonlyMap<string, ActionKind>, label: string): void => {
    if (marks.size === 0) {
      store.setStatus(`${label}: nothing removable was found`);
      return;
    }
    store.replaceMarks(marks);
    store.push({ screen: "selection" });
  };

  const rows: readonly HomeRow[] = [
    {
      key: "current",
      label: "Clean this project",
      detail: cleanupDetail(current),
      disabled: current.size === 0,
      choose: () => select(current, "this project"),
    },
    {
      key: "missing",
      label: "Delete state from missing projects",
      detail:
        missingProjects.size === 0
          ? "none found"
          : `${plural(missingProjects.size, "project")}   ${plural(missing.breadcrumbCount, "harness record")}   ${formatBytes(missing.bytes)}`,
      disabled: missingProjects.size === 0 || missing.selection.length === 0,
      choose: () => store.push({ screen: "project-cleanup" }),
    },
    {
      key: "all",
      label: "Clean all removable state",
      detail: cleanupDetail(everything),
      disabled: everything.size === 0,
      choose: () => select(everything, "all removable state"),
    },
    {
      key: "findings",
      label: "Review findings",
      detail: plural(index.findings.length, "finding"),
      disabled: false,
      choose: () => store.push({ screen: "categories" }),
    },
    {
      key: "projects",
      label: "Browse projects",
      detail: `${plural(index.projects.length, "project")}   ${missingProjects.size} missing`,
      disabled: false,
      choose: () => store.push({ screen: "projects" }),
    },
  ];
  const list = useList(
    rows,
    rows.length,
    (row) => row.key,
    (row) => !row.disabled,
  );

  useKeys((input, key) => {
    if (isUp(input, key)) list.move(-1);
    else if (isDown(input, key)) list.move(1);
    else if (key.home) list.jump("home");
    else if (key.end) list.jump("end");
    else if (key.return) list.current?.choose();
    else if (input === "r") store.push({ screen: "categories" });
    else if (input === "p") store.push({ screen: "projects" });
    else if (input === "g") {
      const focus = focusProject ?? index.entities[0]?.id;
      if (focus !== undefined) store.push({ screen: "graph", focusId: focus });
    }
  }, !store.helpOpen);

  const labelWidth = Math.max(24, Math.min(34, columns - 28));
  return (
    <Frame
      title="overview"
      subtitle={`${focusName(index)} · ${plural(index.harnesses.length, "harness", "harnesses")}`}
      keys="↑↓ navigate   enter choose   ? shortcuts   q quit"
    >
      <Box flexDirection="column">
        <Text dimColor>Cache and memory only. Nothing moves before review.</Text>
        <Box flexDirection="column" paddingTop={1}>
          {rows.map((row, i) => {
            const currentRow = i === list.cursor;
            return (
              <Text
                key={row.key}
                {...(currentRow ? { color: "cyan" as const } : {})}
                dimColor={row.disabled}
              >
                {currentRow ? "› " : "  "}
                <Text>{row.label.padEnd(labelWidth)}</Text>
                <Text>{"   "}</Text>
                <Text dimColor={!currentRow}>{row.detail}</Text>
              </Text>
            );
          })}
        </Box>
      </Box>
    </Frame>
  );
}
