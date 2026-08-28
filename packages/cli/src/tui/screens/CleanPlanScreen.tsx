import type { AuditIndex, HarnessCache } from "@moldig/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import {
  cleanBuckets,
  cleanCandidates,
  isSafeCleanPlan,
  selectedCleanMarks,
  type CleanBucket,
  type CleanScope,
} from "../lib/clean-plan.js";
import {
  formatAge,
  formatBytes,
  formatTokens,
  plural,
  shortPath,
  truncate,
} from "../lib/format.js";
import { isDown, isUp, useKeys } from "../lib/keys.js";
import { groupSelection } from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { useList } from "../lib/use-list.js";

interface BucketRow {
  readonly kind: "bucket";
  readonly key: string;
  readonly bucket: CleanBucket;
}

interface ItemRow {
  readonly kind: "item";
  readonly key: string;
  readonly bucketKey: string;
  readonly entity: HarnessCache;
}

type CleanRow = BucketRow | ItemRow;

const NOUNS: Readonly<Record<string, string>> = {
  transcript: "session",
  "subagent-transcript": "subagent session",
  "tool-result": "tool result",
  "file-history": "file history snapshot",
  "shell-snapshot": "shell snapshot",
  "session-env": "session environment",
  "task-list": "task list",
  "paste-cache": "paste",
  "config-backup": "config backup",
  "debug-log": "debug log",
  "plugin-cache-version": "plugin version",
  "marketplace-clone": "marketplace clone",
  "marketplace-backup": "marketplace backup",
  checkpoint: "checkpoint",
  worktree: "worktree",
  log: "log",
};

function bucketDescription(bucket: CleanBucket, scope: CleanScope): string {
  const noun = NOUNS[bucket.cacheKind] ?? bucket.cacheKind.replaceAll("-", " ");
  const age = bucket.retentionDays === null ? "" : ` > ${bucket.retentionDays} days`;
  if (scope.kind === "project") return `${plural(bucket.units.length, noun)}${age}`;
  const places = [
    bucket.projectCount > 0 ? plural(bucket.projectCount, "Project") : null,
    bucket.includesUserScope ? "user scope" : null,
  ].filter((part): part is string => part !== null);
  return `${plural(bucket.units.length, noun)}${age}${places.length === 0 ? "" : ` · ${places.join(" + ")}`}`;
}

function sessionCost(index: AuditIndex): string {
  const entries = index.headline.perHarness.filter((entry) => entry.total.mid > 0);
  if (entries.length === 0) return "no session context cost measured";
  if (entries.length === 1) {
    return `this session pays ~${formatTokens(entries[0]?.total.mid ?? 0)} tokens`;
  }
  const names = new Map(index.harnesses.map((harness) => [harness.harness, harness.displayName]));
  return `session cost · ${entries
    .map(
      (entry) => `${names.get(entry.harness) ?? entry.harness} ~${formatTokens(entry.total.mid)}`,
    )
    .join(" · ")}`;
}

function globalSubtitle(index: AuditIndex, candidates: readonly HarnessCache[]): string {
  const projects = new Set(
    candidates
      .map((candidate) => candidate.project)
      .filter((project): project is string => project !== null),
  );
  const userScope = candidates.some((candidate) => candidate.project === null);
  return `${plural(index.harnesses.length, "harness", "harnesses")} · ${plural(projects.size, "Project")}${userScope ? " + user scope" : ""}`;
}

function marker(selected: number, total: number): string {
  if (selected === 0) return "[ ]";
  return selected === total ? "[x]" : "[-]";
}

