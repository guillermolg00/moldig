// THROWAWAY PROTOTYPE (ticket 09) — screen 8: confirmation, one group at a time in the
// order Clean → Delete → Update; groups holding user content or permanent rows ask twice.
// `y` confirms, `n`/esc skips the group. The run is SIMULATED: nothing on disk changes.
import { Box, Text } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { Badges } from "../components/Badges.js";
import { Frame, listHeight, useSize } from "../components/Frame.js";
import { formatBytes, plural, truncate } from "../lib/format.js";
import { useKeys } from "../lib/keys.js";
import {
  type RunGroup,
  groupSelection,
  manifestPath,
  simulateGroup,
  skippedGroup,
} from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { tokensText } from "./SelectionScreen.js";

export function ConfirmScreen(): ReactElement {
  const store = useStore();
  const { index, marks } = store;
  const { rows: screenRows, columns } = useSize();
  const [groups] = useState(() => groupSelection(index, marks).filter((g) => g.action !== "open"));
  const [runId] = useState(() => new Date().toISOString().replaceAll(":", "-"));
  const [step, setStep] = useState(0);
  const [stage, setStage] = useState<"ask" | "extra">("ask");
  const [done, setDone] = useState<RunGroup[]>([]);
  const group = groups[step];

  useEffect(() => {
    if (group !== undefined) return;
    store.setRun({
      runId,
      manifestPath: manifestPath(runId, store.home, store.platform, store.env),
      groups: done,
    });
    store.replace({ screen: "result" });
  }, [group]);

  const advance = (result: RunGroup): void => {
    setDone((d) => [...d, result]);
    setStage("ask");
    setStep((s) => s + 1);
  };

  useKeys((input, key) => {
    if (!group) return;
    if (input === "y" || input === "Y") {
      if (stage === "ask" && group.extraConfirm !== null) setStage("extra");
      else advance(simulateGroup(group, runId, store.home, store.platform, store.env));
    } else if (input === "n" || input === "N" || key.escape) {
      advance(skippedGroup(group));
    }
  }, !store.helpOpen);

  if (!group) {
    return (
      <Frame title="confirm" keys="">
        <Text dimColor>{groups.length === 0 ? "nothing to run" : "running…"}</Text>
      </Frame>
    );
  }

  const height = listHeight(screenRows, 6);
  const width = Math.max(24, Math.min(44, columns - 60));
  const verb = group.action === "clean" ? "Clean" : group.action === "delete" ? "Delete" : "Update";

  return (
    <Frame
      title={`confirm · ${verb} (${step + 1}/${groups.length})`}
      keys="y confirm · n / esc skip this group · ? help"
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
          {stage === "extra" ? (
            <Text color="magenta" bold>
              This group holds {group.extraConfirm}. Confirm again? (y / n)
            </Text>
          ) : (
            <Text bold>
              {verb} these {group.rows.length} rows? (y / n){" "}
              <Text dimColor>
                {group.action === "clean"
                  ? "— every file goes to the OS trash; refused rows stay"
                  : group.action === "delete"
                    ? "— trash for files, backup before an entry is edited, the harness's own command otherwise"
                    : "— delegated to each installer; a locally modified copy is backed up first"}
              </Text>
            </Text>
          )}
          {done.length > 0 ? (
            <Text dimColor>
              so far:{" "}
              {done
                .map((d) => `${d.title} ${d.skipped ? "skipped" : `${d.rows.length} rows`}`)
                .join(" · ")}
            </Text>
          ) : null}
          <Text dimColor>simulated run — nothing on disk changes in this prototype</Text>
        </Box>
      </Box>
    </Frame>
  );
}
