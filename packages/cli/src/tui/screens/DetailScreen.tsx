/**
 * Screen 6 — Item detail: one item, with its path as an OSC 8 link, its metrics, the `loaded-by`
 * verdict of every harness that can see it, its placements, what references it and what it
 * references, its origin and drift, and the actions available with their disposition.
 */
import type { Edge, LoadedByEdge } from "@moldig/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { Badges } from "../components/Badges.js";
import { Frame } from "../components/Frame.js";
import { formatAge, formatBytes, formatTokens, shortPath } from "../lib/format.js";
import { clickHint } from "../lib/hyperlink.js";
import { useKeys } from "../lib/keys.js";
import {
  badgesOf,
  canDelete,
  canUpdate,
  dispositionOf,
  entityById,
  isTickable,
  updateDisposition,
} from "../lib/selection.js";
import { useStore } from "../lib/store.js";
import { harnessName } from "../lib/summary.js";

function modeColor(mode: LoadedByEdge["mode"]): { readonly color?: string } {
  if (mode === "full") return { color: "yellow" };
  if (mode === "never" || mode === "disabled" || mode === "shadowed") return { color: "red" };
  return {};
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactElement | readonly ReactElement[] | null;
}): ReactElement {
  return (
    <Box flexDirection="column" paddingTop={1}>
      <Text bold>{title}</Text>
      {children}
    </Box>
  );
}

