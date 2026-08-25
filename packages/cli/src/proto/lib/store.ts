// THROWAWAY PROTOTYPE (ticket 09) — the in-memory store and the navigation stack every
// screen reads through context. Built in App.tsx; nothing here touches the filesystem.
import type { AuditIndex, Category } from "@moldig/core";
import { type Context, createContext, useContext } from "react";
import type { Env } from "./hyperlink.js";
import type { ActionKind, RunSummary } from "./selection.js";

export type Route =
  | { readonly screen: "scan" }
  | { readonly screen: "overview" }
  | { readonly screen: "projects" }
  | {
      readonly screen: "items";
      readonly container: string | null;
      readonly title: string;
      readonly onlyIds?: readonly string[];
    }
  | { readonly screen: "findings"; readonly category: Category }
  | { readonly screen: "detail"; readonly id: string }
  | { readonly screen: "selection" }
  | { readonly screen: "confirm" }
  | { readonly screen: "result" }
  | { readonly screen: "graph"; readonly focusId: string };

export interface ProtoStore {
  readonly index: AuditIndex;
  readonly env: Env;
  readonly platform: string;
  readonly hostname: string;
  readonly interactive: boolean;
  readonly linksSupported: boolean;
  readonly home: string;

  readonly marks: ReadonlyMap<string, ActionKind>;
  readonly setMark: (id: string, action: ActionKind | null) => void;
  readonly toggleMark: (id: string, action: ActionKind) => void;
  readonly toggleMany: (ids: readonly string[], action: ActionKind) => void;

  readonly expanded: ReadonlySet<string>;
  readonly toggleExpanded: (key: string) => void;
  readonly setExpanded: (key: string, value: boolean) => void;
  readonly showSettings: boolean;
  readonly toggleSettings: () => void;

  readonly run: RunSummary | null;
  readonly setRun: (run: RunSummary | null) => void;

  readonly status: string | null;
  readonly setStatus: (status: string | null) => void;

  readonly route: Route;
  readonly depth: number;
  readonly push: (route: Route) => void;
  readonly pop: () => void;
  readonly replace: (route: Route) => void;
  readonly goHome: () => void; // back to the overview
  readonly helpOpen: boolean;
  readonly setHelpOpen: (open: boolean) => void;
  readonly filterEditing: boolean;
  readonly setFilterEditing: (editing: boolean) => void;
  readonly quit: () => void;

  readonly openPath: (path: string, line?: number) => void;
  readonly link: (path: string, text?: string) => string;
}

export const StoreContext: Context<ProtoStore | null> = createContext<ProtoStore | null>(null);

export function useStore(): ProtoStore {
  const store = useContext(StoreContext);
  if (store === null) throw new Error("useStore outside of <StoreContext.Provider>");
  return store;
}
