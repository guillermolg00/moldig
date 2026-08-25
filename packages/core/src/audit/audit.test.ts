import { describe, expect, it } from "vitest";
import type { HarnessCache } from "../index/types.js";
import { isPreselected } from "./audit.js";

function unit(overrides: Partial<HarnessCache>): HarnessCache {
  return {
    id: "harness-cache:/x",
    kind: "harness-cache",
    harness: "claude-code",
    producer: null,
    project: null,
    scope: "user",
    ownership: "harness",
    shared: null,
    gitStatus: "outside-repo",
    path: "/x",
    relativePath: null,
    locator: { type: "file", path: "/x" },
    format: "jsonl",
    label: "x",
    sensitive: true,
    protection: "none",
    removal: { method: "trash" },
    metrics: {
      bytes: 1,
      files: 1,
      lines: null,
      mtime: null,
      ageDays: 45,
      tokens: null,
      lastUsed: null,
    },
    cacheKind: "transcript",
    unit: "session",
    surface: "cli",
    session: null,
    slug: null,
    rule: "swept",
    retention: { days: 20, bytes: null, count: null, source: "cleanupPeriodDays" },
    liveGuard: { kind: "pid", alive: false },
    userContent: false,
    members: { files: 1, bytes: 1, oldest: null, newest: null },
    ...overrides,
  };
}

describe("isPreselected (ticket 08)", () => {
  it("preselects a swept unit older than its retention with a clear live guard", () => {
    expect(isPreselected(unit({}))).toBe(true);
  });
  it("never preselects within retention, without a guard, alive, kept, undocumented or user content", () => {
    expect(isPreselected(unit({ metrics: { ...unit({}).metrics, ageDays: 20 } }))).toBe(false);
    expect(isPreselected(unit({ liveGuard: null }))).toBe(false);
    expect(isPreselected(unit({ liveGuard: { kind: "pid", alive: true } }))).toBe(false);
    expect(isPreselected(unit({ rule: "kept" }))).toBe(false);
    expect(isPreselected(unit({ rule: "undocumented" }))).toBe(false);
    expect(isPreselected(unit({ userContent: true }))).toBe(false);
    expect(
      isPreselected(
        unit({ retention: { days: null, bytes: null, count: 5, source: "claude-directory" } }),
      ),
    ).toBe(false);
  });
});
