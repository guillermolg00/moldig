// THROWAWAY PROTOTYPE (ticket 09) — the app shell: the in-memory store, the navigation
// stack and the global keys (q quit with the summary, ? help, s selection panel).
import type { AuditIndex } from "@moldig/core";
import { Box, Text, useApp } from "ink";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { GraphScreen, graphHelp } from "./graph/GraphScreen.js";
import { shortPath } from "./lib/format.js";
import { type Env, fileUrl, osc8, supportsHyperlinks } from "./lib/hyperlink.js";
import { useKeys } from "./lib/keys.js";
import { openWith, resolveOpener } from "./lib/open.js";
import { type ActionKind, type RunSummary, entityById, initialMarks } from "./lib/selection.js";
import { type ProtoStore, type Route, StoreContext } from "./lib/store.js";
import { summaryText } from "./lib/summary.js";
import { ConfirmScreen } from "./screens/ConfirmScreen.js";
import { DetailScreen } from "./screens/DetailScreen.js";
import { FindingsScreen } from "./screens/FindingsScreen.js";
import { ItemsScreen } from "./screens/ItemsScreen.js";
import { OverviewScreen } from "./screens/OverviewScreen.js";
import { ProjectsScreen } from "./screens/ProjectsScreen.js";
import { ResultScreen } from "./screens/ResultScreen.js";
import { ScanScreen } from "./screens/ScanScreen.js";
import { SelectionScreen } from "./screens/SelectionScreen.js";

export interface AppProps {
  readonly index: AuditIndex;
  readonly env: Env;
  readonly platform: string;
  readonly hostname: string;
  readonly interactive: boolean;
  readonly linksSupported: boolean;
  readonly initialRoute?: Route;
  readonly initialMarks?: ReadonlyMap<string, ActionKind>;
  readonly onSummary?: (text: string) => void;
}

export function App(props: AppProps): ReactElement {
  const { index, env, platform, hostname, interactive, linksSupported } = props;
  const { exit, suspendTerminal } = useApp();
  const [stack, setStack] = useState<Route[]>(() => [
    props.initialRoute ?? (interactive ? { screen: "scan" } : { screen: "overview" }),
  ]);
  const [marks, setMarks] = useState<ReadonlyMap<string, ActionKind>>(
    () => props.initialMarks ?? initialMarks(index),
  );
  const [expanded, setExpandedSet] = useState<ReadonlySet<string>>(() => new Set());
  const [showSettings, setShowSettings] = useState(false);
  const [run, setRun] = useState<RunSummary | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [filterEditing, setFilterEditing] = useState(false);
  const home = index.scan.home;

  const summary = useMemo(
    () => summaryText({ index, marks, run, home, platform }),
    [index, marks, run, home, platform],
  );
  const { onSummary } = props;
  useEffect(() => {
    onSummary?.(summary);
  }, [summary, onSummary]);

  const route = stack.at(-1) ?? { screen: "overview" };

  const store: ProtoStore = {
    index,
    env,
    platform,
    hostname,
    interactive,
    linksSupported,
    home,
    marks,
    setMark: (id, action) =>
      setMarks((m) => {
        const next = new Map(m);
        if (action === null) next.delete(id);
        else next.set(id, action);
        return next;
      }),
    toggleMark: (id, action) =>
      setMarks((m) => {
        const next = new Map(m);
        if (next.get(id) === action) next.delete(id);
        else next.set(id, action);
        return next;
      }),
    toggleMany: (ids, action) =>
      setMarks((m) => {
        const next = new Map(m);
        const all = ids.length > 0 && ids.every((id) => next.get(id) === action);
        for (const id of ids) {
          if (all) next.delete(id);
          else next.set(id, action);
        }
        return next;
      }),
    expanded,
    toggleExpanded: (key) =>
      setExpandedSet((s) => {
        const next = new Set(s);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      }),
    setExpanded: (key, value) =>
      setExpandedSet((s) => {
        const next = new Set(s);
        if (value) next.add(key);
        else next.delete(key);
        return next;
      }),
    showSettings,
    toggleSettings: () => setShowSettings((v) => !v),
    run,
    setRun,
    status,
    setStatus,
    route,
    depth: stack.length - 1,
    push: (r) => {
      setStatus(null);
      setStack((s) => [...s, r]);
    },
    pop: () => {
      setStatus(null);
      setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
    },
    replace: (r) => setStack((s) => [...s.slice(0, -1), r]),
    goHome: () => setStack([{ screen: "overview" }]),
    helpOpen,
    setHelpOpen,
    filterEditing,
    setFilterEditing,
    quit: () => exit(summary),
    openPath: (path, line = 1) => {
      const opener = resolveOpener(env, platform, path, line);
      const label = shortPath(path, home, platform);
      if (opener === null) {
        setStatus(
          `no editor found for ${label}: set $VISUAL or $EDITOR (or cmd+click the link where OSC 8 works)`,
        );
        return;
      }
      setStatus(`opening ${label} with ${opener.command}…`);
      void openWith(opener, { suspendTerminal, platform })
        .then((message) => setStatus(`${label}: ${message}`))
        .catch((error: unknown) =>
          setStatus(`${label}: ${error instanceof Error ? error.message : String(error)}`),
        );
    },
    link: (path, text) => {
      const label = text ?? shortPath(path, home, platform);
      return linksSupported ? osc8(label, fileUrl(path, platform, hostname)) : label;
    },
  };

  useKeys((input) => {
    if (helpOpen) {
      setHelpOpen(false);
      return;
    }
    if (filterEditing) return;
    if (input === "q") store.quit();
    else if (input === "?") setHelpOpen(true);
    else if (
      input === "s" &&
      route.screen !== "selection" &&
      route.screen !== "confirm" &&
      route.screen !== "scan"
    ) {
      store.push({ screen: "selection" });
    }
  }, true);

  let screen: ReactElement;
  switch (route.screen) {
    case "scan":
      screen = <ScanScreen onDone={() => store.replace({ screen: "overview" })} />;
      break;
    case "overview":
      screen = <OverviewScreen />;
      break;
    case "projects":
      screen = <ProjectsScreen />;
      break;
    case "items":
      screen = (
        <ItemsScreen container={route.container} title={route.title} onlyIds={route.onlyIds} />
      );
      break;
    case "findings":
      screen = <FindingsScreen category={route.category} />;
      break;
    case "detail":
      screen = <DetailScreen id={route.id} />;
      break;
    case "selection":
      screen = <SelectionScreen />;
      break;
    case "confirm":
      screen = <ConfirmScreen />;
      break;
    case "result":
      screen = <ResultScreen />;
      break;
    case "graph":
      // The graph renders outside `Frame`, so the `?` overlay is drawn here with its own keys.
      screen = helpOpen ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>Graph keys</Text>
          {graphHelp.map((line) => (
            <Text key={line}>{line}</Text>
          ))}
        </Box>
      ) : (
        <GraphScreen
          index={index}
          focusId={route.focusId}
          onFocus={(id) => store.replace({ screen: "graph", focusId: id })}
          onOpen={(id) => {
            if (entityById(index, id)) store.push({ screen: "detail", id });
            else store.push({ screen: "items", container: id, title: id });
          }}
          onBack={() => store.pop()}
        />
      );
      break;
  }

  return <StoreContext.Provider value={store}>{screen}</StoreContext.Provider>;
}

export { supportsHyperlinks };
