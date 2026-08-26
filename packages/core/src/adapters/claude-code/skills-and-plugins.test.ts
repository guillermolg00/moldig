import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit, scan } from "../../index.js";
import type { AuditIndex, Entity, LoadedByEdge, Plugin, Skill } from "../../index/types.js";
import { loadFixture, normaliseSnapshot, type FixtureTree } from "../../testing/index.js";

/** After the case's synthetic timestamps (2023-11-14); its `ages` are relative to it. */
const NOW = new Date("2026-08-26T12:00:00.000Z");
/** The PID the fixture's `.in_use` marker names (`cache/marketplace-a/plugin-a/1.0.0/.in_use/12345`). */
const LIVE_PID = 12_345;
const ISO_ANYWHERE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const DATE_ANYWHERE = /(?<![\dT:-])\d{4}-\d{2}-\d{2}(?![\dT])/g;
const THREE_DAYS_MS = 3 * 86_400_000;
const PLATFORM = "darwin";

let tree: FixtureTree;
let result: AuditIndex;

const id = (kind: string, path: string): string => {
  const hash = path.indexOf("#");
  const file = hash === -1 ? path : path.slice(0, hash);
  const keyPath = hash === -1 ? "" : path.slice(hash);
  return `${kind}:${file.toLowerCase()}${keyPath}`;
};
const home = (rel: string): string => `${tree.home}/${rel}`;
const root = (rel: string): string => `${tree.root}/${rel}`;
const cache = (rel: string): string => home(`.claude/plugins/cache/marketplace-a/${rel}`);

function entity(kind: string, path: string): Entity {
  const found = result.entities.find((item) => item.id === id(kind, path));
  if (found === undefined) throw new Error(`entity not found: ${id(kind, path)}`);
  return found;
}

function skill(path: string): Skill {
  const found = entity("skill", path);
  if (found.kind !== "skill") throw new Error("kind");
  return found;
}

function plugin(path: string): Plugin {
  const found = entity("plugin", path);
  if (found.kind !== "plugin") throw new Error("kind");
  return found;
}

function loadedBy(kind: string, path: string): LoadedByEdge | undefined {
  const from = id(kind, path);
  const edge = result.edges.find((item) => item.kind === "loaded-by" && item.from === from);
  return edge?.kind === "loaded-by" ? edge : undefined;
}

/** Copy-time stamps (files the case does not age) differ per run; stamps on `NOW`'s day grid stay. */
function stableTimes(json: string): string {
  const now = Date.now();
  return json
    .replaceAll(ISO_ANYWHERE, (stamp) => {
      const ms = Date.parse(stamp);
      const onGrid = (NOW.getTime() - ms) % 86_400_000 === 0;
      return !onGrid && Math.abs(ms - now) < THREE_DAYS_MS ? "<COPY-TIME>" : stamp;
    })
    .replaceAll(DATE_ANYWHERE, (date) =>
      Math.abs(Date.parse(`${date}T00:00:00.000Z`) - now) < THREE_DAYS_MS ? "<COPY-DATE>" : date,
    );
}

