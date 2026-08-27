/**
 * Screen 3 — Projects: present Projects sorted by session cost, then the collapsed `Gone (N)`
 * group (never mixed with present rows, ADR-0006), `Unreachable (N)` (shown, never acted on),
 * then one user-scope row per harness — what every session of that harness pays.
 */
import type { Project } from "@moldig/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { formatBytes, formatTokens, pad, shortPath } from "../lib/format.js";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { bulkCleanupMarks, selectedTotals } from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { useList } from "../lib/use-list.js";

interface ProjectRow {
  readonly key: string;
  readonly kind: "section" | "project" | "group" | "note" | "harness";
  readonly label: string;
  readonly project: Project | null;
  readonly container: string | null;
  readonly detail: string;
  readonly flags: readonly string[];
  readonly expanded: boolean;
}

const GONE = "projects:gone";
const UNREACHABLE = "projects:unreachable";

/** Session cost of a Project: what a session started there adds, summed over its harnesses. */
function cost(project: Project): number {
  return Object.values(project.perHarness).reduce(
    (sum, facts) => sum + (facts?.sessionLoad.tokens ?? 0),
    0,
  );
}

function section(key: string, label: string): ProjectRow {
  return {
    key,
    kind: "section",
    label,
    project: null,
    container: null,
    detail: "",
    flags: [],
    expanded: false,
  };
}

