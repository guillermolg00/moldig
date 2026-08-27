/**
 * Frame and key-map tests for every screen, over a real `AuditIndex` built from the
 * `claude-code/breadcrumbs` fixture (`loadFixture` → `scan` → `audit`). Keys arrive as the
 * escape sequences a terminal sends; assertions read `lastFrame()`.
 *
 * A `.test.ts` without JSX because the Vitest include pattern is `*.test.ts`; `createElement`
 * does the same job.
 */
import { audit, dataDirFor, scan, type AuditIndex, type Entity } from "@moldig/core";
import { loadFixture, POSIX_FIXTURE_HOST, type FixtureTree } from "@moldig/core/testing";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { render } from "ink-testing-library";
import { createElement as h } from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createFakeExecutors,
  type FakeExecutorOptions,
  type FakeExecutors,
} from "../executors/fake.js";
import { ensureDirFor } from "../executors/files.js";
import { App, type AppProps } from "./app.js";
import { openTui } from "./index.js";
import { twoNumberHeader } from "./components/Frame.js";
import { createRunner, type Runner } from "./lib/runner.js";
import { groupSelection, initialMarks, type ActionKind } from "./lib/selection.js";
import type { Route } from "./lib/store.js";

const NOW = new Date("2026-08-26T12:00:00.000Z");

// The escape sequences a terminal sends; `useInput` parses them the same way.
const DOWN = "[B";
const RIGHT = "[C";
const LEFT = "[D";
const ENTER = "\r";
const ESC = "";

let tree: FixtureTree;
let index: AuditIndex;

beforeAll(async () => {
  tree = await loadFixture("claude-code/breadcrumbs", {
    cwd: "root/project-a",
    now: NOW,
    platform: "darwin",
  });
  const scanned = await scan({
    home: tree.home,
    roots: [...tree.roots],
    cwd: tree.cwd,
    platform: "darwin",
    env: tree.env,
    git: false,
    now: NOW,
  });
  index = await audit(scanned);
}, 60_000);

afterAll(async () => {
  await tree.cleanup();
});

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 60));

/**
 * A frame as the assertions below spell paths: forward slashes, and the tree's home written `~`.
 * A terminal prints a path with the host's separator — right for a user on Windows — and
 * `shortPath` shortens a home only when the *scanned* platform spells it the same way, which a
 * case pinned to `darwin` on a Windows runner does not. Both are the product behaving correctly;
 * normalising belongs here, in the assertion, and never in what the TUI prints.
 */
function readable(frame: string): string {
  const home = tree.home.replaceAll("\\", "/");
  return frame.replaceAll("\\", "/").replaceAll(home, "~");
}

interface Screen {
  frame: () => string;
  press: (...keys: string[]) => Promise<void>;
  unmount: () => void;
}

/**
 * A Runner over the fake executors (08 §9): every disposition and every manifest is the real
 * engine's, nothing reaches the OS trash, and the data directory is the fixture's own home.
 */
function fakeRunner(options: Partial<FakeExecutorOptions> = {}): {
  runner: Runner;
  fake: FakeExecutors;
} {
  const fake = createFakeExecutors({
    trashDir: join(tree.dir, "fake-trash"),
    now: NOW,
    move: false,
    ...options,
  });
  const runner = createRunner({
    index,
    executors: fake.executors,
    // Scripted, so a refusal is testable without mounting anything (08 §9).
    deviceOf: () => ({ dev: 1, kind: "local" }),
    dataDir: dataDirFor({ platform: "darwin", env: {}, home: tree.home }),
    platform: "darwin",
    home: tree.home,
    version: "0.0.0",
    command: "moldig clean",
    prepare: (runPlan) => ensureDirFor(runPlan.manifestPath),
  });
  return { runner, fake };
}

function open(route: Route, overrides: Partial<AppProps> = {}): Screen {
  const props: AppProps = {
    index,
    env: {},
    platform: "darwin",
    hostname: "test-host",
    interactive: true,
    linksSupported: false,
    initialRoute: route,
    runner: fakeRunner().runner,
    ...overrides,
  };
  const { lastFrame, stdin, unmount } = render(h(App, props));
  return {
    frame: () => readable(lastFrame() ?? ""),
    press: async (...keys) => {
      for (const key of keys) {
        stdin.write(key);
        // eslint-disable-next-line no-await-in-loop -- one key at a time is the point
        await settle();
      }
    },
    unmount,
  };
}

