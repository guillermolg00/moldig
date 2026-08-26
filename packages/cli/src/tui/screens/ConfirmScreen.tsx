/**
 * Screen 8 — Confirm: one group at a time in the order Clean → Delete → Update, each applied
 * immediately after its own confirmation. A group holding user content or permanent rows asks
 * twice. `y` confirms, `n` skips this group, `esc` skips it and every remaining group (D128).
 * A failed row never aborts the run; the Open group is a reading list, never confirmed.
 */
import { Box, Text } from "ink";
import { type ReactElement, useEffect, useRef, useState } from "react";
import { Badges } from "../components/Badges.js";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { formatBytes, plural, truncate } from "../lib/format.js";
import { useKeys } from "../lib/keys.js";
import {
  backupDirFor,
  manifestPathFor,
  newRunId,
  skippedGroup,
  type RunContext,
  type RunGroup,
} from "../lib/runner.js";
import { groupSelection } from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { tokensText } from "./SelectionScreen.js";

const VERB: Readonly<Record<string, string>> = {
  clean: "Clean",
  delete: "Delete",
  update: "Update",
};

const HINT: Readonly<Record<string, string>> = {
  clean: "— every file goes to the OS trash; refused rows stay",
  delete:
    "— trash for files, backup before an entry is edited, the harness's own command otherwise",
  update: "— delegated to each installer; a locally modified copy is backed up first",
};

export function ConfirmScreen(): ReactElement {
  const store = useStore();
  const { index, marks } = store;
  const { rows: screenRows, columns } = useSize();
  // Frozen at mount: the plan the user confirms is the plan that runs.
  const [groups] = useState(() =>
    groupSelection(index, marks, store.refusal).filter((group) => group.action !== "open"),
  );
  const [context] = useState<RunContext>(() => ({
    runId: newRunId(),
    home: store.home,
    platform: store.platform,
    env: store.env,
  }));
  const [step, setStep] = useState(0);
  const [stage, setStage] = useState<"ask" | "extra">("ask");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<RunGroup[]>([]);
  const finished = useRef(false);
  const group = groups[step];

  useEffect(() => {
    if (group !== undefined || finished.current) return;
    finished.current = true;
    store.setRun({
      runId: context.runId,
      manifestPath: manifestPathFor(context),
      backupDir: backupDirFor(context),
      groups: done,
    });
    store.replace({ screen: "result" });
  }, [group, done, context, store]);

  const advance = (results: readonly RunGroup[]): void => {
    setDone((previous) => [...previous, ...results]);
    setStage("ask");
    setStep((previous) => previous + results.length);
  };

  useKeys((input, key) => {
    if (group === undefined || busy) return;
    if (input === "y" || input === "Y") {
      if (stage === "ask" && group.extraConfirm !== null) {
        setStage("extra");
        return;
      }
      setBusy(true);
      void store.runner
        .run([group], context)
        .then((result) => {
          setBusy(false);
          advance(result.groups.length > 0 ? result.groups : [skippedGroup(group)]);
          return result;
        })
        .catch((error: unknown) => {
          setBusy(false);
          const reason = error instanceof Error ? error.message : String(error);
          advance([
            {
              action: group.action,
              title: group.title,
              skipped: false,
              rows: group.rows.map((row) => ({ row, result: "failed", reason, backupPath: null })),
            },
          ]);
        });
    } else if (input === "n" || input === "N") {
      advance([skippedGroup(group)]);
    } else if (key.escape) {
      // D128: esc skips this group and every remaining one.
      advance(groups.slice(step).map(skippedGroup));
    }
  }, !store.helpOpen);

  if (group === undefined) {
    return (
      <Frame title="confirm" keys="">
        <Text dimColor>{groups.length === 0 ? "nothing to run" : "running…"}</Text>
      </Frame>
    );
  }

  const height = listHeight(screenRows, 6);
  const width = Math.max(24, Math.min(44, columns - 60));
  const verb = VERB[group.action] ?? group.title;

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
            · {formatBytes(group.bytes)} · {tokensText(index, group.tokens)}
            {group.sharedCount > 0 ? ` · ${plural(group.sharedCount, "shared row")}` : ""}
          </Text>
        </Text>
        {group.rows.slice(0, height).map((row) => (
          <Text key={row.entity.id}>
            {"  "}
            <Text>{truncate(row.entity.label, width).padEnd(width)}</Text>
            <Text
              color={
                row.disposition.kind === "refused" || row.disposition.permanent ? "red" : "green"
              }
            >
              {" "}
              {row.disposition.text}
            </Text>
            <Badges badges={row.badges} />
            <Text dimColor> {formatBytes(row.bytes)}</Text>
          </Text>
        ))}
        {group.rows.length > height ? (
          <Text dimColor> … {group.rows.length - height} more</Text>
        ) : null}
        <Box paddingTop={1} flexDirection="column">
          {busy ? (
            <Text dimColor>running…</Text>
          ) : stage === "extra" ? (
            <Text color="magenta" bold>
              This group holds {group.extraConfirm}. Confirm again? (y / n)
            </Text>
          ) : (
            <Text bold>
              {verb} these {group.rows.length} rows? (y / n){" "}
              <Text dimColor>{HINT[group.action] ?? ""}</Text>
            </Text>
          )}
          {done.length > 0 ? (
            <Text dimColor>
              so far:{" "}
              {done
                .map(
                  (entry) =>
                    `${entry.title} ${entry.skipped ? "skipped" : plural(entry.rows.length, "row")}`,
                )
                .join(" · ")}
            </Text>
          ) : null}
        </Box>
      </Box>
    </Frame>
  );
}
