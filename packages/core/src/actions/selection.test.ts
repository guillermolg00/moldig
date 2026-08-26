import { describe, expect, it } from "vitest";
import type { EntityBase, HarnessCache, MemoryFile, SettingsFile } from "../index/types.js";
import {
  canDelete,
  canUpdate,
  inCleanUniverse,
  isLive,
  isPreselectedUnit,
  isProtected,
  isSizeOnly,
  isTickable,
} from "./selection.js";

const BASE: Omit<EntityBase, "kind"> = {
  id: "harness-cache:/home/.claude/projects/slug/session.jsonl",
  harness: "claude-code",
  producer: null,
  project: null,
  scope: "user",
  ownership: "harness",
  shared: null,
  gitStatus: null,
  path: "/home/.claude/projects/slug/session.jsonl",
  relativePath: null,
  locator: { type: "file", path: "/home/.claude/projects/slug/session.jsonl" },
  format: "jsonl",
  label: "session",
  sensitive: true,
  protection: "none",
  removal: { method: "trash" },
  metrics: {
    bytes: 1024,
    files: 1,
    lines: null,
    mtime: null,
    ageDays: 45,
    tokens: null,
    lastUsed: null,
  },
};

function unit(over: Partial<HarnessCache> = {}): HarnessCache {
  return {
    ...BASE,
    kind: "harness-cache",
    cacheKind: "transcript",
    unit: "session",
    surface: "cli",
    session: null,
    slug: null,
    rule: "swept",
    retention: { days: 20, bytes: null, count: null, source: "cleanupPeriodDays" },
    liveGuard: { kind: "pid", alive: false },
    userContent: false,
    members: { files: 1, bytes: 1024, oldest: null, newest: null },
    ...over,
  };
}

function memory(over: Partial<MemoryFile> = {}): MemoryFile {
  return {
    ...BASE,
    kind: "memory-file",
    id: "memory-file:/home/.claude/projects/slug/memory/topic-a.md",
    path: "/home/.claude/projects/slug/memory/topic-a.md",
    role: "fact",
    unit: "/home/.claude/projects/slug/memory",
    owner: "project",
    frontmatter: {},
    loadedPortion: null,
    reads: null,
    writes: null,
    neverRead: true,
    readSignal: { source: "transcript-tool-use", exact: true, bashParsed: false },
    ...over,
  };
}

function settings(over: Partial<SettingsFile> = {}): SettingsFile {
  return {
    ...BASE,
    kind: "settings-file",
    id: "settings-file:/repo/.mcp.json",
    path: "/repo/.mcp.json",
    ownership: "human",
    role: "mcp-config",
    topLevelKeys: ["mcpServers"],
    entries: 2,
    hooks: [],
    ...over,
  };
}

describe("the predicates of ticket 08", () => {
  it("keeps a Live row out of every action", () => {
    const running = unit({ liveGuard: { kind: "pid", alive: true } });
    expect(isLive(running)).toBe(true);
    expect(isTickable(running)).toBe(false);
    expect(canDelete(running)).toBe(false);
    const flagged = unit({ protection: "live" });
    expect(isLive(flagged)).toBe(true);
    expect(isTickable(flagged)).toBe(false);
  });

  it("keeps a protection: never row out of every action", () => {
    const never = unit({ protection: "never", removal: { method: "none" } });
    expect(isProtected(never)).toBe(true);
    expect(inCleanUniverse(never)).toBe(false);
    expect(isTickable(never)).toBe(false);
    expect(canDelete(never)).toBe(false);
  });

  it("shows a protection: undocumented row size-only", () => {
    const sizeOnly = unit({ protection: "undocumented", removal: { method: "none" } });
    expect(isSizeOnly(sizeOnly)).toBe(true);
    expect(isTickable(sizeOnly)).toBe(false);
    expect(canDelete(sizeOnly)).toBe(false);
  });

  it("leaves a rule: kept unit out of Clean and reachable through Delete (D111)", () => {
    const kept = unit({ rule: "kept", liveGuard: null });
    expect(inCleanUniverse(kept)).toBe(true);
    expect(isTickable(kept)).toBe(false);
    expect(isPreselectedUnit(kept)).toBe(false);
    expect(canDelete(kept)).toBe(true);
  });

  it("ticks a swept and an undocumented unit, preselecting only what the rule allows", () => {
    expect(isTickable(unit())).toBe(true);
    expect(isPreselectedUnit(unit())).toBe(true);
    // No live guard: selectable, never preselected (D105).
    expect(isPreselectedUnit(unit({ liveGuard: null }))).toBe(false);
    // User content is never preselected, and neither is a unit within its retention.
    expect(isPreselectedUnit(unit({ userContent: true }))).toBe(false);
    expect(isPreselectedUnit(unit({ metrics: { ...BASE.metrics, ageDays: 5 } }))).toBe(false);
    const undocumented = unit({
      rule: "undocumented",
      retention: { days: null, bytes: null, count: null, source: null },
    });
    expect(isTickable(undocumented)).toBe(true);
    expect(isPreselectedUnit(undocumented)).toBe(false);
  });

  it("ticks a memory file by kind and never preselects it", () => {
    const fact = memory();
    expect(isTickable(fact)).toBe(true);
    expect(isPreselectedUnit(fact)).toBe(false);
    expect(canDelete(fact)).toBe(true);
  });

  it("never deletes a settings file — its entries are deletable, the file is not (D142)", () => {
    // The Claude Code slice on `main` emits a project `.mcp.json` with a trash removal; the
    // engine refuses it whatever the adapter says.
    const asOnMain = settings({ protection: "none", removal: { method: "trash" } });
    expect(isProtected(asOnMain)).toBe(true);
    expect(canDelete(asOnMain)).toBe(false);
    expect(isTickable(asOnMain)).toBe(false);
    expect(inCleanUniverse(asOnMain)).toBe(false);
  });

  it("offers Update only where an Installer is recognised", () => {
    expect(canUpdate(unit())).toBe(false);
    expect(canUpdate(memory())).toBe(false);
  });
});
