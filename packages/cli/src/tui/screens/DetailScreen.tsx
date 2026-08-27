/** A compact item card. Full relationships stay behind `g` instead of flooding the default view. */
import type { LoadedByEdge } from "@moldig/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { Badges } from "../components/Badges.js";
import { Frame, useSize } from "../components/Frame.js";
import { formatAge, formatBytes, formatTokens, shortPath, truncate } from "../lib/format.js";
import { useKeys } from "../lib/keys.js";
import {
  badgesOf,
  dispositionOf,
  entityById,
  isTickable,
  unavailableReason,
  updateDisposition,
} from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { harnessName } from "../lib/summary.js";

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactElement | readonly ReactElement[] | null;
}): ReactElement {
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Text>{title}</Text>
      {children}
    </Box>
  );
}

export function DetailScreen({ id }: { readonly id: string }): ReactElement {
  const store = useStore();
  const { index, marks, refusal } = store;
  const { columns } = useSize();
  const entity = entityById(index, id);

  useKeys((input, key) => {
    if (key.escape) store.pop();
    else if (entity === undefined) return;
    else if (input === " ") {
      if (isTickable(entity, refusal)) store.toggleMark(entity.id, "clean");
      else store.setStatus(`${entity.label}: ${unavailableReason(entity, "clean", refusal)}`);
    } else if (input === "d") {
      const why = unavailableReason(entity, "delete", refusal);
      if (why === null) store.toggleMark(entity.id, "delete");
      else store.setStatus(`${entity.label}: ${why}`);
    } else if (input === "u") {
      const why = unavailableReason(entity, "update", refusal);
      if (why === null) store.toggleMark(entity.id, "update");
      else store.setStatus(`${entity.label}: ${why}`);
    } else if (input === "o") store.openPath(entity.path);
    else if (input === "g") store.push({ screen: "graph", focusId: entity.id });
  }, !store.helpOpen);

  if (entity === undefined) {
    return (
      <Frame title="item" keys="esc back">
        <Text color="red">unknown entity {id}</Text>
      </Frame>
    );
  }

  const loadedBy = index.edges.filter(
    (edge): edge is LoadedByEdge => edge.kind === "loaded-by" && edge.from === id,
  );
  const mark = marks.get(id);
  const metrics = entity.metrics;
  const path = truncate(
    shortPath(entity.path, index.scan.home, index.scan.platform),
    Math.max(24, columns - 8),
  );
  const project =
    entity.project === null
      ? null
      : (index.projects.find((candidate) => candidate.id === entity.project)?.displayName ?? null);
  const origin = entity.kind === "skill" || entity.kind === "plugin" ? entity.origin : null;
  const drift = entity.kind === "skill" ? entity.drift : null;
  const actions: readonly {
    readonly key: string;
    readonly text: string;
    readonly unavailable: string | null;
    readonly marked: boolean;
  }[] = [
    {
      key: "space",
      text: `Clean ${dispositionOf(entity, refusal).text}`,
      unavailable: unavailableReason(entity, "clean", refusal),
      marked: mark === "clean",
    },
    {
      key: "d",
      text: `Delete ${dispositionOf(entity, refusal).text}`,
      unavailable: unavailableReason(entity, "delete", refusal),
      marked: mark === "delete",
    },
    {
      key: "u",
      text:
        updateDisposition(entity) === null ? "Update" : `Update ${updateDisposition(entity)?.text}`,
      unavailable: unavailableReason(entity, "update", refusal),
      marked: mark === "update",
    },
    { key: "o", text: "Open in editor", unavailable: null, marked: false },
  ];

  return (
    <Frame
      title={`item · ${entity.kind}`}
      subtitle={`${entity.scope} scope · ${entity.ownership}-owned · protection ${entity.protection}`}
      keys="space clean   d delete   u update   o open   g graph   esc back"
    >
      <Box flexDirection="column">
        <Text>
          <Text>{entity.label}</Text>
          <Badges badges={badgesOf(entity, refusal)} />
        </Text>
        <Text dimColor>{store.link(entity.path, path)}</Text>
        <Text dimColor>
          {formatBytes(metrics.bytes)} {formatAge(metrics.ageDays)}
          {metrics.tokens === null ? "" : `   ${formatTokens(metrics.tokens.o200k)} tokens`}
          {project === null ? "" : `   ${project}`}
        </Text>

        <Section title="Loaded by">
          {loadedBy.length === 0 ? (
            <Text dimColor> No harness loads this item.</Text>
          ) : (
            loadedBy.slice(0, 6).map((edge) => (
              <Text key={edge.id}>
                {"  "}
                <Text>{harnessName(index, edge.to).padEnd(16)}</Text>
                <Text dimColor>
                  {edge.mode}
                  {edge.tokensLoaded === null
                    ? ""
                    : `   ${formatTokens(edge.tokensLoaded)} tokens/session`}
                </Text>
              </Text>
            ))
          )}
        </Section>

        {entity.kind === "skill" ? (
          <Text dimColor>
            {entity.placements.length} placements
            {drift === null ? "" : `   drift ${drift}`}
          </Text>
        ) : null}
        {origin === null ? null : (
          <Text dimColor>
            Origin {origin.installer} {origin.source}
          </Text>
        )}

        <Section title="Actions">
          {actions.map((action) => (
            <Text key={action.key} dimColor={action.unavailable !== null}>
              {"  "}
              <Text color="cyan">{action.key.padEnd(8)}</Text>
              <Text>{action.text}</Text>
              {action.marked ? <Text color="magenta"> selected</Text> : null}
              {action.unavailable === null ? null : <Text dimColor> {action.unavailable}</Text>}
            </Text>
          ))}
        </Section>
      </Box>
    </Frame>
  );
}