export function ProjectsScreen(): ReactElement {
  const store = useStore();
  const { index } = store;
  const { rows: screenRows, columns } = useSize();
  const { home, platform } = index.scan;

  const cacheBytes = (project: Project): number =>
    index.entities
      .filter((entity) => entity.kind === "harness-cache" && entity.project === project.id)
      .reduce((sum, entity) => sum + entity.metrics.bytes, 0);
  const present = index.projects
    .filter((project) => project.reachability === "present")
    .toSorted((a, b) => cost(b) - cost(a));
  const gone = index.projects.filter((project) => project.reachability === "orphan");
  const unreachable = index.projects.filter((project) => project.reachability === "unreachable");
  const goneMarks = bulkCleanupMarks(
    index,
    { projects: new Set(gone.map((project) => project.id)), includeKept: true },
    store.refusal,
  );
  const goneBytes = selectedTotals(index, goneMarks).bytes;
  const mostExpensive = present[0]?.id;

  const projectRow = (project: Project, extraFlags: readonly string[]): ProjectRow => {
    const perHarness = Object.entries(project.perHarness)
      .map(([harness, facts]) => `${harness} ${formatTokens(facts?.sessionLoad.tokens ?? 0)}`)
      .join(" · ");
    const flags = [...extraFlags];
    if (project.enclosesCwd) flags.push("cwd");
    if (project.id === mostExpensive && project.reachability === "present" && present.length > 1) {
      flags.push("most expensive");
    }
    if (project.kind === "detached-worktree") flags.push("worktree");
    return {
      key: project.id,
      kind: "project",
      label: project.displayName,
      project,
      container: project.id,
      detail: `${pad(shortPath(project.path, home, platform), 28)} ${pad(perHarness || "—", 30)} ${formatBytes(cacheBytes(project)).padStart(8)} cache`,
      flags,
      expanded: false,
    };
  };

  const rows: ProjectRow[] = [
    section("s:present", `Projects (${present.length} present, by session cost)`),
  ];
  for (const project of present) rows.push(projectRow(project, []));

  const goneOpen = store.expanded.has(GONE);
  rows.push({
    key: GONE,
    kind: "group",
    label: `Gone (${gone.length})`,
    project: null,
    container: null,
    detail:
      goneMarks.size === 0
        ? "directories gone; nothing safely removable"
        : `${goneMarks.size} removable   ${formatBytes(goneBytes)}   space to review`,
    flags: [],
    expanded: goneOpen,
  });
  if (goneOpen) for (const project of gone) rows.push(projectRow(project, ["orphan"]));

  const unreachableOpen = store.expanded.has(UNREACHABLE);
  rows.push({
    key: UNREACHABLE,
    kind: "group",
    label: `Unreachable (${unreachable.length})`,
    project: null,
    container: null,
    detail: "volume not mounted or stat timed out; nothing is suggested until it is back",
    flags: [],
    expanded: unreachableOpen,
  });
  if (unreachableOpen) {
    for (const project of unreachable) {
      rows.push({
        key: project.id,
        kind: "note",
        label: project.displayName,
        project,
        container: null,
        detail: `${shortPath(project.path, home, platform)} · ${project.unreachableReason ?? "unreachable"} · no action`,
        flags: ["unreachable"],
        expanded: false,
      });
    }
  }

  rows.push(section("s:user", "User scope (paid in every session)"));
  for (const harness of index.harnesses) {
    const stray = harness.userScope.stray.length;
    const paths = harness.userScope.paths
      .map((entry) => shortPath(entry.path, home, platform))
      .join(", ");
    const cache = index.entities
      .filter(
        (entity) =>
          entity.kind === "harness-cache" &&
          entity.harness === harness.harness &&
          entity.project === null,
      )
      .reduce((sum, entity) => sum + entity.metrics.bytes, 0);
    rows.push({
      key: harness.id,
      kind: "harness",
      label: `${harness.displayName} · user scope`,
      project: null,
      container: harness.id,
      detail: `${pad(paths, 28)} ${pad(`${harness.harness} ${formatTokens(harness.userScope.baseline.tokens)}`, 30)} ${formatBytes(cache).padStart(8)} cache`,
      flags: stray > 0 ? [`${stray} stray`] : [],
      expanded: false,
    });
  }

  const list = useList(
    rows,
    listHeight(screenRows, 1),
    (row) => row.key,
    (row) => row.kind !== "section",
  );

  const startCleanup = (
    projects: ReadonlySet<string>,
    includeKept: boolean,
    label: string,
  ): void => {
    const marks = bulkCleanupMarks(index, { projects, includeKept }, store.refusal);
    if (marks.size === 0) {
      store.setStatus(`${label}: nothing removable was found`);
      return;
    }
    store.replaceMarks(marks);
    store.push({ screen: "selection" });
  };

  useKeys((input, key) => {
    const row = list.current;
    if (isUp(input, key)) list.move(-1);
    else if (isDown(input, key)) list.move(1);
    else if (key.pageUp) list.move(-10);
    else if (key.pageDown) list.move(10);
    else if (key.home) list.jump("home");
    else if (key.end) list.jump("end");
    else if (key.escape) store.pop();
    else if (row === undefined) return;
    else if (input === " ") {
      if (row.key === GONE) {
        startCleanup(new Set(gone.map((project) => project.id)), true, "missing projects");
      } else if (row.project !== null && row.project.reachability !== "unreachable") {
        startCleanup(
          new Set([row.project.id]),
          row.project.reachability === "orphan",
          row.project.displayName,
        );
      }
    } else if (key.return || key.rightArrow || key.leftArrow) {
      if (row.kind === "group") {
        store.setExpanded(row.key, key.leftArrow ? false : key.rightArrow ? true : !row.expanded);
      } else if (row.container !== null && key.return) {
        store.push({ screen: "items", container: row.container, title: row.label });
      }
    } else if (input === "g" && row.container !== null) {
      store.push({ screen: "graph", focusId: row.container });
    } else if (input === "o" && row.project !== null) store.openPath(row.project.path);
  }, !store.helpOpen);

  const labelWidth = Math.max(12, Math.min(24, columns - 80));

  return (
    <Frame title="projects" keys="↑↓ navigate   enter open   space clean   esc back   ? shortcuts">
      <Box flexDirection="column">
        {list.hiddenAbove > 0 ? <Text dimColor>… {list.hiddenAbove} above</Text> : null}
        {list.visible.map((row, i) => {
          const current = list.start + i === list.cursor;
          if (row.kind === "section") {
            return (
              <Text key={row.key} bold underline>
                {row.label}
              </Text>
            );
          }
          const caret = row.kind === "group" ? (row.expanded ? "▾ " : "▸ ") : "  ";
          return (
            <Text
              key={row.key}
              {...(current ? { color: "cyan" as const } : {})}
              dimColor={row.kind === "note"}
            >
              {current ? "› " : "  "}
              {caret}
              <Text>{pad(row.label, labelWidth)}</Text>
              <Text dimColor={!current}> {row.detail}</Text>
              {row.flags.map((flag) => (
                <Text
                  key={flag}
                  color={flag === "orphan" || flag === "unreachable" ? "red" : "yellow"}
                >
                  {" "}
                  [{flag}]
                </Text>
              ))}
            </Text>
          );
        })}
        {list.hiddenBelow > 0 ? <Text dimColor>… {list.hiddenBelow} more</Text> : null}
      </Box>
    </Frame>
  );
}
