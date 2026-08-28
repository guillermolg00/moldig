/**
 * Screen 8 — Confirm: one group at a time in the order Clean → Delete → Update, each applied
 * immediately after its own confirmation. A group holding user content or permanent rows asks
 * twice, as does an aggregate orphan-Project Delete. `y` confirms, `n` skips this group, `esc`
 * skips it and every remaining group (D128).
 * A failed row never aborts the run; the Open group is a reading list, never confirmed.
 *
 * The plan is built once at mount — every disposition decided before anything moves — and the
 * engine's own `apply(plan, executors, {confirm})` drives the sequence: this screen only
 * answers `run | skip | skip-rest` from the keys and renders the group it is being asked about.
 */
import type {
  ApplyProgress,
  ConfirmAnswer,
  Plan,
  PlanGroup,
  PlanRow,
  ScanProgress,
} from "@moldig/core";
import { Box, Text } from "ink";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { Badges } from "../components/Badges.js";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { formatBytes, plural, truncate } from "../lib/format.js";
import { isSafeCleanPlan, type CleanScope } from "../lib/clean-plan.js";
import { useKeys } from "../lib/keys.js";
import { badgesOfRow, groupSelection } from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { tokensText } from "./SelectionScreen.js";

const ACTION_LABEL: Readonly<Record<string, string>> = {
  clean: "Cleaning",
  delete: "Deleting",
  update: "Updating",
};

const HINT: Readonly<Record<string, string>> = {
  clean: "— every file goes to the OS trash; refused rows stay",
  delete:
    "— trash for files, backup before an entry is edited, the harness's own command otherwise",
  update: "— delegated to each installer; a locally modified copy is backed up first",
};

interface Question {
  readonly group: PlanGroup;
  readonly stage: "ask" | "extra";
  readonly answer: (answer: ConfirmAnswer) => void;
}

/** What the `so far:` line has recorded: one entry per group already answered. */
interface Step {
  readonly title: string;
  readonly skipped: boolean;
  readonly rows: number;
}

type Activity =
  | { readonly kind: "running"; readonly progress: ApplyProgress | null }
  | { readonly kind: "refreshing"; readonly progress: ScanProgress | null };