export function DetailScreen({ id }: { readonly id: string }): ReactElement {
  const store = useStore();
  const { index, marks, refusal } = store;
  const entity = entityById(index, id);
  const labelOf = (nodeId: string | null): string =>
    nodeId === null
      ? "(nothing)"
      : (entityById(index, nodeId)?.label ?? harnessName(index, nodeId));
  const projectName = (projectId: string): string =>
    index.projects.find((project) => project.id === projectId)?.displayName ?? projectId;

  useKeys((input, key) => {
    if (key.escape) store.pop();
    else if (entity === undefined) return;
    else if (input === " ") {
      if (isTickable(entity, refusal)) store.toggleMark(entity.id, "clean");
      else if (entity.ownership === "human") store.toggleMark(entity.id, "open");
    } else if (input === "d" && canDelete(entity, refusal)) store.toggleMark(entity.id, "delete");
    else if (input === "u" && canUpdate(entity)) store.toggleMark(entity.id, "update");
    else if (input === "o") store.openPath(entity.path);
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
  const incoming = index.edges.filter((edge: Edge) => edge.to === id && edge.kind !== "loaded-by");
  const outgoing = index.edges.filter(
    (edge: Edge) => edge.from === id && edge.kind !== "loaded-by",
  );
  const metrics = entity.metrics;
  const mark = marks.get(id);
  const { home, platform } = index.scan;
  const origin = entity.kind === "skill" || entity.kind === "plugin" ? entity.origin : null;
  const drift = entity.kind === "skill" ? entity.drift : null;
  const caps = index.harnesses.find((harness) => harness.harness === entity.harness)?.caps;
  const indexCap =
    entity.kind === "memory-file" &&
    entity.role === "index" &&
    caps !== undefined &&
    caps.memoryIndexLines !== null &&
    caps.memoryIndexBytes !== null
      ? `first ${caps.memoryIndexLines} lines / ${formatBytes(caps.memoryIndexBytes)} in every session`
      : null;

  const actions: readonly {
    readonly key: string;
    readonly text: string;
    readonly available: boolean;
    readonly marked: boolean;
  }[] = [
    {
      key: "space",
      text: `clean ${dispositionOf(entity, refusal).text}`,
      available: isTickable(entity, refusal),
      marked: mark === "clean",
    },
    {
      key: "d",
      text: `delete ${dispositionOf(entity, refusal).text}`,
      available: canDelete(entity, refusal),
      marked: mark === "delete",
    },
    {
      key: "u",
      text: `update ${updateDisposition(entity)?.text ?? "(no installer)"}`,
      available: canUpdate(entity),
      marked: mark === "update",
    },
    { key: "o", text: "open in the editor", available: true, marked: mark === "open" },
  ];

  return (
    <Frame
      title={`item · ${entity.kind}`}
      keys="space clean · d delete · u update · o open · g graph · esc back · ? help"
    >
      <Box flexDirection="column">
        <Text>
          <Text bold>{entity.label}</Text>
          <Badges badges={badgesOf(entity, refusal)} />
          <Text dimColor>
            {"  "}
            {entity.kind} · {entity.scope} scope · {entity.ownership}-owned
            {entity.harness === null ? " · shared store" : ` · ${entity.harness}`} · protection{" "}
            {entity.protection}
          </Text>
        </Text>
        <Text>
          <Text dimColor>path </Text>
          {store.link(entity.path, shortPath(entity.path, home, platform))}
          <Text dimColor>
            {store.linksSupported
              ? `  (${clickHint(platform)})`
              : "  (OSC 8 links off in this terminal — press o)"}
          </Text>
        </Text>
        <Text dimColor>
          {formatBytes(metrics.bytes)} · {metrics.files ?? "?"} files · {metrics.lines ?? "?"} lines
          · age {formatAge(metrics.ageDays)} ·{" "}
          {metrics.tokens
            ? `${formatTokens(metrics.tokens.o200k)} tokens (${metrics.tokens.method})`
            : "not tokenized"}
          {entity.project === null ? "" : ` · Project ${projectName(entity.project)}`}
        </Text>
        {indexCap === null ? null : <Text dimColor>{indexCap}</Text>}

        <Section title="Loaded by (one verdict per harness)">
          {loadedBy.length === 0 ? (
            <Text dimColor> no reader loads this item</Text>
          ) : (
            loadedBy.map((edge) => (
              <Text key={edge.id}>
                {" "}
                <Text color="cyan">{harnessName(index, edge.to).padEnd(12)}</Text>
                <Text bold {...modeColor(edge.mode)}>
                  {edge.mode.padEnd(17)}
                </Text>
                <Text>{edge.reason}</Text>
                <Text dimColor>
                  {edge.tokensLoaded === null
                    ? ""
                    : ` · ${formatTokens(edge.tokensLoaded)} tokens/session`}
                  {edge.project === null ? " · every session" : ` · ${projectName(edge.project)}`}
                  {edge.effectiveName === null ? "" : ` · as ${edge.effectiveName}`}
                </Text>
              </Text>
            ))
          )}
        </Section>

        {entity.kind === "skill" ? (
          <Section title="Placements">
            {entity.placements.map((placement) => (
              <Text key={placement.path}>
                {" "}
                {store.link(placement.path, shortPath(placement.path, home, platform))}
                <Text dimColor>
                  {" "}
                  · {placement.scope}
                  {placement.harness === null ? "" : ` · ${placement.harness}`}
                  {placement.isSymlink ? ` · link → ${placement.linkTarget ?? "?"}` : ""}
                </Text>
                {placement.dangling ? <Text color="red"> [dangling]</Text> : null}
                {placement.shared ? <Text color="yellow"> [shared]</Text> : null}
              </Text>
            ))}
          </Section>
        ) : null}

        <Section title="Referenced by">
          {incoming.length === 0 ? (
            <Text dimColor> nothing references this item</Text>
          ) : (
            incoming.map((edge) => (
              <Text key={edge.id}>
                {" "}
                <Text color="magenta">{edge.kind.padEnd(16)}</Text>
                <Text>{labelOf(edge.from)}</Text>
                <Text dimColor>
                  {" "}
                  · {edge.evidence.map((item) => item.detail ?? item.kind).join("; ")}
                </Text>
              </Text>
            ))
          )}
        </Section>

        <Section title="Outgoing edges">
          {outgoing.length === 0 ? (
            <Text dimColor> none</Text>
          ) : (
            outgoing.map((edge) => (
              <Text key={edge.id}>
                {" "}
                <Text color="magenta">{edge.kind.padEnd(16)}</Text>
                <Text>→ {labelOf(edge.to)}</Text>
                <Text dimColor>
                  {" "}
                  · {edge.confidence}
                  {edge.evidence[0]?.detail === undefined ? "" : ` · ${edge.evidence[0].detail}`}
                </Text>
              </Text>
            ))
          )}
        </Section>

        {origin !== null || drift !== null ? (
          <Section title="Origin / drift">
            <Text>
              {" "}
              {origin === null
                ? "no origin recorded (cannot update)"
                : `${origin.installer} · ${origin.sourceType} ${origin.source}${origin.ref === null ? "" : `@${origin.ref.slice(0, 12)}`} · installed ${origin.installedAt?.slice(0, 10) ?? "?"}`}
              {drift === null ? null : (
                <Text
                  {...(drift === "none"
                    ? { color: "green" }
                    : drift === "unknown"
                      ? {}
                      : { color: "yellow" })}
                >
                  {" "}
                  · drift: {drift}
                </Text>
              )}
              {origin !== null && !canUpdate(entity) ? (
                <Text dimColor> · no installer recognised</Text>
              ) : null}
            </Text>
          </Section>
        ) : null}

        <Section title="Actions">
          {actions.map((action) => (
            <Text key={action.key} dimColor={!action.available}>
              {" "}
              <Text color="cyan">{action.key.padEnd(6)}</Text>
              <Text>{action.text}</Text>
              {action.marked ? <Text color="magenta"> ✓ selected</Text> : null}
              {action.available ? null : <Text dimColor> (not available)</Text>}
            </Text>
          ))}
        </Section>
      </Box>
    </Frame>
  );
}