/**
 * Waits for a transition. Ink renders at most 30 frames a second, and React attaches the new
 * screen's `useInput` in a passive effect — which runs *after* the frame is painted — so the
 * settle keeps the next keypress from landing in the window where nothing is listening.
 */
async function waitFor(screen: Screen, text: string): Promise<void> {
  await vi.waitFor(
    () => {
      if (!screen.frame().includes(text)) throw new Error(`no "${text}" in the frame`);
    },
    { timeout: 4000, interval: 20 },
  );
  await settle();
}

function projectId(): string {
  return index.headline.focus.project ?? "";
}

function harnessId(): string {
  return index.harnesses[0]?.id ?? "";
}

function findEntity(match: (entity: Entity) => boolean): Entity {
  const found = index.entities.find(match);
  if (found === undefined) throw new Error("fixture entity not found");
  return found;
}

/** The 45-day `apps/web` session the audit preselects, and the finding that holds it. */
function sessionFinding(): { id: string; targets: string[] } {
  const finding = index.findings.find((item) => item.message.includes("1 session older than"));
  if (finding === undefined) throw new Error("session finding not found");
  return {
    id: finding.id,
    targets: finding.targets.map((t) => t.id).filter((id): id is string => id !== undefined),
  };
}

describe("scan", () => {
  it("shows the mascot, the harness counts and the roots, then advances to the overview", async () => {
    const screen = open({ screen: "scan" });
    await settle();
    expect(screen.frame()).toContain("moldig · scan");
    expect(screen.frame()).toContain("digging through what your harnesses left behind");
    expect(screen.frame()).toContain("Claude Code");
    expect(screen.frame()).toContain("42 entities");
    expect(screen.frame()).toContain("roots:");
    // The Scan screen replaces itself; it never sits on the navigation stack.
    await waitFor(screen, "moldig · overview");
    screen.unmount();
  });
});

describe("overview", () => {
  it("renders three cleanup scopes and keeps detailed audit data one level down", () => {
    const screen = open({ screen: "overview" });
    const frame = screen.frame();
    expect(frame).toContain("project-a · 1 harness");
    expect(frame).toContain("Clean this project");
    expect(frame).toContain("Clean state from missing projects");
    expect(frame).toContain("Clean all removable state");
    expect(frame).toContain("Review findings");
    expect(frame).toContain("Browse projects");
    expect(frame).not.toContain("every session pays");
    expect(frame).not.toContain("shadow memory");
    screen.unmount();
  });

  it("enter selects this Project in bulk; r and p open the review paths", async () => {
    const screen = open({ screen: "overview" });
    await screen.press(ENTER);
    expect(screen.frame()).toContain("moldig · selection");
    expect(screen.frame()).toContain("7 items selected");
    await screen.press(ESC, "r");
    expect(screen.frame()).toContain("moldig · findings");
    expect(screen.frame()).toContain("shadow memory");
    await screen.press(ENTER);
    expect(screen.frame()).toContain("moldig · duplicate · 2 findings");
    await screen.press(ESC, ESC, "p");
    expect(screen.frame()).toContain("moldig · projects");
    await screen.press(ESC, "s");
    expect(screen.frame()).toContain("moldig · selection");
    await screen.press(ESC, "g");
    expect(screen.frame()).toContain("graph · project-a · 1 hop · columns");
    screen.unmount();
  });

  it("? opens the compact shortcut reference and any key closes it", async () => {
    const screen = open({ screen: "overview" });
    await screen.press("?");
    expect(screen.frame()).toContain("select every removable row in the filtered view");
    expect(screen.frame()).toContain("press any key to close");
    await screen.press("x");
    expect(screen.frame()).toContain("Clean this project");
    screen.unmount();
  });
});