/** JSON in the shape the repo's formatter keeps (`oxfmt --check` runs over `__snapshots__`). */
function formattedJson(value: unknown, indent = "", prefix = 0): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = indent + "  ";
    const primitives = value.every((item) => typeof item !== "object" || item === null);
    if (primitives) {
      const line = `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
      if (prefix + indent.length + line.length <= 100) return line;
    }
    return `[\n${value.map((item) => inner + formattedJson(item, inner)).join(",\n")}\n${indent}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    if (entries.length === 0) return "{}";
    const inner = indent + "  ";
    const lines = entries.map(([key, item]) => {
      const head = `${JSON.stringify(key)}: `;
      return `${inner}${head}${formattedJson(item, inner, head.length)}`;
    });
    return `{\n${lines.join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

beforeAll(async () => {
  tree = await loadFixture("claude-code/skills-and-plugins", {
    cwd: "root/project-b",
    now: NOW,
    platform: PLATFORM,
  });
  // D50: the live guard is injected, so the `.in_use` marker means the same thing on every machine.
  result = await audit(
    await scan({
      home: tree.home,
      roots: tree.roots,
      cwd: tree.cwd,
      platform: PLATFORM,
      env: tree.env,
      git: false,
      now: NOW,
      isProcessAlive: (pid) => pid === LIVE_PID,
    }),
  );
});

afterAll(async () => {
  await tree.cleanup();
});

describe("claude-code adapter over the skills-and-plugins case", () => {
  it("keeps one Skill per real directory and lists every link that reaches it", () => {
    const user = skill(home(".claude/skills/skill-user"));
    expect(user.layout).toBe("copy");
    expect(user.origin).toBeNull();
    expect(user.metrics.files).toBe(2);
    expect(user.placements).toHaveLength(1);

    // The store directory is the identity; the Claude link is a placement of it (ADR-0007).
    const stored = skill(home(".agents/skills/skill-a"));
    expect(stored.harness).toBeNull();
    expect(stored.layout).toBe("canonical");
    expect(stored.placements.map((item) => [item.path, item.harness, item.isSymlink])).toEqual([
      [home(".agents/skills/skill-a"), null, false],
      [home(".claude/skills/skill-a"), "claude-code", true],
    ]);
    expect(stored.placements[1]?.linkTarget).toBe("../../.agents/skills/skill-a");
    expect(stored.frontmatter).toMatchObject({ "allowed-tools": "<redacted>", hidden: true });
  });

  it("fills the origin of a locked skill and points an originates-from edge at the lock entry", () => {
    const stored = skill(home(".agents/skills/skill-a"));
    expect(stored.origin).toEqual({
      installer: "vercel-skills",
      sourceType: "github",
      source: "<redacted>",
      sourceUrl: "<redacted>",
      ref: null,
      skillPath: "<redacted>",
      // `<redacted-hash>` is neither 40- nor 64-hex: moldig cannot say which algorithm it is.
      recordedHash: { algo: "unknown", value: "<redacted-hash>" },
      installedAt: "2023-11-14T22:13:20.000Z",
      updatedAt: "2023-11-14T22:13:20.000Z",
      lock: {
        type: "entry",
        file: home(".agents/.skill-lock.json"),
        format: "json",
        keyPath: ["skills", "skill-a"],
      },
    });
    expect(stored.drift).toBe("unknown");
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "originates-from" &&
          edge.from === stored.id &&
          edge.to === id("settings-file", home(".agents/.skill-lock.json")),
      ),
    ).toBe(true);
    const lock = entity("settings-file", home(".agents/.skill-lock.json"));
    if (lock.kind !== "settings-file") throw new Error("kind");
    expect(lock.role).toBe("skill-lock");
    expect(lock.entries).toBe(3);
    // A lock several harnesses share belongs to none of them.
    expect(lock.harness).toBeNull();
  });

  it("keeps a dangling link as a Skill with no verdict and files it as an orphan", () => {
    const dangling = skill(home(".claude/skills/skill-dangling"));
    expect(dangling.placements.every((placement) => placement.dangling)).toBe(true);
    expect(dangling.metrics.bytes).toBe(0);
    expect(dangling.contentHash).toEqual([]);
    expect(dangling.origin?.installer).toBe("vercel-skills");
    expect(loadedBy("skill", home(".claude/skills/skill-dangling"))).toBeUndefined();
    const finding = result.findings.find((item) => item.id === `finding:orphan:${dangling.id}`);
    expect(finding?.category).toBe("orphan");
    expect(finding?.evidence[0]?.detail).toBe("../../.agents/skills/skill-dangling");
  });

  it("reads a skills-dir plugin as a Plugin whose SKILL.md is its single skill", () => {
    const dirPlugin = plugin(home(".claude/skills/skill-plugin"));
    expect(dirPlugin.pluginId).toBe("skill-plugin@skills-dir");
    expect(dirPlugin.marketplace).toBeNull();
    expect(dirPlugin.origin).toBeNull();
    expect(dirPlugin.installs).toEqual([{ scope: "user", project: null, enabled: null }]);
    const provided = skill(home(".claude/skills/skill-plugin"));
    expect(provided.layout).toBe("plugin");
    expect(provided.sidecars).toEqual([".claude-plugin/plugin.json"]);
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "provided-by" && edge.from === provided.id && edge.to === dirPlugin.id,
      ),
    ).toBe(true);
  });

  it("emits one Plugin per install directory with its registry origin, hooks and delegate", () => {
    const pluginA = plugin(cache("plugin-a/1.0.0"));
    expect(pluginA.pluginId).toBe("plugin-a@marketplace-a");
    expect(pluginA.version).toBe("1.0.0");
    expect(pluginA.marketplace).toBe("marketplace-a");
    expect(pluginA.installs).toEqual([{ scope: "user", project: null, enabled: null }]);
    expect(pluginA.origin).toMatchObject({
      installer: "claude-plugin",
      sourceType: "marketplace",
      source: "./plugins/plugin-a",
      ref: "<redacted-hash>",
      updatedAt: "2023-11-14T22:13:20.000Z",
      lock: {
        type: "entry",
        file: home(".claude/plugins/installed_plugins.json"),
        format: "json",
        keyPath: ["plugins", "plugin-a@marketplace-a", "0"],
      },
    });
    expect(pluginA.hooks).toEqual([
      {
        event: "SessionStart",
        type: "command",
        command: "${CLAUDE_PLUGIN_ROOT}/scripts/start.sh",
        matcher: null,
      },
    ]);
    expect(pluginA.removal).toEqual({
      method: "delegate",
      command: "claude plugin uninstall plugin-a@marketplace-a",
    });
    // The `.in_use/12345` marker names a live PID on this run: the install directory is live.
    expect(pluginA.protection).toBe("live");
    expect(loadedBy("plugin", cache("plugin-a/1.0.0"))).toMatchObject({
      mode: "full",
      countsTowardHeadline: false,
    });
  });

  it("gives every item a plugin ships a provided-by edge and no removal of its own", () => {
    const pluginA = plugin(cache("plugin-a/1.0.0"));
    const items = [
      skill(cache("plugin-a/1.0.0/skills/skill-p")).id,
      skill(cache("plugin-a/1.0.0/commands/cmd-p.md")).id,
      entity("agent-definition", cache("plugin-a/1.0.0/agents/agent-p.md")).id,
      entity("mcp-server", `${cache("plugin-a/1.0.0/.mcp.json")}#mcpServers/server-plugin`).id,
    ];
    for (const item of items) {
      expect(
        result.edges.some(
          (edge) => edge.kind === "provided-by" && edge.from === item && edge.to === pluginA.id,
        ),
      ).toBe(true);
      const found = result.entities.find((candidate) => candidate.id === item);
      expect(found?.removal).toEqual({ method: "none" });
    }
    expect(loadedBy("skill", cache("plugin-a/1.0.0/skills/skill-p"))?.effectiveName).toBe(
      "/plugin-a:skill-p",
    );
    expect(loadedBy("skill", cache("plugin-a/1.0.0/commands/cmd-p.md"))?.effectiveName).toBe(
      "/plugin-a:cmd-p",
    );
    expect(
      loadedBy("agent-definition", cache("plugin-a/1.0.0/agents/agent-p.md"))?.effectiveName,
    ).toBe("plugin-a:agent-p");
    expect(
      loadedBy("mcp-server", `${cache("plugin-a/1.0.0/.mcp.json")}#mcpServers/server-plugin`)
        ?.effectiveName,
    ).toBe("plugin:plugin-a:server-plugin");
    // Edge case 6: the same skill name in the marketplace source tree and in two cache versions.
    expect(
      result.entities.filter((item) => item.kind === "skill" && item.label === "skill-p"),
    ).toHaveLength(1);
    // The plugin's own CLAUDE.md is injected by a hook, not by the hierarchy: not a context file.
    expect(
      result.entities.some(
        (item) => item.kind === "context-file" && item.path.includes("/plugins/cache/"),
      ),
    ).toBe(false);
  });

  it("keeps a registry entry whose install directory is gone as an orphan Plugin", () => {
    const pluginB = plugin(cache("plugin-b/2.0.0"));
    expect(pluginB.metrics).toMatchObject({ bytes: 0, files: 0 });
    expect(pluginB.installs).toEqual([
      { scope: "project", project: id("project", root("project-b")), enabled: true },
    ]);
    // A project-scope plugin loads only after the workspace-trust dialog, and no `.claude.json`
    // records the answer here.
    expect(loadedBy("plugin", cache("plugin-b/2.0.0"))?.mode).toBe("unknown");
    const finding = result.findings.find((item) => item.id === `finding:orphan:${pluginB.id}`);
    expect(finding?.action).toMatchObject({ kind: "delete", preselect: false });
    expect(finding?.message).toContain("install directory is gone");
  });

  it("files the plugin cache, the clones and their node_modules as harness cache units", () => {
    const version = entity("harness-cache", cache("plugin-a/0.9.0"));
    if (version.kind !== "harness-cache") throw new Error("kind");
    expect(version.cacheKind).toBe("plugin-cache-version");
    expect(version.unit).toBe("version");
    expect(version.rule).toBe("undocumented");
    // A unit's age is its **newest** member (ticket 07): the case ages this version's manifest to
    // 60 days and leaves its `skills/` at copy time, so the oldest member carries the 60 days.
    expect(version.members.oldest).toBe(new Date(NOW.getTime() - 60 * 86_400_000).toISOString());
    expect(version.metrics.ageDays).toBe(0);
    expect(version.liveGuard).toEqual({ kind: "in-use-marker", alive: false });
    expect(version.removal).toEqual({ method: "trash" });
    // `undocumented` is tickable but never preselected (ticket 08).
    const group = result.findings.find(
      (item) => item.id === "finding:harness-cache:harness:claude-code:plugin-cache-version",
    );
    expect(group?.targets.map((target) => [target.id, target.preselect])).toEqual([
      [version.id, false],
    ]);
    // `skills/skill-p` inside an unreferenced version is never walked.
    expect(
      result.entities.some((item) => item.path === cache("plugin-a/0.9.0/skills/skill-p")),
    ).toBe(false);

    const clone = entity("harness-cache", home(".claude/plugins/marketplaces/marketplace-a"));
    if (clone.kind !== "harness-cache") throw new Error("kind");
    expect(clone.cacheKind).toBe("marketplace-clone");
    expect(clone.unit).toBe("clone");
    expect(clone.rule).toBe("kept");
    expect(clone.protection).toBe("never");
    expect(clone.removal).toEqual({ method: "none" });

    // D51: `node_modules` is a prune marker for the walk and a unit of its own, so the clone
    // above it never counts those bytes twice.
    const modules = entity(
      "harness-cache",
      home(".claude/plugins/marketplaces/marketplace-a/node_modules"),
    );
    if (modules.kind !== "harness-cache") throw new Error("kind");
    expect(modules.rule).toBe("undocumented");
    expect(modules.metrics.bytes).toBeGreaterThan(0);
    expect(clone.metrics.bytes + modules.metrics.bytes).toBeGreaterThan(clone.metrics.bytes);

    const backup = entity("harness-cache", home(".claude/plugins/marketplaces/marketplace-a.bak"));
    if (backup.kind !== "harness-cache") throw new Error("kind");
    expect(backup.cacheKind).toBe("marketplace-backup");
    expect(backup.metrics.ageDays).toBe(90);
    expect(backup.liveGuard).toBeNull();
  });

  it("files the registry rows that name something gone", () => {
    const marketplace = result.findings.find(
      (item) => item.id === "finding:orphan:marketplace:marketplace-gone",
    );
    expect(marketplace?.targets[0]?.locator).toEqual({
      type: "entry",
      file: home(".claude/plugins/known_marketplaces.json"),
      format: "json",
      keyPath: ["marketplace-gone"],
    });
    // The store copy `skill-orphan` no agent directory links, and the lock row whose directory
    // never existed: both locator-only targets (ticket 07 allows them).
    const orphanStore = result.findings.find((item) => item.id.endsWith(":skill-orphan"));
    expect(orphanStore?.message).toContain("no agent directory links");
    const missing = result.findings.find((item) => item.id.endsWith(":skill-missing"));
    expect(missing?.targets[0]?.locator).toEqual({
      type: "entry",
      file: root("project-b/skills-lock.json"),
      format: "json",
      keyPath: ["skills", "skill-missing"],
    });
    // The plugin state files are never removed.
    for (const name of ["installed_plugins.json", "known_marketplaces.json", "config.json"]) {
      const state = entity("settings-file", home(`.claude/plugins/${name}`));
      expect(state.protection).toBe("never");
      expect(state.removal).toEqual({ method: "none" });
    }
  });

  it("reads the project's own store, its committed lock and its plugin enablement", () => {
    const project = result.projects.find((item) => item.id === id("project", root("project-b")));
    expect(project?.kind).toBe("repository");
    expect(project?.discoveredBy).toContain("marker-walk");
    expect(project?.perHarness["claude-code"]?.effectiveSettings["enabledPlugins"]).toEqual({
      "plugin-b@marketplace-a": true,
    });
    // D49: `installed_plugins.json[].projectPath` is evidence of a Project, like a `projects` key.
    const row = result.breadcrumbs.find((crumb) => crumb.kind === "project-row");
    expect(row).toMatchObject({
      raw: root("project-b"),
      resolution: "direct",
      project: id("project", root("project-b")),
    });
    expect(row?.state).toEqual([id("plugin", cache("plugin-b/2.0.0"))]);

    // A real copy the project's lock records, and a link into the project's own store.
    const copied = skill(root("project-b/.claude/skills/skill-b"));
    expect(copied.layout).toBe("synced");
    expect(copied.origin).toMatchObject({
      installer: "vercel-skills",
      sourceType: "github",
      installedAt: null,
      updatedAt: null,
      recordedHash: { algo: "unknown", value: "<redacted-hash>" },
    });
    const linked = skill(root("project-b/.agents/skills/skill-c"));
    expect(linked.harness).toBeNull();
    expect(linked.placements.map((item) => item.path)).toEqual([
      root("project-b/.agents/skills/skill-c"),
      root("project-b/.claude/skills/skill-c"),
    ]);
    expect(linked.placements[1]?.linkTarget).toBe("../../.agents/skills/skill-c");
    const lock = entity("settings-file", root("project-b/skills-lock.json"));
    if (lock.kind !== "settings-file") throw new Error("kind");
    expect(lock.role).toBe("skill-lock");
    expect(lock.entries).toBe(3);
    expect(lock.scope).toBe("project");
  });

  it("never turns a plugin payload into a Project", () => {
    expect(result.projects.every((item) => !item.path.includes("/.claude/plugins/"))).toBe(true);
    expect(result.projects.map((item) => item.id)).toEqual([id("project", root("project-b"))]);
  });

  it("takes the PID liveness from the injected seam", async () => {
    const dead = await scan({
      home: tree.home,
      roots: tree.roots,
      cwd: tree.cwd,
      platform: PLATFORM,
      env: tree.env,
      git: false,
      now: NOW,
      isProcessAlive: () => false,
    });
    const pluginA = dead.entities.find((item) => item.id === id("plugin", cache("plugin-a/1.0.0")));
    expect(pluginA?.protection).toBe("none");
  });

  it("matches the audit snapshot", async () => {
    const stable = normaliseSnapshot(result, tree);
    stable.scan.durationMs = 0;
    await expect(stableTimes(formattedJson(stable) + "\n")).toMatchFileSnapshot(
      "./__snapshots__/skills-and-plugins.audit.json",
    );
  });
});