export function ConfirmScreen({
  runPlan: providedPlan,
  preconfirmedClean,
  afterRun,
  projectCount,
}: {
  readonly runPlan?: Plan;
  readonly preconfirmedClean?: CleanScope;
  readonly afterRun?: "refresh-projects" | "purge-result" | "inventory";
  readonly projectCount?: number;
}): ReactElement {
  const store = useStore();
  const { index, marks } = store;
  const { rows: screenRows, columns } = useSize();
  // Frozen at mount: the plan the user confirms is the plan that runs.
  const [runPlan] = useState(
    () =>
      providedPlan ??
      store.runner.plan(
        groupSelection(index, marks, store.refusal).filter((group) => group.action !== "open"),
      ),
  );
  const groups = runPlan.groups.filter((group) => group.action !== "open");
  const preconfirmed =
    preconfirmedClean !== undefined && isSafeCleanPlan(runPlan, preconfirmedClean);
  const [question, setQuestion] = useState<Question | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const [activity, setActivity] = useState<Activity>({ kind: "running", progress: null });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    store.setQuietResult(null);
    void store.runner
      .apply(
        runPlan,
        (group, stage) => {
          if (preconfirmed && stage === "ask" && group.action === "clean") {
            return Promise.resolve<ConfirmAnswer>("run");
          }
          return new Promise<ConfirmAnswer>((resolve) => {
            setQuestion({
              group,
              stage,
              answer: (answer) => {
                setQuestion(null);
                if (answer !== "run" || !group.extraConfirmation.required || stage === "extra") {
                  setSteps((previous) => [
                    ...previous,
                    {
                      title: group.title,
                      skipped: answer !== "run",
                      rows: group.rows.length,
                    },
                  ]);
                }
                resolve(answer);
              },
            });
          });
        },
        (progress) => {
          setActivity({ kind: "running", progress });
        },
      )
      .then(async (manifest) => {
        store.setQuietResult(preconfirmed ? { kind: "clean" } : null);
        store.setRun(manifest);
        if (store.refresh === null) {
          store.replace({ screen: "result" });
          return manifest;
        }
        setActivity({ kind: "refreshing", progress: null });
        await store.refresh((progress) => {
          setActivity({ kind: "refreshing", progress });
        });
        const unresolved = manifest.rows.filter(
          (row) => row.result.status === "failed" || row.result.status === "refused",
        ).length;
        if (afterRun === "purge-result") {
          store.setQuietResult({ kind: "purge", projects: projectCount ?? 0 });
          store.replace({ screen: "result" });
          store.setStatus(
            unresolved === 0
              ? "projects and findings refreshed"
              : `${plural(unresolved, "row")} needs review`,
          );
          return manifest;
        }
        if (afterRun === "inventory") {
          if (unresolved > 0) {
            store.replace({ screen: "result", returnTo: "inventory" });
            store.setStatus(`${plural(unresolved, "updater run")} needs review`);
            return manifest;
          }
          const updated = manifest.rows.filter((row) => row.result.status === "delegated").length;
          store.reset({ screen: "categories" });
          store.setStatus(`${plural(updated, "updater run")} finished · inventory refreshed`);
          return manifest;
        }
        if (afterRun !== "refresh-projects") {
          store.replace({ screen: "result" });
          store.setStatus("projects and findings refreshed");
          return manifest;
        }
        store.reset({ screen: "projects" });
        store.setStatus(
          `${plural(projectCount ?? 0, "missing project")} processed · projects and findings refreshed${unresolved === 0 ? "" : ` · ${plural(unresolved, "row")} needs review`}`,
        );
        return manifest;
      })
      .catch((error: unknown) => {
        store.setStatus(error instanceof Error ? error.message : String(error));
        store.replace({ screen: "result" });
        return null;
      });
  }, [afterRun, preconfirmed, projectCount, runPlan, store]);

  useKeys((input, key) => {
    if (question === null) return;
    if (input === "y" || input === "Y") question.answer("run");
    else if (input === "n" || input === "N") question.answer("skip");
    // D128: esc skips this group and every remaining one.
    else if (key.escape) question.answer("skip-rest");
  }, !store.helpOpen);

  if (question === null) {
    let message = groups.length === 0 ? "nothing to run" : "running…";
    if (activity.kind === "running" && activity.progress !== null) {
      const progress = activity.progress;
      message = `${ACTION_LABEL[progress.action] ?? progress.action} ${progress.completed}/${progress.total} · ${progress.label}`;
    } else if (activity.kind === "refreshing") {
      const progress = activity.progress;
      message =
        progress === null
          ? "refreshing projects and findings…"
          : `refreshing ${progress.phase} ${progress.done}/${progress.total}`;
    }
    return (
      <Frame title={preconfirmed ? "cleaning" : "confirm"} keys="working…">
        <Text dimColor>{message}</Text>
      </Frame>
    );
  }

  const { group, stage } = question;
  const step = groups.findIndex((entry) => entry.action === group.action);
  const height = listHeight(screenRows, 6);
  const width = Math.max(24, Math.min(44, columns - 60));
  const verb = group.title;

  return (
    <Frame
      title={`confirm · ${verb} (${step + 1}/${groups.length})`}
      keys="y confirm · n skip this group · esc skip the rest · ? help"
    >
      <Box flexDirection="column">
        <Text>
          <Text bold>
            {verb} {plural(group.rows.length, "row")}
          </Text>
          <Text dimColor>
            {" "}
            · {formatBytes(group.bytes)} · {tokensText(index, group.tokensPerSession)}
            {group.shared > 0 ? ` · ${plural(group.shared, "shared row")}` : ""}
          </Text>
        </Text>
        {group.rows.slice(0, height).map((row: PlanRow) => (
          <Text key={row.key}>
            {"  "}
            <Text>{truncate(row.target.label, width).padEnd(width)}</Text>
            <Text
              color={
                row.disposition.kind === "refused" || row.disposition.permanent ? "red" : "green"
              }
            >
              {" "}
              {row.disposition.display}
            </Text>
            <Badges badges={badgesOfRow(row)} />
            <Text dimColor> {formatBytes(row.bytes)}</Text>
          </Text>
        ))}
        {group.rows.length > height ? (
          <Text dimColor> … {group.rows.length - height} more</Text>
        ) : null}
        <Box paddingTop={1} flexDirection="column">
          {stage === "extra" ? (
            <Text color="magenta" bold>
              This group holds {group.extraConfirmation.reason}. Confirm again? (y / n)
            </Text>
          ) : (
            <Text bold>
              {projectCount === undefined
                ? `${verb} these ${group.rows.length} rows? (y / n) `
                : `Delete all state for ${plural(projectCount, "missing project")}? (y / n) `}
              <Text dimColor>
                {group.action === "update" && afterRun === "inventory"
                  ? "— runs each previewed updater; locally modified Skills remain untouched"
                  : (HINT[group.action] ?? "")}
              </Text>
            </Text>
          )}
          {steps.length > 0 ? (
            <Text dimColor>
              so far:{" "}
              {steps
                .map((entry) =>
                  entry.skipped
                    ? `${entry.title} skipped`
                    : `${entry.title} ${plural(entry.rows, "row")}`,
                )
                .join(" · ")}
            </Text>
          ) : null}
        </Box>
      </Box>
    </Frame>
  );
}