describe("projects", () => {
  it("sorts present projects by session cost and keeps the gone ones collapsed", async () => {
    const screen = open({ screen: "projects" });
    const frame = screen.frame();
    expect(frame).toContain("Projects (1 present, by session cost)");
    expect(frame).toContain("project-a");
    expect(frame).toContain("[cwd]");
    expect(frame).toContain("▸ Gone (1)");
    expect(frame).toContain("2 removable   720 B   space to review");
    expect(frame).toContain("▸ Unreachable (0)");
    expect(frame).toContain("User scope (paid in every session)");
    expect(frame).toContain("Claude Code · user");
    expect(frame).toContain("[2 stray]");
    expect(frame).not.toContain("gone  ");
    // The cursor sits on the present project; two moves down reach the Gone group.
    await screen.press(DOWN, RIGHT);
    expect(screen.frame()).toContain("▾ Gone (1)");
    expect(screen.frame()).toContain("[orphan]");
    screen.unmount();
  });

  it("enter opens the items of the container under the cursor", async () => {
    const screen = open({ screen: "projects" });
    await screen.press(ENTER);
    expect(screen.frame()).toContain("moldig · items");
    expect(screen.frame()).toContain("project-a ·");
    screen.unmount();
  });

  it("space selects a Project or the whole Gone group without visiting every item", async () => {
    const project = open({ screen: "projects" });
    await project.press(" ");
    expect(project.frame()).toContain("7 items selected");
    project.unmount();

    const gone = open({ screen: "projects" });
    await gone.press(DOWN, " ");
    expect(gone.frame()).toContain("2 items selected");
    gone.unmount();
  });
});

describe.runIf(POSIX_FIXTURE_HOST)("items", () => {
  it("groups the sections, keeps human-owned rows quiet and shows the cache groups", () => {
    const screen = open({ screen: "items", container: harnessId(), title: "user" });
    const frame = screen.frame();
    expect(frame).toContain("Claude Code · user scope");
    expect(frame).toContain("Context files (1 row)");
    expect(frame).toContain("MCP servers (2 rows)");
    expect(frame).toContain("Memory (2 rows)");
    expect(frame).toContain("Harness cache (4 rows)");
    expect(frame).not.toContain("advice · o open");
    expect(frame).toContain("shell-snapshot · claude-code");
    expect(frame).toContain("swept after 20 days");
    // The config backup is a count rule, not a day rule: it is tickable but never ticked.
    expect(frame).toContain("the 5 newest are kept");
    expect(frame).toContain("kept by the harness");
    expect(frame).toContain("[user content]");
    expect(frame).not.toContain("Settings files");
    screen.unmount();
  });

  it("h shows and hides the settings files", async () => {
    const screen = open({ screen: "items", container: harnessId(), title: "user" });
    await screen.press("h");
    expect(screen.frame()).toContain("Settings files");
    expect(screen.frame()).toContain("settings files shown");
    await screen.press("h");
    expect(screen.frame()).not.toContain("Settings files");
    screen.unmount();
  });

  it("space toggles a tickable unit and a group toggles all of its units", async () => {
    const { targets } = sessionFinding();
    const screen = open(
      { screen: "items", container: projectId(), title: "t", onlyIds: targets },
      { initialMarks: new Map<string, ActionKind>() },
    );
    await settle();
    expect(screen.frame()).toContain("[ ]");
    expect(screen.frame()).not.toContain("[x]");
    await screen.press(DOWN, " ");
    expect(screen.frame()).toContain("[x]");
    await screen.press(" ");
    expect(screen.frame()).not.toContain("[x]");
    // The group row ticks every unit at once, and untickes them the same way.
    await screen.press("[A", " ");
    expect(screen.frame()).toContain("3/3 selected");
    await screen.press(" ");
    expect(screen.frame()).toContain("0/3 selected");
    screen.unmount();
  });

  it("a toggles every visible tickable row", async () => {
    const { targets } = sessionFinding();
    const screen = open(
      { screen: "items", container: projectId(), title: "t", onlyIds: targets },
      { initialMarks: new Map<string, ActionKind>() },
    );
    await screen.press("a");
    expect(screen.frame()).toContain("3/3 selected");
    await screen.press("a");
    expect(screen.frame()).toContain("0/3 selected");
    screen.unmount();
  });

  it("space explains a human-owned row and d is the explicit destructive action", async () => {
    const screen = open({ screen: "items", container: harnessId(), title: "user" });
    await screen.press(" ");
    expect(screen.frame()).toContain("created or installed by you; use Delete explicitly");
    expect(screen.frame()).not.toContain("→ open");
    await screen.press("d");
    expect(screen.frame()).toContain("→ Delete");
    screen.unmount();
  });

  it("/ filters by label, enter keeps it and esc clears it", async () => {
    const screen = open({ screen: "items", container: harnessId(), title: "user" });
    await screen.press("/", "s", "n", "a", "p");
    expect(screen.frame()).toContain("filter: /snap");
    expect(screen.frame()).toContain("type to filter · enter keep · esc clear");
    expect(screen.frame()).toContain("shell-snapshot");
    expect(screen.frame()).not.toContain("MCP servers");
    await screen.press(ENTER);
    expect(screen.frame()).toContain("filter: /snap");
    await screen.press(ESC);
    expect(screen.frame()).toContain("MCP servers");
    screen.unmount();
  });

  it("says nothing here when the filter matches no row", async () => {
    const screen = open({ screen: "items", container: harnessId(), title: "user" });
    await screen.press("/", "z", "z", "z", "z");
    expect(screen.frame()).toContain("nothing here for /zzzz");
    screen.unmount();
  });

  it("→ expands a memory unit and ← collapses it", async () => {
    const screen = open({ screen: "items", container: harnessId(), title: "user" });
    // Three rows past the first context file is the memory unit group.
    await screen.press(DOWN, DOWN, DOWN);
    expect(screen.frame()).toContain("▸ ~/.claude/projects");
    await screen.press(RIGHT);
    expect(screen.frame()).toContain("▾ ~/.claude/projects");
    expect(screen.frame()).toContain("[never read]");
    await screen.press(LEFT);
    expect(screen.frame()).toContain("▸ ~/.claude/projects");
    screen.unmount();
  });

  it("o says which variable to set when no editor can be found", async () => {
    const screen = open({ screen: "items", container: harnessId(), title: "user" });
    await screen.press("o");
    expect(screen.frame()).toContain("no editor found for ~/.claude/CLAUDE.md");
    expect(screen.frame()).toContain("set $VISUAL or $EDITOR");
    screen.unmount();
  });

  it("enter on an item opens its detail and esc pops back", async () => {
    const screen = open({ screen: "items", container: harnessId(), title: "user" });
    await screen.press(ENTER);
    expect(screen.frame()).toContain("moldig · item · context-file");
    await screen.press(ESC);
    expect(screen.frame()).toContain("moldig · items");
    screen.unmount();
  });
});

