// THROWAWAY PROTOTYPE (ticket 09) — screen 6: one item: path (OSC 8 link), metrics,
// loaded-by verdicts per harness, placements, "referenced by" (incoming edges), outgoing
// edges, origin / drift, and the actions available with their disposition.
import type { Edge } from "@moldig/core";
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { Badges } from "../components/Badges.js";
import { Frame } from "../components/Frame.js";
import { formatAge, formatBytes, formatTokens, shortPath } from "../lib/format.js";
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

function modeColor(mode: string): { readonly color?: string } {
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
  const { index, marks } = store;
  const entity = entityById(index, id);
  const labelOf = (eid: string | null): string =>
    eid === null ? "(nothing)" : (entityById(index, eid)?.label ?? harnessName(index, eid));

  useKeys((input, key) => {
    if (key.escape) store.pop();
    else if (!entity) return;
    else if (input === " ") {
      if (isTickable(entity)) store.toggleMark(entity.id, "clean");
      else if (entity.ownership === "human") store.toggleMark(entity.id, "open");
    } else if (input === "d" && canDelete(entity)) store.toggleMark(entity.id, "delete");
    else if (input === "u" && canUpdate(entity)) store.toggleMark(entity.id, "update");
    else if (input === "o") store.openPath(entity.path);
    else if (input === "g") store.push({ screen: "graph", focusId: entity.id });
  }, !store.helpOpen);

  if (!entity) {
    return (
      <Frame title="item" keys="esc back">
        <Text color="red">unknown entity {id}</Text>
      </Frame>
    );
  }

  const loadedBy = index.edges.filter(
    (e): e is Extract<Edge, { kind: "loaded-by" }> => e.kind === "loaded-by" && e.from === id,
  );
  const incoming = index.edges.filter((e) => e.to === id && e.kind !== "loaded-by");
  const outgoing = index.edges.filter((e) => e.from === id && e.kind !== "loaded-by");
  const m = entity.metrics;
  const mark = marks.get(id);
  const home = index.scan.home;
  const platform = index.scan.platform;
  const origin = entity.kind === "skill" || entity.kind === "plugin" ? entity.origin : null;
  const drift = entity.kind === "skill" ? entity.drift : null;

  const actions: {
    readonly key: string;
    readonly text: string;
    readonly available: boolean;
    readonly marked: boolean;
  }[] = [
    {
      key: "space",
      text: `clean ${dispositionOf(entity).text}`,
      available: isTickable(entity),
      marked: mark === "clean",
    },
    {
      key: "d",
      text: `delete ${dispositionOf(entity).text}`,
      available: canDelete(entity),
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
          <Badges badges={badgesOf(entity)} />
          <Text dimColor>
            {"  "}
            {entity.kind} · {entity.scope} scope · {entity.ownership}-owned
            {entity.harness ? ` · ${entity.harness}` : " · shared store"} · protection{" "}
            {entity.protection}
          </Text>
        </Text>
        <Text>
          <Text dimColor>path </Text>
          {store.link(entity.path, shortPath(entity.path, home, platform))}
          <Text dimColor>
            {store.linksSupported
              ? "  (cmd+click)"
              : "  (OSC 8 links off in this terminal — press o)"}
          </Text>
        </Text>
        <Text dimColor>
          {formatBytes(m.bytes)} · {m.files ?? "?"} files · {m.lines ?? "?"} lines · age{" "}
          {formatAge(m.ageDays)} ·{" "}
          {m.tokens
            ? `${formatTokens(m.tokens.o200k)} tokens (${m.tokens.method})`
            : "not tokenized"}
          {entity.project
            ? ` · Project ${labelOf(entity.project) === entity.project ? (index.projects.find((p) => p.id === entity.project)?.displayName ?? entity.project) : entity.project}`
            : ""}
        </Text>

        <Section title="Loaded by (one verdict per harness)">
          {loadedBy.length === 0 ? (
            <Text dimColor> no reader loads this item</Text>
          ) : (
            loadedBy.map((e) => (
              <Text key={e.id}>
                {" "}
                <Text color="cyan">{harnessName(index, e.to).padEnd(12)}</Text>
                <Text bold {...modeColor(e.mode)}>
                  {e.mode.padEnd(17)}
                </Text>
                <Text>{e.reason}</Text>
                <Text dimColor>
                  {e.tokensLoaded === null
                    ? ""
                    : ` · ${formatTokens(e.tokensLoaded)} tokens/session`}
                  {e.project
                    ? ` · ${index.projects.find((p) => p.id === e.project)?.displayName ?? e.project}`
                    : " · every session"}
                  {e.effectiveName ? ` · as ${e.effectiveName}` : ""}
                </Text>
              </Text>
            ))
          )}
        </Section>

        {entity.kind === "skill" ? (
          <Section title="Placements">
            {entity.placements.map((p) => (
              <Text key={p.path}>
                {" "}
                {store.link(p.path, shortPath(p.path, home, platform))}
                <Text dimColor>
                  {" "}
                  · {p.scope}
                  {p.harness ? ` · ${p.harness}` : ""}
                  {p.isSymlink ? ` · link → ${p.linkTarget ?? "?"}` : ""}
                </Text>
                {p.dangling ? <Text color="red"> [dangling]</Text> : null}
                {p.shared ? <Text color="yellow"> [shared]</Text> : null}
              </Text>
            ))}
          </Section>
        ) : null}

        <Section title="Referenced by">
          {incoming.length === 0 ? (
            <Text dimColor> nothing references this item</Text>
          ) : (
            incoming.map((e) => (
              <Text key={e.id}>
                {" "}
                <Text color="magenta">{e.kind.padEnd(16)}</Text>
                <Text>{labelOf(e.from)}</Text>
                <Text dimColor> · {e.evidence.map((ev) => ev.detail ?? ev.kind).join("; ")}</Text>
              </Text>
            ))
          )}
        </Section>

        <Section title="Outgoing edges">
          {outgoing.length === 0 ? (
            <Text dimColor> none</Text>
          ) : (
            outgoing.map((e) => (
              <Text key={e.id}>
                {" "}
                <Text color="magenta">{e.kind.padEnd(16)}</Text>
                <Text>→ {labelOf(e.to)}</Text>
                <Text dimColor>
                  {" "}
                  · {e.confidence}
                  {e.evidence[0]?.detail ? ` · ${e.evidence[0].detail}` : ""}
                </Text>
              </Text>
            ))
          )}
        </Section>

        {origin || drift ? (
          <Section title="Origin / drift">
            <Text>
              {" "}
              {origin
                ? `${origin.installer} · ${origin.sourceType} ${origin.source}${origin.ref ? `@${origin.ref.slice(0, 12)}` : ""} · installed ${origin.installedAt?.slice(0, 10) ?? "?"}`
                : "no origin recorded (cannot update)"}
              {drift ? (
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
              ) : null}
            </Text>
          </Section>
        ) : null}

        <Section title="Actions">
          {actions.map((a) => (
            <Text key={a.key} dimColor={!a.available}>
              {" "}
              <Text color="cyan">{a.key.padEnd(6)}</Text>
              <Text>{a.text}</Text>
              {a.marked ? <Text color="magenta"> ✓ selected</Text> : null}
              {!a.available ? <Text dimColor> (not available)</Text> : null}
            </Text>
          ))}
        </Section>
      </Box>
    </Frame>
  );
}
