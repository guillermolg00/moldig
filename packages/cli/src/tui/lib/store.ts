/**
 * The in-memory store and the navigation stack every screen reads through context. Built in
 * `app.tsx`; nothing here touches the filesystem.
 */
import type { AuditIndex, Category, RunManifest } from "@moldig/core";
import { type Context, createContext, useContext } from "react";
import type { Env } from "./hyperlink.js";
import type { Runner } from "./runner.js";
import type { ActionKind, Refusal } from "./selection.js";

export type Route =
  | { readonly screen: "scan" }
  | { readonly screen: "overview" }
  | { readonly screen: "projects" }
  | {
      readonly screen: "items";
      readonly container: string | null;
      readonly title: string;
      readonly onlyIds?: readonly string[];
      /** Set on a duplicate or drift finding: `a` marks every copy for Update (D130). */
      readonly updateAll?: boolean;
    }
  | { readonly screen: "findings"; readonly category: Category }
  | { readonly screen: "detail"; readonly id: string }
  | { readonly screen: "selection" }
  | { readonly screen: "confirm" }
  | { readonly screen: "result" }
  | { readonly screen: "graph"; readonly focusId: string };

export interface Store {
  readonly index: AuditIndex;
  readonly env: Env;
  readonly platform: string;
  readonly hostname: string;
  readonly interactive: boolean;
  readonly linksSupported: boolean;
  readonly home: string;
  readonly runner: Runner;
  readonly refusal: Refusal;

  readonly marks: ReadonlyMap<string, ActionKind>;
  readonly setMark: (id: string, action: ActionKind | null) => void;
  readonly toggleMark: (id: string, action: ActionKind) => void;
  readonly toggleMany: (ids: readonly string[], action: ActionKind) => void;

  readonly expanded: ReadonlySet<string>;
  readonly toggleExpanded: (key: string) => void;
  readonly setExpanded: (key: string, value: boolean) => void;
  readonly showSettings: boolean;
  readonly toggleSettings: () => void;

  readonly run: RunManifest | null;
  readonly setRun: (run: RunManifest | null) => void;

  readonly status: string | null;
  readonly setStatus: (status: string | null) => void;

  readonly route: Route;
  readonly depth: number;
  readonly push: (route: Route) => void;
  readonly pop: () => void;
  readonly replace: (route: Route) => void;
  /** Back to the Overview, stack reset. */
  readonly goHome: () => void;
  readonly helpOpen: boolean;
  readonly setHelpOpen: (open: boolean) => void;
  readonly filterEditing: boolean;
  readonly setFilterEditing: (editing: boolean) => void;
  readonly quit: () => void;

  readonly openPath: (path: string, line?: number) => void;
  /** The path as an OSC 8 hyperlink when the terminal takes them, plain text otherwise. */
  readonly link: (path: string, text?: string) => string;
}

export const StoreContext: Context<Store | null> = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(StoreContext);
  if (store === null) throw new Error("useStore outside of <StoreContext.Provider>");
  return store;
}