describe("category findings", () => {
  it("lists one compact row per finding with severity and impact", () => {
    const screen = open({ screen: "findings", category: "harness-cache" });
    const frame = screen.frame();
    expect(frame).toContain("moldig · harness cache · 4 findings");
    expect(frame).toContain("● low");
    expect(frame).toContain("3 KB");
    expect(frame).not.toContain("action: clean");
    expect(frame).not.toContain("Claude Code · user scope");
    screen.unmount();
  });

  it("says so when a category holds nothing", () => {
    const screen = open({ screen: "findings", category: "bloat" });
    expect(screen.frame()).toContain("no findings in this category");
    screen.unmount();
  });

  it("a on a duplicate finding's targets goes for Update, not Clean (D130)", async () => {
    const screen = open({ screen: "findings", category: "duplicate" });
    await screen.press(ENTER);
    expect(screen.frame()).toContain("moldig · finding");
    await screen.press("a");
    // Nothing in this fixture's duplicate group records an installer, so it says so instead of
    // silently ticking the rows for Clean.
    expect(screen.frame()).toContain("no installer recorded an origin; nothing to update");
    expect(screen.frame()).not.toContain("[x]");
    screen.unmount();
  });

  it("enter opens the target rows with the preselected unit ticked", async () => {
    const screen = open({ screen: "findings", category: "harness-cache" });
    await screen.press(ENTER);
    const frame = screen.frame();
    expect(frame).toContain("moldig · finding");
    expect(frame).toContain("transcript · claude-code");
    expect(frame).toContain("1/3 selected");
    expect(frame).toContain("→ Trash");
    screen.unmount();
  });
});

