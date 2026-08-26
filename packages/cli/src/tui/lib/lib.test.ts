/**
 * The pure parts of the TUI: OSC 8 detection and URLs, the editor hand-off order, the selection
 * predicates and dispositions, and the shareable summary. No terminal, no React.
 */
import type { HarnessCache, McpServer, Origin, Plugin, Skill } from "@moldig/core";
import { describe, expect, it } from "vitest";
import { formatAge, formatBytes, formatMb, formatTokens, shortPath, truncate } from "./format.js";
import { clickHint, fileUrl, osc8, supportsHyperlinks } from "./hyperlink.js";
import { resolveOpener } from "./open.js";
import { backupDirFor, dataDirFor, manifestPathFor, runIdFor } from "@moldig/core";
import {
  allowed,
  badgesOf,
  canDelete,
  canUpdate,
  dispositionOf,
  installerCommand,
  isPermanentCommand,
  isTickable,
  updateDisposition,
} from "./selection.js";

// ---------- fixtures made by hand: index v0 shapes, no filesystem

const base = {
  harness: "claude-code" as const,
  producer: null,
  project: null,
  scope: "user" as const,
  ownership: "harness" as const,
  shared: null,
  gitStatus: null,
  relativePath: null,
  format: "other" as const,
  sensitive: false,
  metrics: {
    bytes: 100,
    files: 1,
    lines: 1,
    mtime: null,
    ageDays: 45,
    tokens: null,
    lastUsed: null,
  },
};

function cacheUnit(overrides: Partial<HarnessCache> = {}): HarnessCache {
  return {
    ...base,
    id: "harness-cache:/x",
    kind: "harness-cache",
    path: "/x",
    locator: { type: "file", path: "/x" },
    label: "x",
    protection: "none",
    removal: { method: "trash" },
    cacheKind: "transcript",
    unit: "session",
    surface: null,
    session: null,
    slug: null,
    rule: "swept",
    retention: { days: 20, bytes: null, count: null, source: null },
    liveGuard: null,
    userContent: false,
    members: { files: 1, bytes: 100, oldest: null, newest: null },
    ...overrides,
  };
}

/** What the Runner answers for a path on a share: D89's reason, verbatim. */
const onNetwork = (): string => "network volume — no trash available";

describe("dispositions", () => {
  it("names the method ticket 08 §4 fixes", () => {
    expect(dispositionOf(cacheUnit()).text).toBe("→ Trash");
    expect(dispositionOf(cacheUnit({ removal: { method: "backup-edit" } })).text).toBe(
      "→ backup + edit",
    );
    expect(dispositionOf(cacheUnit({ removal: { method: "none" } })).text).toBe("no action");
  });

  it("marks the commands no harness can undo as permanent", () => {
    const permanent = cacheUnit({
      removal: { method: "delegate", command: "opencode session delete abc" },
    });
    expect(dispositionOf(permanent).text).toBe("→ opencode session delete abc (permanent)");
    expect(dispositionOf(permanent).permanent).toBe(true);
    expect(badgesOf(permanent)).toContain("permanent");
    const recoverable = cacheUnit({
      removal: { method: "delegate", command: "claude plugin uninstall a@b" },
    });
    expect(dispositionOf(recoverable).text).toBe("→ claude plugin uninstall a@b");
    // D60: `codex mcp remove` is preceded by a backup of `config.toml`, so it is recoverable.
    expect(isPermanentCommand("codex mcp remove x")).toBe(false);
    expect(isPermanentCommand("claude mcp remove x")).toBe(false);
  });

  it("shows the engine's refusal instead of a trash it cannot offer", () => {
    const unit = cacheUnit();
    const disposition = dispositionOf(unit, onNetwork);
    expect(disposition.kind).toBe("refused");
    expect(disposition.text).toBe("refused: network volume");
    expect(disposition.reason).toBe("network volume — no trash available");
    expect(isTickable(unit, onNetwork)).toBe(false);
    expect(canDelete(unit, onNetwork)).toBe(false);
  });
});

describe("the tickable rule", () => {
  it("takes swept and undocumented harness cache, and no live row", () => {
    expect(isTickable(cacheUnit())).toBe(true);
    expect(isTickable(cacheUnit({ rule: "undocumented" }))).toBe(true);
    expect(isTickable(cacheUnit({ rule: "kept" }))).toBe(false);
    expect(isTickable(cacheUnit({ liveGuard: { kind: "pid", alive: true } }))).toBe(false);
    expect(isTickable(cacheUnit({ protection: "undocumented" }))).toBe(false);
    expect(isTickable(cacheUnit({ ownership: "human" }))).toBe(false);
  });

  it("reaches kept units and human-owned items through Delete only", () => {
    const kept = cacheUnit({ rule: "kept" });
    expect(isTickable(kept)).toBe(false);
    expect(canDelete(kept)).toBe(true);
    expect(allowed(kept, "delete")).toBe(true);
    expect(allowed(kept, "clean")).toBe(false);
    expect(allowed(kept, "open")).toBe(true);
    // A settings file is never deletable: its entries are, the file is not (D142).
    const settings = cacheUnit({ protection: "never", removal: { method: "none" } });
    expect(canDelete(settings)).toBe(false);
  });

  it("badges a live, user-content, kept unit in the fixed order", () => {
    const unit = cacheUnit({
      rule: "kept",
      userContent: true,
      liveGuard: { kind: "pid", alive: true },
      sensitive: true,
    });
    expect(badgesOf(unit)).toEqual(["live", "user content", "kept", "sensitive"]);
  });
});

