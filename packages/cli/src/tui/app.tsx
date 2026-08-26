/**
 * The app shell: the in-memory store, the navigation stack and the global keys — `q` leaves the
 * alternate screen and prints the shareable summary, `?` opens the help overlay (any key closes
 * it), `s` pushes the selection panel.
 *
 * Nothing here touches the filesystem except the editor hand-off `o` asks for; the index arrives
 * finished and the actions engine is injected as a `Runner`.
 */
import type { AuditIndex, RunManifest } from "@moldig/core";
import { Box, Text, useApp } from "ink";
import { type ReactElement, useEffect, useMemo, useState } from "react";
import { GraphScreen, graphHelp } from "./graph/GraphScreen.js";
import { shortPath } from "./lib/format.js";
import { fileUrl, osc8, type Env } from "./lib/hyperlink.js";
import { useKeys } from "./lib/keys.js";
import { openWith, resolveOpener } from "./lib/open.js";
import type { Runner } from "./lib/runner.js";
import { initialMarks, type ActionKind, type Refusal } from "./lib/selection.js";
import { StoreContext, type Route, type Store } from "./lib/store.js";
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
  readonly runner: Runner;
  readonly initialRoute?: Route;
  readonly initialMarks?: ReadonlyMap<string, ActionKind>;
  /** Called with the summary on every state change, so the caller always holds the latest. */
  readonly onSummary?: (text: string) => void;
  /** Called once a run lands, so the caller can pick the exit code (D17). */
  readonly onRun?: (run: RunManifest) => void;
}

export function App(props: AppProps): ReactElement {
  const { index, env, platform, hostname, interactive, linksSupported } = props;
  const { exit, suspendTerminal } = useApp();
  const { runner } = props;
  const refusal = useMemo<Refusal>(() => (entity) => runner.refusal(entity), [runner]);
  const [stack, setStack] = useState<Route[]>(() => [
    props.initialRoute ?? (interactive ? { screen: "scan" } : { screen: "overview" }),
  ]);
  const [marks, setMarks] = useState<ReadonlyMap<string, ActionKind>>(
    () => props.initialMarks ?? initialMarks(index, refusal),
  );
  const [expanded, setExpandedSet] = useState<ReadonlySet<string>>(() => new Set());
  const [showSettings, setShowSettings] = useState(false);
  const [run, setRun] = useState<RunManifest | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [filterEditing, setFilterEditing] = useState(false);
  const home = index.scan.home;

  const summary = useMemo(
    () => summaryText({ index, marks, run, home, platform, refusal }),
    [index, marks, run, home, platform, refusal],
  );
  const { onSummary, onRun } = props;
  useEffect(() => {
    onSummary?.(summary);
  }, [summary, onSummary]);
  useEffect(() => {
    if (run !== null) onRun?.(run);
  }, [run, onRun]);

  const route = stack.at(-1) ?? { screen: "overview" };

  const store: Store = {
    index,
    env,
    platform,
    hostname,
    interactive,
    linksSupported,
    home,
    runner,
    refusal,
    marks,
    setMark: (id, action) => {
      setMarks((current) => {
        const next = new Map(current);
        if (action === null) next.delete(id);
        else next.set(id, action);
        return next;
      });
    },
    toggleMark: (id, action) => {
      setMarks((current) => {
        const next = new Map(current);
        // One action per entity: the same action again clears it, another replaces it.
        if (next.get(id) === action) next.delete(id);
        else next.set(id, action);
        return next;
      });
    },
    toggleMany: (ids, action) => {
      setMarks((current) => {
        const next = new Map(current);
        // All-or-none: every id already marked clears them all, otherwise all are set.
        const all = ids.length > 0 && ids.every((id) => next.get(id) === action);
        for (const id of ids) {
          if (all) next.delete(id);
          else next.set(id, action);
        }
        return next;
      });
    },
    expanded,
    toggleExpanded: (key) => {
      setExpandedSet((current) => {
        const next = new Set(current);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return next;
      });
    },
    setExpanded: (key, value) => {
      setExpandedSet((current) => {
        const next = new Set(current);
        if (value) next.add(key);
        else next.delete(key);
        return next;
      });
    },
    showSettings,
    toggleSettings: () => {
      setShowSettings((value) => !value);
    },
    run,
    setRun,
    status,
    setStatus,
    route,
    depth: stack.length - 1,
    push: (next) => {
      setStatus(null);
      setStack((current) => [...current, next]);
    },
    pop: () => {
      setStatus(null);
      setStack((current) => (current.length > 1 ? current.slice(0, -1) : current));
    },
    replace: (next) => {
      setStack((current) => [...current.slice(0, -1), next]);
    },
    goHome: () => {
      setStatus(null);
      setStack([{ screen: "overview" }]);
    },
    helpOpen,
    setHelpOpen,
    filterEditing,
    setFilterEditing,
    quit: () => {
      exit(summary);
    },
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
        .then((message) => {
          setStatus(`${label}: ${message}`);
          return message;
        })
        .catch((error: unknown) => {
          setStatus(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        });
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
      screen = (
        <ScanScreen
          onDone={() => {
            store.replace({ screen: "overview" });
          }}
        />
      );
      break;
    case "overview":
      screen = <OverviewScreen />;
      break;
    case "projects":
      screen = <ProjectsScreen />;
      break;
    case "items":
      screen = (
        <ItemsScreen
          container={route.container}
          title={route.title}
          onlyIds={route.onlyIds}
          updateAll={route.updateAll}
        />
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
    default:
      // The graph draws its own chrome, so the `?` overlay is rendered here with its own keys.
      screen = helpOpen ? (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>Graph keys</Text>
          {graphHelp.map((line) => (
            <Text key={line}>{line}</Text>
          ))}
        </Box>
      ) : (
        <GraphScreen focusId={route.focusId} />
      );
      break;
  }

  return <StoreContext.Provider value={store}>{screen}</StoreContext.Provider>;
}
