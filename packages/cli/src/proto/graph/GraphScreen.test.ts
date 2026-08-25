/**
 * THROWAWAY PROTOTYPE — ticket 13 (ego-graph screen), folded into ticket 09.
 * `createElement`, no JSX: the repo's vitest include is `*.test.ts`.
 */
import { render } from "ink-testing-library";
import { createElement as h } from "react";
import { describe, expect, it, vi } from "vitest";
import { NEIGHBOURHOOD_CAP } from "./ego-graph.js";
import { contextFile, graphFixture, IDS, makeIndex, names, ROOT, skill } from "./fixture.js";
import { GraphScreen, graphHelp, type GraphScreenProps } from "./GraphScreen.js";
import { textWidth } from "./layouts.js";

const ESC = "\u001B";
const KEY = { down: `${ESC}[B`, enter: "\r", esc: ESC };

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

function mount(over: Partial<Pick<GraphScreenProps, "index" | "focusId">> = {}) {
  const onFocus = vi.fn<(id: string) => void>();
  const onOpen = vi.fn<(id: string) => void>();
  const onBack = vi.fn<() => void>();
  const props: GraphScreenProps = {
    index: graphFixture(),
    focusId: IDS.focus,
    onFocus,
    onOpen,
    onBack,
    ...over,
  };
  const instance = render(h(GraphScreen, props));
  const frame = (): string => instance.lastFrame() ?? "";
  const press = async (keys: string): Promise<void> => {
    instance.stdin.write(keys);
    await tick();
  };
  return { ...instance, onFocus, onOpen, onBack, frame, press };
}

const widest = (frame: string): number =>
  Math.max(...frame.split("\n").map((line) => textWidth(line)));

function longIndex() {
  const focus = skill(IDS.focus, `${ROOT}/x/.claude/skills/agent-browser`);
  const files = Array.from({ length: NEIGHBOURHOOD_CAP + 10 }, (_, i) =>
    contextFile(
      `context-file:${ROOT}/p${i}/claude.md`,
      `${ROOT}/p${String(i).padStart(2, "0")}/CLAUDE.md`,
    ),
  );
  return makeIndex({
    entities: [focus, ...files],
    edges: files.map((f) => names(f.id, IDS.focus)),
  });
}

describe("GraphScreen — layouts", () => {
  it("opens on the grouped columns, 80 columns wide at most", () => {
    const { frame, unmount } = mount();
    const out = frame();
    expect(out).toContain("graph · agent-browser · 1 hop · columns");
    expect(out).toContain("» names  ⊳ names a tool  ↦ loaded by  ≈ duplicates  ⇠ originates from");
    expect(out).toContain("← incoming (2)");
    expect(out).toContain("→ outgoing (6)");
    expect(out).toContain("FOCUS");
    expect(out).toContain("✱ Claude Code · desc-only");
    expect(out).toContain("[project] shared");
    expect(out).toContain("8 neighbours · +3 other edges hidden");
    expect(widest(out)).toBeLessThanOrEqual(80);
    unmount();
  });

  it("L switches to the outline, then to the radial picture, then back", async () => {
    const { frame, press, unmount } = mount();
    await press("L");
    let out = frame();
    expect(out).toContain("· outline");
    expect(out).toContain("↦ loaded by (2)");
    expect(out).toContain("→ ✱ Cursor · never · certain");
    expect(out).toContain("? linear dangling");
    expect(widest(out)).toBeLessThanOrEqual(80);

    await press("L");
    out = frame();
    expect(out).toContain("· radial");
    expect(out).toContain("│");
    expect(out).toContain("╲");
    expect(out).toContain("─ ◆ agent-browser [user] ─");
    expect(widest(out)).toBeLessThanOrEqual(80);

    await press("L");
    expect(frame()).toContain("· columns");
    unmount();
  });

  it("+ widens to 2 hops and the outline indents the second hop under its via node", async () => {
    const { frame, press, unmount } = mount();
    await press("+");
    expect(frame()).toContain("· 2 hops ·");
    expect(frame()).toContain("11 neighbours · +4 other edges hidden");
    await press("L");
    const out = frame();
    expect(out).toContain(
      "↳ ← ⊞ frontend-design@anthropic [user] live · full · certain ‹loaded by›",
    );
    expect(out).toContain("↳ ← ◆ old-skill [user] dangling · never · certain ‹loaded by›");
    await press("-");
    expect(frame()).toContain("· 1 hop ·");
    unmount();
  });

  it("windows a long list into a 24-row terminal", () => {
    const { frame, unmount } = mount({ index: longIndex() });
    const out = frame();
    // 24 rows − header 2 − footer 2 − the shell Frame's 4 − 1 spare = 15 body rows
    expect(out.split("\n").length).toBeLessThanOrEqual(19);
    expect(out).toContain("more below");
    expect(out).toContain("60 neighbours · …and 10 more");
    expect(widest(out)).toBeLessThanOrEqual(80);
    unmount();
  });
});

describe("GraphScreen — keys", () => {
  it("enter focuses the highlighted neighbour; ↓ / j / k move the cursor", async () => {
    const { onFocus, press, unmount } = mount();
    await press(KEY.enter);
    expect(onFocus).toHaveBeenLastCalledWith(IDS.projectClaudeMd);
    await press(KEY.down);
    await press(KEY.enter);
    expect(onFocus).toHaveBeenLastCalledWith(IDS.userClaudeMd);
    await press("j");
    await press("j");
    await press(KEY.enter);
    expect(onFocus).toHaveBeenLastCalledWith(IDS.posthog);
    await press("k");
    await press(KEY.enter);
    // the tool configured nowhere is not an item: enter does nothing on it
    expect(onFocus).toHaveBeenCalledTimes(3);
    unmount();
  });

  it("o opens the highlighted item, esc goes back", async () => {
    const { onOpen, onBack, press, unmount } = mount();
    await press(KEY.down);
    await press("o");
    expect(onOpen).toHaveBeenCalledWith(IDS.userClaudeMd);
    await press(KEY.esc);
    expect(onBack).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("o opens the focus itself when it has no neighbours", async () => {
    const { onOpen, press, unmount } = mount({ focusId: "skill:nowhere" });
    await press("o");
    expect(onOpen).toHaveBeenCalledWith("skill:nowhere");
    unmount();
  });

  it("documents every key for the help overlay", () => {
    expect(graphHelp.length).toBeGreaterThanOrEqual(6);
    for (const key of ["enter", "o ", "+ / -", "L ", "esc"]) {
      expect(graphHelp.some((line) => line.startsWith(key))).toBe(true);
    }
  });
});