describe.runIf(POSIX_FIXTURE_HOST)("item detail", () => {
  it("shows a compact path, loading summary and actionable reasons", () => {
    // The user-scope index, named by what the assertions below say — never by whichever
    // memory index `entities` happens to sort first.
    const memory = findEntity(
      (entity) =>
        entity.kind === "memory-file" && entity.role === "index" && entity.scope === "user",
    );
    const screen = open({ screen: "detail", id: memory.id });
    const frame = screen.frame();
    expect(frame).toContain("moldig · item · memory-file");
    expect(frame).toContain("user scope · harness-owned · protection none");
    expect(frame).toContain("~/.claude");
    expect(frame).toContain("Loaded by");
    expect(frame).toContain("44 tokens/session");
    expect(frame).toContain("Clean → Trash");
    expect(frame).toContain("no supported installer recorded an origin");
    screen.unmount();
  });

  it("space marks it for Clean, g opens the graph and esc pops back", async () => {
    // The user-scope index, named by what the assertions below say — never by whichever
    // memory index `entities` happens to sort first.
    const memory = findEntity(
      (entity) =>
        entity.kind === "memory-file" && entity.role === "index" && entity.scope === "user",
    );
    const screen = open({ screen: "detail", id: memory.id });
    await screen.press(" ");
    expect(screen.frame()).toContain("selected");
    await screen.press("g");
    expect(screen.frame()).toContain("graph · MEMORY.md · 1 hop · columns");
    await screen.press(ESC);
    expect(screen.frame()).toContain("moldig · item");
    screen.unmount();
  });

  it("names an unknown id instead of crashing", () => {
    const screen = open({ screen: "detail", id: "skill:nowhere" });
    expect(screen.frame()).toContain("unknown entity skill:nowhere");
    screen.unmount();
  });
});

describe("selection panel", () => {
  const marks = (): Map<string, ActionKind> => {
    const memory = findEntity((entity) => entity.kind === "memory-file" && entity.role === "fact");
    const context = findEntity((entity) => entity.kind === "context-file");
    const next = new Map(initialMarks(index));
    next.set(memory.id, "delete");
    next.set(context.id, "open");
    return next;
  };

  it("groups by action in the order Clean / Delete / Update / Open", () => {
    const groups = groupSelection(index, marks());
    expect(groups.map((group) => group.title)).toEqual(["Clean", "Delete", "Open"]);
    expect(groups[0]?.rows[0]?.disposition.text).toBe("→ Trash");
  });

  it("renders the group headers in order with their counts and dispositions", () => {
    const screen = open({ screen: "selection" }, { initialMarks: marks() });
    const frame = screen.frame();
    const positions = ["Clean (3)", "Delete (1)", "Open (1)"].map((label) => frame.indexOf(label));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions.toSorted((a, b) => a - b)).toEqual(positions);
    expect(frame).toContain("→ Trash");
    expect(frame).toContain("→ open in editor");
    screen.unmount();
  });

  it("space unselects a row and enter with nothing selected says what to do", async () => {
    const screen = open({ screen: "selection" }, { initialMarks: marks() });
    await screen.press(" ");
    expect(screen.frame()).toContain("Clean (2)");
    const empty = open({ screen: "selection" }, { initialMarks: new Map<string, ActionKind>() });
    expect(empty.frame()).toContain("nothing selected");
    await empty.press(ENTER);
    expect(empty.frame()).toContain("nothing selected — go back and choose a cleanup scope");
    screen.unmount();
    empty.unmount();
  });

  it("the two-number header adds up the Clean and Delete rows", () => {
    const header = twoNumberHeader({ index, marks: marks() });
    expect(header).toMatch(/^selected \d+\.\d MB \/ \d+\.\d MB · \d+ \/ \d+ tokens\/session$/u);
    const empty = twoNumberHeader({ index, marks: new Map<string, ActionKind>() });
    expect(empty).toContain("selected 0.0 MB");
  });
});