function origin(installer: Origin["installer"]): Origin {
  return {
    installer,
    sourceType: "github",
    source: "a/b",
    sourceUrl: null,
    ref: null,
    skillPath: null,
    recordedHash: null,
    installedAt: null,
    updatedAt: null,
    lock: { type: "file", path: "/lock" },
  };
}

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    ...base,
    id: "skill:/s",
    kind: "skill",
    path: "/s",
    locator: { type: "dir", path: "/s" },
    label: "agent-browser",
    protection: "none",
    removal: { method: "trash" },
    ownership: "human",
    form: "skill-dir",
    name: "agent-browser",
    dirName: "agent-browser",
    frontmatterName: null,
    layout: "canonical",
    placements: [],
    frontmatter: {},
    sidecars: [],
    contentHash: [],
    origin: null,
    drift: "unknown",
    ...overrides,
  };
}

describe("update", () => {
  it("takes the scope flag from the skill's own scope (14 §2)", () => {
    expect(installerCommand(skill({ origin: origin("vercel-skills") }))).toBe(
      "npx skills update agent-browser -g",
    );
    expect(installerCommand(skill({ origin: origin("vercel-skills"), scope: "project" }))).toBe(
      "npx skills update agent-browser -p",
    );
  });

  it("backs a locally modified copy up first", () => {
    const modified = skill({ origin: origin("vercel-skills"), drift: "local-modified" });
    expect(updateDisposition(modified)?.text).toBe("→ backup + npx skills update agent-browser -g");
  });

  it("offers nothing when no installer recorded an origin", () => {
    expect(canUpdate(skill())).toBe(false);
    expect(canUpdate(skill({ origin: origin("codex-plugin") }))).toBe(false);
    expect(updateDisposition(skill())).toBeNull();
  });

  it("delegates a plugin to its own installer", () => {
    const plugin: Plugin = {
      ...base,
      id: "plugin:/p",
      kind: "plugin",
      path: "/p",
      locator: { type: "dir", path: "/p" },
      label: "p",
      protection: "none",
      removal: { method: "trash" },
      pluginId: "pack@market",
      version: "1.0.0",
      marketplace: "market",
      installs: [],
      origin: origin("claude-plugin"),
      hooks: [],
    };
    expect(installerCommand(plugin)).toBe("claude plugin update pack@market");
  });
});

describe("badges from the entity itself", () => {
  it("flags an invalid entry and a secret-carrying MCP server", () => {
    const server: McpServer = {
      ...base,
      id: "mcp-server:/m",
      kind: "mcp-server",
      path: "/m",
      locator: { type: "file", path: "/m" },
      label: "server",
      protection: "none",
      removal: { method: "backup-edit" },
      ownership: "human",
      name: "server",
      transport: "http",
      command: null,
      args: [],
      url: null,
      envKeys: [],
      headerKeys: [],
      secretKeys: ["TOKEN"],
      hasOauth: false,
      usesInterpolation: false,
      enabled: null,
      approval: "unknown",
      invalid: "url without type",
      endpointKey: "k",
      rawKeys: [],
    };
    expect(badgesOf(server)).toEqual(["invalid", "secret"]);
  });
});

