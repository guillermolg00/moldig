/** Select missing Projects as the deletion unit; their files stay behind this one compact list. */
import { Box, Text } from "ink";
import { type ReactElement, useMemo, useState } from "react";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { formatBytes, pad, plural, shortPath } from "../lib/format.js";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { projectCleanup } from "../lib/projects.js";
import { withExtraConfirmation } from "../lib/runner.js";
import { useStore } from "../lib/store.js";
import { useList } from "../lib/use-list.js";

export function ProjectCleanupScreen({
  initialProject,
  standalone = false,
}: {
  readonly initialProject?: string;
  readonly standalone?: boolean;
}): ReactElement {
  const store = useStore();
  const { index } = store;
  const { rows: screenRows, columns } = useSize();
  const projects = useMemo(
    () =>
      index.projects
        .filter((project) => project.reachability === "orphan")
        .toSorted((left, right) => left.displayName.localeCompare(right.displayName)),
    [index],
  );
  const [selected, setSelected] = useState<ReadonlySet<string>>(() =>
    initialProject === undefined
      ? new Set(projects.map((project) => project.id))
      : new Set([initialProject]),
  );
  const cleanup = projectCleanup(index, selected);
  const list = useList(projects, listHeight(screenRows, 3), (project) => project.id);

  const toggle = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  useKeys((input, key) => {
    const current = list.current;
    if (isUp(input, key)) list.move(-1);
    else if (isDown(input, key)) list.move(1);
    else if (key.pageUp) list.move(-10);
    else if (key.pageDown) list.move(10);
    else if (key.home) list.jump("home");
    else if (key.end) list.jump("end");
    else if (key.escape) {
      if (standalone) store.quit();
      else store.pop();
    } else if (input === " " && current !== undefined) toggle(current.id);
    else if (input === "a") {
      setSelected(
        selected.size === projects.length
          ? new Set()
          : new Set(projects.map((project) => project.id)),
      );
    } else if (key.return) {
      if (cleanup.projectCount === 0) {
        store.setStatus("select at least one missing project");
        return;
      }
      if (cleanup.selection.length === 0) {
        store.setStatus("the selected projects have no safely removable state");
        return;
      }
      const runPlan = withExtraConfirmation(
        store.runner.planSelection(cleanup.selection),
        "complete state for the selected missing projects",
      );
      store.push({
        screen: "confirm",
        runPlan,
        afterRun: standalone ? "purge-result" : "refresh-projects",
        projectCount: cleanup.projectCount,
      });
    }
  }, !store.helpOpen);

  const home = index.scan.home;
  const platform = index.scan.platform;
  const labelWidth = Math.max(14, Math.min(28, columns - 62));

  return (
    <Frame
      title="missing projects"
      subtitle={`${plural(selected.size, "project")} selected · ${formatBytes(cleanup.bytes)} · ${plural(cleanup.breadcrumbCount, "harness record")}`}
      keys={`↑↓ navigate   space toggle   a all / none   enter delete state   esc ${standalone ? "cancel" : "back"}`}
    >
      <Box flexDirection="column">
        <Text dimColor>
          Projects are the unit. Their complete recoverable harness state is deleted after two
          confirmations.
        </Text>
        <Box flexDirection="column" paddingTop={1}>
          {projects.length === 0 ? <Text color="green">No missing projects remain.</Text> : null}
          {list.visible.map((project, indexInView) => {
            const current = list.start + indexInView === list.cursor;
            const checked = selected.has(project.id);
            const breadcrumbs = project.breadcrumbs.length;
            return (
              <Text key={project.id} {...(current ? { color: "cyan" as const } : {})}>
                {current ? "› " : "  "}
                {checked ? "[x] " : "[ ] "}
                <Text>{pad(project.displayName, labelWidth)}</Text>
                <Text dimColor={!current}>
                  {" "}
                  {pad(shortPath(project.path, home, platform), 28)} {plural(breadcrumbs, "record")}
                </Text>
              </Text>
            );
          })}
          {list.hiddenBelow > 0 ? <Text dimColor>… {list.hiddenBelow} more</Text> : null}
        </Box>
        {cleanup.blocked.length > 0 ? (
          <Text color="yellow">{plural(cleanup.blocked.length, "live item")} will stay.</Text>
        ) : null}
      </Box>
    </Frame>
  );
}