describe("confirm and result", () => {
  it("y runs the group and the result screen renders the manifest the engine returned", async () => {
    const { runner, fake } = fakeRunner();
    const screen = open({ screen: "confirm" }, { runner });
    await settle();
    expect(screen.frame()).toContain("moldig · confirm · Clean (1/1)");
    expect(screen.frame()).toContain("Clean these 3 rows? (y / n)");
    expect(screen.frame()).toContain("every file goes to the OS trash; refused rows stay");
    expect(screen.frame()).toContain("y confirm · n skip this group · esc skip the rest");
    expect(screen.frame()).toContain("→ Trash");
    await screen.press("y");
    await waitFor(screen, "moldig · result");
    const frame = screen.frame();
    expect(frame).toContain("3 moved");
    expect(frame).toContain("0 failed");
    expect(frame).toContain("Clean   3 rows");
    expect(frame).toContain("manifest ~/.local/share/moldig/runs/");
    // Every member path of the three preselected units, and nothing else.
    expect(fake.trashed.flat().length).toBeGreaterThanOrEqual(3);
    expect(fake.spawned).toEqual([]);
    screen.unmount();
  });

  it("esc skips this group and every remaining one (D128)", async () => {
    const { runner, fake } = fakeRunner();
    const marked = new Map<string, ActionKind>([
      ...initialMarks(index),
      [findEntity((entity) => entity.kind === "harness-cache" && entity.userContent).id, "delete"],
    ]);
    const screen = open({ screen: "confirm" }, { runner, initialMarks: marked });
    await settle();
    expect(screen.frame()).toContain("Clean (1/2)");
    await screen.press(ESC);
    await waitFor(screen, "moldig · result");
    expect(screen.frame()).toContain("Clean   skipped");
    expect(screen.frame()).toContain("Delete  skipped");
    expect(screen.frame()).toContain("0 moved");
    expect(fake.trashed).toEqual([]);
    screen.unmount();
  });

  it("n skips one group and runs the next (D128)", async () => {
    const { runner, fake } = fakeRunner();
    const marked = new Map<string, ActionKind>([
      ...initialMarks(index),
      [findEntity((entity) => entity.kind === "harness-cache" && entity.userContent).id, "delete"],
    ]);
    const screen = open({ screen: "confirm" }, { runner, initialMarks: marked });
    await settle();
    await screen.press("n");
    await waitFor(screen, "confirm · Delete (2/2)");
    expect(screen.frame()).toContain("so far: Clean skipped");
    // The Delete group holds user content, so it is confirmed a second time (08 §7).
    await screen.press("y");
    await waitFor(screen, "This group holds user content. Confirm again? (y / n)");
    await screen.press("y");
    await waitFor(screen, "moldig · result");
    expect(screen.frame()).toContain("Clean   skipped");
    expect(screen.frame()).toContain("Delete  1 row");
    expect(fake.trashed).toHaveLength(1);
    screen.unmount();
  });

  it("enter on the result goes home to the overview", async () => {
    const screen = open({ screen: "confirm" });
    await settle();
    await screen.press("y");
    await waitFor(screen, "moldig · result");
    await screen.press(ENTER);
    await waitFor(screen, "moldig · overview");
    expect(screen.frame()).toContain("Clean this project");
    screen.unmount();
  });

  it("a group holding user content asks a second time", async () => {
    const history = findEntity((entity) => entity.kind === "harness-cache" && entity.userContent);
    const next = new Map<string, ActionKind>([[history.id, "delete"]]);
    const screen = open({ screen: "confirm" }, { initialMarks: next });
    await settle();
    expect(screen.frame()).toContain("moldig · confirm · Delete (1/1)");
    expect(screen.frame()).toContain("[user content]");
    await screen.press("y");
    await waitFor(screen, "This group holds user content. Confirm again? (y / n)");
    await screen.press("n");
    await waitFor(screen, "moldig · result");
    expect(screen.frame()).toContain("Delete  skipped");
    screen.unmount();
  });

  it("the shareable summary after a run is the engine's own (08 §4)", async () => {
    const summaries: string[] = [];
    const { runner } = fakeRunner();
    const screen = open(
      { screen: "confirm" },
      {
        runner,
        onSummary: (text) => {
          summaries.push(text);
        },
      },
    );
    await settle();
    await screen.press("y");
    await waitFor(screen, "moldig · result");
    const summary = summaries.at(-1) ?? "";
    expect(summary).toContain("moldig · project-a");
    expect(summary).toContain("Freed ");
    expect(summary).toContain("Rows: 3 moved · 0 edited · 0 delegated · 0 refused · 0 failed");
    expect(summary).toContain("Manifest: ~/.local/share/moldig/runs/");
    expect(summary).toContain('recovery: OS trash "Put Back"');
    screen.unmount();
  });

  it("a failed row leaves the others done and makes the run exit 1 (D17)", async () => {
    const unit = index.entities.find(
      (entity) => entity.kind === "harness-cache" && initialMarks(index).has(entity.id),
    );
    if (unit === undefined) throw new Error("no preselected unit in the fixture");
    const doomed = unit.locator.type === "paths" ? unit.locator.paths[0] : unit.path;
    const { runner } = fakeRunner({ failing: [doomed ?? ""] });
    const screen = open({ screen: "confirm" }, { runner });
    await settle();
    await screen.press("y");
    await waitFor(screen, "1 failed");
    expect(screen.frame()).toContain("2 moved");
    expect(screen.frame()).toContain("EPERM");
    screen.unmount();
  });
});

