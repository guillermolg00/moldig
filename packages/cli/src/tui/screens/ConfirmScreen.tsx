/**
 * Screen 8 — Confirm: one group at a time in the order Clean → Delete → Update, each applied
 * immediately after its own confirmation. A group holding user content or permanent rows asks
 * twice. `y` confirms, `n` skips this group, `esc` skips it and every remaining group (D128).
 * A failed row never aborts the run; the Open group is a reading list, never confirmed.
 *
 * The plan is built once at mount — every disposition decided before anything moves — and the
 * engine's own `apply(plan, executors, {confirm})` drives the sequence: this screen only
 * answers `run | skip | skip-rest` from the keys and renders the group it is being asked about.
 */
import type { ConfirmAnswer, PlanGroup, PlanRow } from "@moldig/core";
import { Box, Text } from "ink";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { Badges } from "../components/Badges.js";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { formatBytes, plural, truncate } from "../lib/format.js";
import { useKeys } from "../lib/keys.js";
import { badgesOfRow, groupSelection } from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { tokensText } from "./SelectionScreen.js";

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

export function ConfirmScreen(): ReactElement {
  const store = useStore();
  const { index, marks } = store;
  const { rows: screenRows, columns } = useSize();
  // Frozen at mount: the plan the user confirms is the plan that runs.
  const [runPlan] = useState(() =>
    store.runner.plan(
      groupSelection(index, marks, store.refusal).filter((group) => group.action !== "open"),
    ),
  );
  const groups = runPlan.groups.filter((group) => group.action !== "open");
  const [question, setQuestion] = useState<Question | null>(null);
  const [steps, setSteps] = useState<Step[]>([]);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void store.runner
      .apply(runPlan, (group, stage) => {
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
      })
      .then((manifest) => {
        store.setRun(manifest);
        store.replace({ screen: "result" });
        return manifest;
      })
      .catch((error: unknown) => {
        store.setStatus(error instanceof Error ? error.message : String(error));
        store.replace({ screen: "result" });
      });
  }, [runPlan, store]);

  useKeys((input, key) => {
    if (question === null) return;
    if (input === "y" || input === "Y") question.answer("run");
    else if (input === "n" || input === "N") question.answer("skip");
    // D128: esc skips this group and every remaining one.
    else if (key.escape) question.answer("skip-rest");
  }, !store.helpOpen);

  if (question === null) {
    return (
      <Frame title="confirm" keys="">
        <Text dimColor>{groups.length === 0 ? "nothing to run" : "running…"}</Text>
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
              {verb} these {group.rows.length} rows? (y / n){" "}
              <Text dimColor>{HINT[group.action] ?? ""}</Text>
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