describe("OSC 8 hyperlinks", () => {
  it("follows the detection order research 03 fixed", () => {
    expect(supportsHyperlinks({ FORCE_HYPERLINK: "1" }, false)).toBe(true);
    expect(supportsHyperlinks({ FORCE_HYPERLINK: "0", TERM_PROGRAM: "iTerm.app" }, true)).toBe(
      false,
    );
    expect(supportsHyperlinks({}, false)).toBe(false);
    // Terminal.app never gets links, whatever else is set.
    expect(supportsHyperlinks({ TERM_PROGRAM: "Apple_Terminal", TMUX: "1" }, true)).toBe(false);
    for (const program of ["iTerm.app", "WezTerm", "vscode", "ghostty", "WarpTerminal", "zed"]) {
      expect(supportsHyperlinks({ TERM_PROGRAM: program }, true)).toBe(true);
    }
    expect(supportsHyperlinks({ TMUX: "/tmp/x" }, true)).toBe(true);
    expect(supportsHyperlinks({ VTE_VERSION: "5202" }, true)).toBe(true);
    expect(supportsHyperlinks({ VTE_VERSION: "4200" }, true)).toBe(false);
    expect(supportsHyperlinks({ TERM: "xterm-kitty" }, true)).toBe(true);
    expect(supportsHyperlinks({ WT_SESSION: "abc" }, true)).toBe(true);
    expect(supportsHyperlinks({ TERM: "dumb" }, true)).toBe(false);
  });

  it("names the modifier the platform uses (D131)", () => {
    expect(clickHint("darwin")).toBe("cmd+click");
    expect(clickHint("linux")).toBe("ctrl+click");
    expect(clickHint("win32")).toBe("ctrl+click");
  });

  it("builds a file URL with the hostname, and the /C:/ form on win32", () => {
    expect(fileUrl("/home/g/a b.md", "linux", "box")).toBe("file://box/home/g/a%20b.md");
    expect(fileUrl("C:\\Users\\g\\a.md", "win32", "box")).toBe("file://box/C:/Users/g/a.md");
    expect(osc8("label", "file://box/x")).toBe(
      "\u001B]8;;file://box/x\u001B\\label\u001B]8;;\u001B\\",
    );
  });
});

describe("the editor hand-off", () => {
  it("prefers cursor, then the VS Code terminal, then $VISUAL, then $EDITOR", () => {
    expect(resolveOpener({ CURSOR_TRACE_ID: "x" }, "darwin", "/a.md")).toMatchObject({
      command: "cursor",
      args: ["-g", "/a.md:1"],
      terminal: false,
      via: "CURSOR_TRACE_ID",
    });
    expect(resolveOpener({ TERM_PROGRAM: "vscode" }, "darwin", "/a.md")).toMatchObject({
      command: "code",
      via: "TERM_PROGRAM=vscode",
    });
    expect(resolveOpener({ PATH: "", VISUAL: "nvim" }, "darwin", "/a.md")).toMatchObject({
      command: "nvim",
      args: ["/a.md"],
      terminal: true,
      via: "$VISUAL",
    });
    expect(resolveOpener({ PATH: "", EDITOR: "subl -w" }, "darwin", "/a.md")).toMatchObject({
      command: "subl",
      args: ["-w", "/a.md"],
      terminal: false,
      via: "$EDITOR",
    });
    expect(resolveOpener({ PATH: "" }, "darwin", "/a.md")).toBeNull();
  });
});

const RUN_ID = "2026-08-26T11-00-00.000Z";

/** What the CLI hands the engine: the platform, the environment it honoured and the home. */
function dataDir(platform: "darwin" | "linux" | "win32", env: Record<string, string>): string {
  return dataDirFor({ platform, env, home: platform === "win32" ? "C:\\Users\\g" : "/home/g" });
}

describe("the data directory (08 Q2)", () => {
  it("follows XDG on POSIX and LOCALAPPDATA on Windows, and never puts a colon in a run id", () => {
    expect(manifestPathFor(dataDir("darwin", {}), RUN_ID, "darwin")).toBe(
      "/home/g/.local/share/moldig/runs/2026-08-26T11-00-00.000Z.json",
    );
    expect(backupDirFor(dataDir("linux", { XDG_DATA_HOME: "/data" }), RUN_ID, "linux")).toBe(
      "/data/moldig/backups/2026-08-26T11-00-00.000Z",
    );
    expect(
      manifestPathFor(dataDir("win32", { LOCALAPPDATA: "C:\\AppData" }), RUN_ID, "win32"),
    ).toBe("C:\\AppData\\moldig\\runs\\2026-08-26T11-00-00.000Z.json");
    expect(runIdFor(new Date("2026-08-26T11:00:00.000Z"))).not.toContain(":");
  });
});

describe("formatting", () => {
  it("keeps every number short enough for a row", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatMb(0)).toBe("0.0 MB");
    expect(formatMb(200 * 1024 * 1024)).toBe("200 MB");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(4200)).toBe("4.2k");
    expect(formatTokens(250_000)).toBe("250k");
    expect(formatAge(null)).toBe("—");
    expect(formatAge(0)).toBe("today");
    expect(formatAge(1)).toBe("1 day");
    expect(formatAge(45)).toBe("45 days");
    expect(formatAge(90)).toBe("3 months");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });

  it("shortens the home directory the way the platform writes it", () => {
    expect(shortPath("/home/g/a", "/home/g", "linux")).toBe("~/a");
    expect(shortPath("/home/g", "/home/g", "linux")).toBe("~");
    expect(shortPath("C:\\Users\\g\\a", "C:\\Users\\g", "win32")).toBe("~\\a");
    expect(shortPath("/other/a", "/home/g", "linux")).toBe("/other/a");
  });
});