describe("graph screen", () => {
  it("opens on the columns layout with the legend and cycles to the outline", async () => {
    // The user-scope index, named by what the assertions below say — never by whichever
    // memory index `entities` happens to sort first.
    const memory = findEntity(
      (entity) =>
        entity.kind === "memory-file" && entity.role === "index" && entity.scope === "user",
    );
    const screen = open({ screen: "graph", focusId: memory.id });
    expect(screen.frame()).toContain("graph · MEMORY.md · 1 hop · columns");
    expect(screen.frame()).toContain(
      "» names  ⊳ names a tool  ↦ loaded by  ≈ duplicates  ⇠ originates from",
    );
    expect(screen.frame()).toContain("FOCUS");
    expect(screen.frame()).toContain("1 neighbour");
    for (const line of screen.frame().split("\n")) expect(line.length).toBeLessThanOrEqual(80);
    await screen.press("L");
    expect(screen.frame()).toContain("· outline");
    await screen.press("+");
    expect(screen.frame()).toContain("· 2 hops ·");
    await screen.press("-");
    expect(screen.frame()).toContain("· 1 hop ·");
    screen.unmount();
  });

  it("? shows the graph keys and never offers radial", async () => {
    const memory = findEntity((entity) => entity.kind === "memory-file");
    const screen = open({ screen: "graph", focusId: memory.id });
    await screen.press("?");
    expect(screen.frame()).toContain("Graph keys");
    expect(screen.frame()).toContain("switch layout: columns → outline");
    expect(screen.frame()).not.toContain("radial");
    screen.unmount();
  });

  it("enter focuses the highlighted neighbour and esc leaves the screen", async () => {
    // The user-scope index, named by what the assertions below say — never by whichever
    // memory index `entities` happens to sort first.
    const memory = findEntity(
      (entity) =>
        entity.kind === "memory-file" && entity.role === "index" && entity.scope === "user",
    );
    const screen = open({ screen: "detail", id: memory.id }, {});
    await screen.press("g", ENTER);
    expect(screen.frame()).toContain("graph · Claude Code · 1 hop");
    await screen.press(ESC);
    expect(screen.frame()).toContain("moldig · item");
    screen.unmount();
  });
});

describe("leaving", () => {
  it("q unmounts and hands back the shareable summary; nothing failed, so the run is 0", async () => {
    const stdout = fakeStdout(true);
    const stdin = fakeStdin(true);
    const pending = openTui({
      index,
      env: {},
      platform: "darwin",
      runner: fakeRunner().runner,
      stdout,
      stdin,
    });
    await settle();
    stdin.write("q");
    const outcome = await pending;
    expect(outcome.failedRows).toBe(0);
    expect(outcome.summary).toContain("moldig · project-a — No changes");
    expect(outcome.summary).toContain("3 items still selected");
    expect(outcome.summary).not.toContain("every session pays");
    expect(outcome.summary).not.toMatch(/\[/u);
  });

  it("a pipe renders one frame, unmounts and still hands back the summary", async () => {
    const stdout = fakeStdout(false);
    const stdin = fakeStdin(false);
    const outcome = await openTui({
      index,
      env: {},
      platform: "darwin",
      runner: fakeRunner().runner,
      stdout,
      stdin,
    });
    expect(outcome.summary).toContain("moldig · project-a — No changes");
    expect(stdout.frames.join("")).toContain("Clean this project");
  });
});

// ---------- fake streams: Ink needs real ones, ink-testing-library hides `waitUntilExit`

interface FakeStdout extends NodeJS.WriteStream {
  frames: string[];
}

// oxlint-disable no-unsafe-type-assertion -- a PassThrough dressed up as a terminal stream

function fakeStdout(isTTY: boolean): FakeStdout {
  const stream = new PassThrough();
  const frames: string[] = [];
  stream.on("data", (chunk: Buffer) => frames.push(String(chunk)));
  Object.assign(stream, { isTTY, columns: 100, rows: 30, frames });
  return stream as unknown as FakeStdout;
}

function fakeStdin(isTTY: boolean): NodeJS.ReadStream {
  const stream = new PassThrough();
  Object.assign(stream, {
    isTTY,
    setRawMode: () => stream,
    ref: () => stream,
    unref: () => stream,
  });
  return stream as unknown as NodeJS.ReadStream;
}
