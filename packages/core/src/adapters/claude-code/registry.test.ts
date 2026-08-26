/**
 * The pure pieces of the Claude Code adapter no fixture can carry: the documented legacy shape of
 * `installed_plugins.json` (research 01 Open 4), the usage counters of `~/.claude.json` (D52 — the
 * captured fixture redacts their keys) and the shared redaction rule (D64).
 */
import { describe, expect, it } from "vitest";
import { layoutOf } from "./locks.js";
import { parseRegistry } from "./plugins.js";
import { lastUsedOf, redactString } from "./state.js";

describe("installed_plugins.json", () => {
  it("reads the v2 shape, one entry per scope row", () => {
    const registry = parseRegistry("/r.json", {
      version: 2,
      plugins: {
        "a@m": [
          { scope: "user", installPath: "/cache/a/1.0.0", version: "1.0.0" },
          { scope: "project", projectPath: "/p", installPath: "/cache/a/1.0.0" },
        ],
      },
    });
    expect(registry.pluginIds).toEqual(["a@m"]);
    expect(registry.entries.map((entry) => [entry.scope, entry.index, entry.marketplace])).toEqual([
      ["user", 0, "m"],
      ["project", 1, "m"],
    ]);
    expect(registry.entries[1]?.projectPath).toBe("/p");
    expect(registry.unknownShape).toBe(false);
  });

  it("accepts the documented older per-scope shape", () => {
    const registry = parseRegistry("/r.json", {
      user: { "a@m": { installPath: "/cache/a/1.0.0", version: "1.0.0" } },
      project: { "b@m": { installPath: "/cache/b/2.0.0", projectPath: "/p" } },
    });
    expect(registry.unknownShape).toBe(false);
    expect(registry.pluginIds.toSorted()).toEqual(["a@m", "b@m"]);
    expect(registry.entries.map((entry) => entry.scope)).toEqual(["user", "project"]);
  });

  it("flags a shape it recognises as neither", () => {
    expect(parseRegistry("/r.json", { version: 9, items: [] }).unknownShape).toBe(true);
    expect(parseRegistry("/r.json", []).parseError).toBe(true);
  });

  it("drops a row without an install path: there is nothing to identify", () => {
    const registry = parseRegistry("/r.json", { plugins: { "a@m": [{ scope: "user" }] } });
    expect(registry.pluginIds).toEqual(["a@m"]);
    expect(registry.entries).toEqual([]);
  });
});

describe("usage counters", () => {
  it("takes epoch milliseconds, an ISO string, or the newest number beside a count", () => {
    expect(lastUsedOf({ "skill-a": 1_700_000_000_000 }, "skill-a")).toBe(
      "2023-11-14T22:13:20.000Z",
    );
    expect(lastUsedOf({ "skill-a": "2023-11-14T22:13:20.000Z" }, "skill-a")).toBe(
      "2023-11-14T22:13:20.000Z",
    );
    expect(lastUsedOf({ "skill-a": { count: 13, lastUsed: 1_700_000_000_000 } }, "skill-a")).toBe(
      "2023-11-14T22:13:20.000Z",
    );
  });

  it("leaves an unrecognised shape null", () => {
    expect(lastUsedOf({ "skill-a": { count: 13 } }, "skill-a")).toBeNull();
    expect(lastUsedOf({ "skill-a": true }, "skill-a")).toBeNull();
    expect(lastUsedOf(null, "skill-a")).toBeNull();
    expect(lastUsedOf({}, "missing")).toBeNull();
  });
});

describe("the shared redaction rule", () => {
  it("redacts a secret-looking key and a bare token, and keeps everything else", () => {
    expect(redactString("sk-live-value", "apiKey")).toBe("<redacted>");
    expect(redactString("plain", "authToken")).toBe("<redacted>");
    expect(redactString("aaaaaaaaaaaaaaaaaaaaaaaaaaaa", null)).toBe("<redacted>");
    expect(redactString("short-value", null)).toBe("short-value");
    // A command is a string with spaces, so only its secret-looking pieces could ever match.
    expect(redactString("bash -lc 'echo hi'", null)).toBe("bash -lc 'echo hi'");
    expect(redactString("acceptEdits", "defaultMode")).toBe("acceptEdits");
  });
});

describe("skill layout (D43)", () => {
  it("names the store canonical, a plugin root plugin, a locked copy synced, the rest copy", () => {
    const base = { realPath: "/x", inStore: false, inPlugin: false, lockRecorded: false };
    expect(layoutOf({ ...base, inStore: true })).toBe("canonical");
    expect(layoutOf({ ...base, inPlugin: true })).toBe("plugin");
    expect(layoutOf({ ...base, lockRecorded: true })).toBe("synced");
    expect(layoutOf(base)).toBe("copy");
  });
});