export function CleanPlanScreen({ scope }: { readonly scope: CleanScope }): ReactElement {
  const store = useStore();
  const { index } = store;
  const { rows: terminalRows, columns } = useSize();
  const project =
    scope.kind === "project"
      ? index.projects.find((entry) => entry.id === scope.project)
      : undefined;
  const candidates = cleanCandidates(index, scope, store.refusal);
  const buckets = cleanBuckets(index, candidates, store.marks);
  const selectedMarks = selectedCleanMarks(candidates, store.marks);
  const selectedUnits = candidates.filter((entity) => selectedMarks.has(entity.id));
  const selectedBytes = selectedUnits.reduce((sum, entity) => sum + entity.metrics.bytes, 0);

  const rows: CleanRow[] = [];
  for (const bucket of buckets) {
    rows.push({ kind: "bucket", key: bucket.key, bucket });
    if (store.expanded.has(bucket.key)) {
      for (const entity of bucket.units) {
        rows.push({
          kind: "item",
          key: `clean-plan:item:${entity.id}`,
          bucketKey: bucket.key,
          entity,
        });
      }
    }
  }

  const list = useList(rows, listHeight(terminalRows, 7), (row) => row.key);

  useKeys((input, key) => {
    const current = list.current;
    if (isUp(input, key)) list.move(-1);
    else if (isDown(input, key)) list.move(1);
    else if (key.home) list.jump("home");
    else if (key.end) list.jump("end");
    else if (key.pageUp) list.move(-10);
    else if (key.pageDown) list.move(10);
    else if (key.rightArrow && current?.kind === "bucket") {
      store.setExpanded(current.bucket.key, true);
    } else if (key.leftArrow && current?.kind === "bucket") {
      store.setExpanded(current.bucket.key, false);
    } else if (key.leftArrow && current?.kind === "item") {
      store.setExpanded(current.bucketKey, false);
    } else if ((input === " " || input === "x") && current?.kind === "bucket") {
      store.toggleMany(
        current.bucket.units.map((entity) => entity.id),
        "clean",
      );
    } else if ((input === " " || input === "x") && current?.kind === "item") {
      store.toggleMark(current.entity.id, "clean");
    } else if (key.return) {
      if (selectedMarks.size === 0) {
        store.setStatus("nothing selected — no files were moved");
        return;
      }
      const runPlan = store.runner.plan(groupSelection(index, selectedMarks, store.refusal));
      if (!isSafeCleanPlan(runPlan, scope)) {
        store.setStatus("the recommended plan changed and was not run");
        return;
      }
      store.push({ screen: "confirm", runPlan, preconfirmedClean: scope });
    } else if (key.tab || input === "\t") {
      store.push({ screen: "categories" });
    } else if (key.escape) {
      store.quit();
    }
  }, !store.helpOpen);

  const labelWidth = Math.max(22, Math.min(58, columns - 28));
  return (
    <Frame
      title={scope.kind === "project" ? (project?.displayName ?? "this project") : "all safe cache"}
      subtitle={scope.kind === "project" ? sessionCost(index) : globalSubtitle(index, candidates)}
      keys="↑↓ inspect   ←→ details   space exclude   enter move to Trash   tab see more   esc cancel"
    >
      <Box flexDirection="column">
        <Text>
          <Text bold>
            {selectedMarks.size === 0
              ? "Nothing selected"
              : `${formatBytes(selectedBytes)} ready for Trash`}
          </Text>
          <Text dimColor>
            {selectedMarks.size === 0
              ? ""
              : ` · ${plural(selectedMarks.size, "item")} · ${plural(buckets.length, "group")}`}
          </Text>
        </Text>
        <Text dimColor>
          Only old harness cache. Everything selected goes to the OS Trash. Your context files,
          skills, MCP servers and memory stay.
        </Text>
        <Box flexDirection="column" paddingTop={1}>
          {rows.length === 0 ? <Text dimColor>nothing safe to clean</Text> : null}
          {list.visible.map((row, offset) => {
            const current = list.start + offset === list.cursor;
            if (row.kind === "bucket") {
              const bucket = row.bucket;
              const detail =
                bucket.selected === bucket.units.length
                  ? formatBytes(bucket.bytes)
                  : `${bucket.selected}/${bucket.units.length} selected · ${formatBytes(bucket.selectedBytes)}`;
              return (
                <Text key={row.key} {...(current ? { color: "cyan" as const } : {})}>
                  {current ? "› " : "  "}
                  {marker(bucket.selected, bucket.units.length)}{" "}
                  {store.expanded.has(bucket.key) ? "▾" : "▸"}{" "}
                  <Text>
                    {truncate(
                      `${bucket.harnessName} · ${bucketDescription(bucket, scope)}`,
                      labelWidth,
                    ).padEnd(labelWidth)}
                  </Text>
                  <Text dimColor={!current}> {detail}</Text>
                  <Text color="green"> → Trash</Text>
                </Text>
              );
            }
            const selected = selectedMarks.has(row.entity.id);
            const path = shortPath(row.entity.path, store.home, store.platform);
            return (
              <Text key={row.key} {...(current ? { color: "cyan" as const } : {})}>
                {current ? "› " : "  "}
                {"    "}
                {selected ? "[x]" : "[ ]"}{" "}
                {truncate(row.entity.label, Math.max(18, labelWidth - 8))}
                <Text dimColor={!current}>
                  {` · ${formatAge(row.entity.metrics.ageDays)} · ${formatBytes(row.entity.metrics.bytes)} · `}
                  {store.link(
                    row.entity.path,
                    truncate(path, Math.max(16, columns - labelWidth - 28)),
                  )}
                </Text>
              </Text>
            );
          })}
          {list.hiddenBelow > 0 ? <Text dimColor>… {list.hiddenBelow} more</Text> : null}
        </Box>
        <Box paddingTop={1}>
          <Text bold>
            {selectedMarks.size === 0
              ? "Select at least one group or item to continue."
              : `Enter confirms ${plural(selectedMarks.size, "item")} · ${formatBytes(selectedBytes)} → OS Trash.`}
          </Text>
        </Box>
      </Box>
    </Frame>
  );
}
