// THROWAWAY PROTOTYPE (ticket 09) — screen 3: present Projects sorted by session cost,
// then the collapsed "Gone (N)" group (never mixed with present rows), "Unreachable (N)"
// (no action), then one user-scope row per harness.
import type { Project } from "@moldig/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { formatBytes, formatTokens, pad, shortPath } from "../lib/format.js";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { useStore } from "../lib/store.js";
import { useList } from "../lib/useList.js";

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
function cost(p: Project): number {
  return Object.values(p.perHarness).reduce((acc, h) => acc + (h?.sessionLoad.tokens ?? 0), 0);
}

export function ProjectsScreen(): ReactElement {
  const store = useStore();
  const { index } = store;
  const { rows: screenRows, columns } = useSize();

  const cacheBytes = (p: Project): number =>
    index.entities
      .filter((e) => e.kind === "harness-cache" && e.project === p.id)
      .reduce((acc, e) => acc + e.metrics.bytes, 0);
  const present = index.projects
    .filter((p) => p.reachability === "present")
    .toSorted((a, b) => cost(b) - cost(a));
  const gone = index.projects.filter((p) => p.reachability === "orphan");
  const unreachable = index.projects.filter((p) => p.reachability === "unreachable");
  const mostExpensive = present[0]?.id;

  const projectRow = (p: Project, extraFlags: readonly string[]): ProjectRow => {
    const perHarness = Object.entries(p.perHarness)
      .map(([h, v]) => `${h} ${formatTokens(v?.sessionLoad.tokens ?? 0)}`)
      .join(" · ");
    const flags = [...extraFlags];
    if (p.enclosesCwd) flags.push("cwd");
    if (p.id === mostExpensive && p.reachability === "present" && present.length > 1)
      flags.push("most expensive");
    if (p.kind === "detached-worktree") flags.push("worktree");
    return {
      key: p.id,
      kind: "project",
      label: p.displayName,
      project: p,
      container: p.id,
      detail: `${pad(shortPath(p.path, index.scan.home, index.scan.platform), 28)} ${pad(perHarness || "—", 30)} ${formatBytes(cacheBytes(p)).padStart(8)} cache`,
      flags,
      expanded: false,
    };
  };

  const rows: ProjectRow[] = [];
  rows.push({
    key: "s:present",
    kind: "section",
    label: `Projects (${present.length} present, by session cost)`,
    project: null,
    container: null,
    detail: "",
    flags: [],
    expanded: false,
  });
  for (const p of present) rows.push(projectRow(p, []));
  const goneOpen = store.expanded.has(GONE);
  rows.push({
    key: GONE,
    kind: "group",
    label: `Gone (${gone.length})`,
    project: null,
    container: null,
    detail: "directory gone; what every harness left about it stays together",
    flags: [],
    expanded: goneOpen,
  });
  if (goneOpen) for (const p of gone) rows.push(projectRow(p, ["orphan"]));
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
    for (const p of unreachable) {
      rows.push({
        key: p.id,
        kind: "note",
        label: p.displayName,
        project: p,
        container: null,
        detail: `${shortPath(p.path, index.scan.home, index.scan.platform)} · ${p.unreachableReason ?? "unreachable"} · no action`,
        flags: ["unreachable"],
        expanded: false,
      });
    }
  }
  rows.push({
    key: "s:user",
    kind: "section",
    label: "User scope (paid in every session)",
    project: null,
    container: null,
    detail: "",
    flags: [],
    expanded: false,
  });
  for (const h of index.harnesses) {
    const stray = h.userScope.stray.length;
    rows.push({
      key: h.id,
      kind: "harness",
      label: `${h.displayName} · user scope`,
      project: null,
      container: h.id,
      detail: `${pad(h.userScope.paths.map((p) => shortPath(p.path, index.scan.home, index.scan.platform)).join(", "), 28)} ${pad(`${h.harness} ${formatTokens(h.userScope.baseline.tokens)}`, 30)} ${formatBytes(index.entities.filter((e) => e.kind === "harness-cache" && e.harness === h.harness && e.project === null).reduce((acc, e) => acc + e.metrics.bytes, 0)).padStart(8)} cache`,
      flags: stray > 0 ? [`${stray} stray`] : [],
      expanded: false,
    });
  }

  const list = useList(
    rows,
    listHeight(screenRows, 1),
    (r) => r.key,
    (r) => r.kind !== "section",
  );

  useKeys((input, key) => {
    const row = list.current;
    if (isUp(input, key)) list.move(-1);
    else if (isDown(input, key)) list.move(1);
    else if (key.pageUp) list.move(-10);
    else if (key.pageDown) list.move(10);
    else if (key.escape) store.pop();
    else if (!row) return;
    else if (key.return || key.rightArrow || key.leftArrow) {
      if (row.kind === "group")
        store.setExpanded(row.key, key.leftArrow ? false : key.rightArrow ? true : !row.expanded);
      else if (row.container !== null && key.return)
        store.push({ screen: "items", container: row.container, title: row.label });
    } else if (input === "g" && row.container !== null)
      store.push({ screen: "graph", focusId: row.container });
    else if (input === "o" && row.project) store.openPath(row.project.path);
  }, !store.helpOpen);

  const labelWidth = Math.max(12, Math.min(24, columns - 80));

  return (
    <Frame
      title="projects"
      keys="↑↓ move · enter items · →/← expand · g graph · o open · esc back · ? help · q quit"
    >
      <Box flexDirection="column">
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
            <Text key={row.key} inverse={current} dimColor={row.kind === "note"}>
              {current ? "> " : "  "}
              {caret}
              <Text bold={row.kind === "project" || row.kind === "harness"}>
                {pad(row.label, labelWidth)}
              </Text>
              <Text dimColor={!current}> {row.detail}</Text>
              {row.flags.map((f) => (
                <Text key={f} color={f === "orphan" || f === "unreachable" ? "red" : "yellow"}>
                  {" "}
                  [{f}]
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
