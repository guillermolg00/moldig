/**
 * The Gemini CLI adapter over both committed cases. `from-docs` is the complete documented layout
 * (breadcrumbs, slugs, context files, memory, skills, plugins, MCP, cache); `zero-breadcrumbs` is
 * the shape research 09 found on a real machine — installed, signed in, never used in a project.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuditIndex, Breadcrumb, Entity, LoadedByEdge } from "../../index/types.js";
import {
  loadFixture,
  normaliseSnapshot,
  treePaths,
  type FixtureTree,
  fixtureCopyTime,
  POSIX_FIXTURE_HOST,
} from "../../testing/index.js";
import { geminiFindings } from "./findings.js";

/** Every path handed to `readFile`, so the credential stores can be proved unopened (D65). */
const opened = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    readFile: (path: Parameters<typeof actual.readFile>[0], ...rest: unknown[]) => {
      if (typeof path === "string") opened.paths.push(path);
      else if (path instanceof URL) opened.paths.push(path.pathname);
      else if (path instanceof Buffer) opened.paths.push(path.toString("utf8"));
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pass-through wrapper
      return (actual.readFile as (...args: unknown[]) => unknown)(path, ...rest);
    },
  };
});

const { audit, scan } = await import("../../index.js");

/** After the fixture's synthetic dates; `ages` in `fixture.json` are relative to it. */
const NOW = new Date("2026-08-26T12:00:00.000Z");
const PLATFORM = "darwin";
const ISO_ANYWHERE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const DATE_ANYWHERE = /(?<![\dT:-])\d{4}-\d{2}-\d{2}(?![\dT])/g;

/** The paths moldig must never open: credential stores and token caches (D65). */
const SECRET_PATH = /mcp|auth|oauth|cred|secret|token|\.key$|\.env|google_accounts/;

function stableTimes(json: string): string {
  const copy = fixtureCopyTime(NOW).toISOString();
  const copyDate = copy.slice(0, 10);
  return json
    .replaceAll(ISO_ANYWHERE, (stamp) => (stamp === copy ? "<COPY-TIME>" : stamp))
    .replaceAll(DATE_ANYWHERE, (date) => (date === copyDate ? "<COPY-DATE>" : date));
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

interface Case {
  tree: FixtureTree;
  result: AuditIndex;
}

async function runCase(name: string, cwd?: string): Promise<Case> {
  const tree = await loadFixture(name, {
    now: NOW,
    platform: PLATFORM,
    ...(cwd === undefined ? {} : { cwd }),
  });
  // The fixture loader reads every file to rewrite its `<HOME>` / `<ROOT>` tokens; only what the
  // scan itself opens is evidence about the adapter.
  opened.paths.length = 0;
  const index = await scan({
    home: tree.home,
    roots: tree.roots,
    cwd: tree.cwd,
    platform: PLATFORM,
    env: tree.env,
    harnesses: ["gemini-cli"],
    git: false,
    now: NOW,
  });
  return { tree, result: await audit(index) };
}

// ------------------------------------------------------------------- D147

describe("gemini-cli adapter on a machine that never ran it (D147)", () => {
  it("emits nothing at all: no Harness row, no verdicts, no warnings", async () => {
    // `shared/root-tree` has no `home/` tree, so there is no `~/.gemini` to find.
    const { tree, result } = await runCase("shared/root-tree");
    try {
      expect(result.harnesses).toEqual([]);
      expect(result.breadcrumbs).toEqual([]);
      // The shared stores adapter always runs (D21), so the tree's `AGENTS.md` and skills are
      // still indexed; none of it belongs to this harness or carries its verdict.
      expect(result.entities.every((item) => item.harness === null)).toBe(true);
      expect(result.edges.every((edge) => edge.to !== "harness:gemini-cli")).toBe(true);
      expect(result.warnings.filter((item) => item.harness === "gemini-cli")).toEqual([]);
      // An `AGENTS.md` never carries a verdict for a harness no session can start.
      expect(
        result.projects.every((project) => project.perHarness["gemini-cli"] === undefined),
      ).toBe(true);
    } finally {
      await tree.cleanup();
    }
  });
});

// ---------------------------------------------------------------- from-docs

describe.runIf(POSIX_FIXTURE_HOST)("gemini-cli adapter over the from-docs case", () => {
  let tree: FixtureTree;
  let result: AuditIndex;
  const { home, root, slugDir: slug, id } = treePaths(() => tree);

  function entity(kind: string, path: string): Entity {
    const found = result.entities.find((item) => item.id === id(kind, path));
    if (found === undefined) throw new Error(`entity not found: ${id(kind, path)}`);
    return found;
  }

  function loadedBy(kind: string, path: string, project?: string | null): LoadedByEdge {
    const from = id(kind, path);
    const edge = result.edges.find(
      (item) =>
        item.kind === "loaded-by" &&
        item.from === from &&
        (project === undefined || item.project === project),
    );
    if (edge === undefined || edge.kind !== "loaded-by")
      throw new Error(`loaded-by edge not found for ${from}`);
    return edge;
  }

  function crumb(predicate: (crumb: Breadcrumb) => boolean): Breadcrumb {
    const found = result.breadcrumbs.find(predicate);
    if (found === undefined) throw new Error("breadcrumb not found");
    return found;
  }

  beforeAll(async () => {
    opened.paths.length = 0;
    ({ tree, result } = await runCase("gemini-cli/from-docs"));
  });

  afterAll(async () => {
    await tree.cleanup();
  });

  it("describes the harness from what it wrote to disk", () => {
    const harness = result.harnesses[0];
    expect(result.harnesses).toHaveLength(1);
    expect(harness?.id).toBe("harness:gemini-cli");
    expect(harness?.displayName).toBe("Gemini CLI");
    expect(harness?.presence).toBe("installed");
    // Gemini writes no version to disk and no binary is ever run.
    expect(harness?.version).toBeNull();
    expect(harness?.effectiveModel).toBeNull();
    expect(harness?.capabilities).toEqual({
      memoryLocation: "file",
      memoryReadSignal: "unchecked",
      contextFileNames: ["GEMINI.md", "AGENTS.md"],
      sweepDocumented: true,
    });
    expect(harness?.caps.importDepth).toBe(5);
    expect(harness?.breadcrumbSources.map((source) => source.kind)).toEqual([
      "projects-entry",
      "trust-entry",
      "slug-directory",
      "slug-directory",
    ]);
    expect(harness?.userScope.paths.map((item) => item.path)).toEqual([home(".gemini")]);
    // No environment override was set, so none was honoured.
    expect(result.scan.env).toEqual({});
    // The `<redacted>` placeholders survive; a real secret would not.
    expect(harness?.effectiveSettings["mcp"]).toEqual({ allowed: ["server-a"], excluded: [] });
  });

  it("resolves projects.json, trustedFolders.json and the slug directories (edges 1-4)", () => {
    expect(result.projects.map((project) => project.path).toSorted()).toEqual(
      [
        root("gone"),
        root("nested/project-b"),
        root("project-a"),
        root("project-b"),
        root("project-c"),
      ].toSorted(),
    );
    const gone = result.projects.find((project) => project.path === root("gone"));
    expect(gone?.kind).toBe("unknown");
    expect(gone?.reachability).toBe("orphan");
    const kinds = result.breadcrumbs.map((item) => item.kind);
    expect(kinds.filter((kind) => kind === "projects-entry")).toHaveLength(4);
    expect(kinds.filter((kind) => kind === "trust-entry")).toHaveLength(4);
    expect(kinds.filter((kind) => kind === "slug-directory")).toHaveLength(6);
    // Slug collision: only `projects.json` knows the `-1` suffix (edge 3).
    const collided = crumb((item) => item.kind === "slug-directory" && item.raw === "project-b-1");
    expect(collided.resolution).toBe("slug-by-key");
    expect(collided.project).toBe(id("project", root("nested/project-b")));
    expect(
      crumb((item) => item.kind === "slug-directory" && item.raw === "project-b").project,
    ).toBe(id("project", root("project-b")));
    // The shadow git directory resolves through the same registry.
    const history = crumb(
      (item) =>
        item.locator.type === "dir" && item.locator.path === home(".gemini/history/project-a"),
    );
    expect(history.resolution).toBe("slug-by-key");
    // Stray: a 64-hex legacy slug that is the digest of nothing (edge 2).
    const stray = crumb((item) => item.raw.length === 64);
    expect(stray.resolution).toBe("unresolved");
    expect(stray.project).toBeNull();
    expect(stray.strayReason).toBe("unresolved-slug");
    expect(result.harnesses[0]?.userScope.stray).toContain(stray.id);
    expect(stray.state).toEqual([
      id(
        "harness-cache",
        slug(
          "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
          "chats/session-2025-06-01T09-00-00-3d4e5f6a.json",
        ),
      ),
    ]);
    // Trust: TRUST_FOLDER and TRUST_PARENT trust, DO_NOT_TRUST does not (edge 4).
    const projectC = result.projects.find((project) => project.path === root("project-c"));
    expect(projectC?.perHarness["gemini-cli"]?.trusted).toBe(false);
    expect(
      result.projects.find((project) => project.path === root("nested/project-b"))?.perHarness[
        "gemini-cli"
      ]?.trusted,
    ).toBe(true);
  });

  it("honours context.fileName at both tiers and expands @ imports (edges 5, 9)", () => {
    const userFile = entity("context-file", home(".gemini/GEMINI.md"));
    if (userFile.kind !== "context-file") throw new Error("kind");
    // D84: the legacy heading marks the file and files its own finding.
    expect(userFile.containsMemorySection).toBe(true);
    expect(loadedBy("context-file", home(".gemini/GEMINI.md"))).toMatchObject({
      project: null,
      mode: "full",
      order: 0,
      countsTowardHeadline: true,
    });
    const projectA = entity("context-file", root("project-a/GEMINI.md"));
    if (projectA.kind !== "context-file") throw new Error("kind");
    expect(projectA.importCount).toBe(1);
    expect(loadedBy("context-file", root("project-a/GEMINI.md"))).toMatchObject({
      mode: "full",
      importsResolved: 1,
      countsTowardHeadline: true,
    });
    expect(loadedBy("context-file", root("project-a/docs/context-import.md"))).toMatchObject({
      mode: "full",
    });
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "imports" &&
          edge.from === id("context-file", root("project-a/GEMINI.md")) &&
          edge.to === id("context-file", root("project-a/docs/context-import.md")) &&
          edge.hop === 1 &&
          !edge.external,
      ),
    ).toBe(true);
    // Just-in-time: a configured name below the session directory.
    expect(loadedBy("context-file", root("project-a/packages/sub-a/GEMINI.md"))).toMatchObject({
      mode: "on-demand",
      countsTowardHeadline: false,
    });
    // `context.fileName` narrowed to GEMINI.md for project-a: its AGENTS.md is not read…
    expect(loadedBy("context-file", root("project-a/AGENTS.md"))).toMatchObject({
      mode: "never",
      reason: "file not read by the harness: context.fileName = [GEMINI.md]",
    });
    // …while nested/project-b inherits the user list, which names AGENTS.md.
    expect(loadedBy("context-file", root("nested/project-b/AGENTS.md"))).toMatchObject({
      mode: "full",
      countsTowardHeadline: true,
    });
    // An include directory of the user layer with loadMemoryFromIncludeDirectories: false.
    expect(loadedBy("context-file", root("project-b/GEMINI.md"), null)).toMatchObject({
      mode: "never",
      reason: "include directory: loadMemoryFromIncludeDirectories is false",
    });
    expect(
      loadedBy("context-file", root("project-b/GEMINI.md"), id("project", root("project-b"))),
    ).toMatchObject({ mode: "full", countsTowardHeadline: true });
  });

  it("leaves an untrusted folder's settings ignored and its context files unknown (edge 4, D72)", () => {
    const projectC = id("project", root("project-c"));
    expect(loadedBy("context-file", root("project-c/GEMINI.md"))).toMatchObject({
      mode: "unknown",
      reason: "untrusted project: context loading undocumented",
      confidence: "low",
    });
    // The ignored layer never reaches effectiveSettings, but the file is still listed…
    const facts = result.projects.find((project) => project.id === projectC)?.perHarness[
      "gemini-cli"
    ];
    expect(facts?.effectiveSettings["mcpServers"]).toEqual({
      "server-a": expect.anything() as unknown,
    });
    expect(entity("settings-file", root("project-c/.gemini/settings.json")).protection).toBe(
      "never",
    );
    // …and its MCP entry is reported as never loaded.
    expect(
      loadedBy(
        "mcp-server",
        `${root("project-c/.gemini/settings.json")}#mcpServers/server-untrusted`,
      ),
    ).toMatchObject({
      mode: "never",
      reason: "untrusted project: .gemini/settings.json is ignored",
    });
  });

  it("models the memory unit and never turns its draft skills into Skills (edges 6, 11)", () => {
    const index = entity("memory-file", slug("project-a", "memory/MEMORY.md"));
    if (index.kind !== "memory-file") throw new Error("kind");
    expect(index.role).toBe("index");
    expect(index.readSignal).toEqual({ source: "none", exact: false, bashParsed: false });
    expect(index.neverRead).toBeNull();
    expect(loadedBy("memory-file", slug("project-a", "memory/MEMORY.md"))).toMatchObject({
      mode: "full",
      countsTowardHeadline: true,
    });
    const fact = entity("memory-file", slug("project-a", "memory/notes-a.md"));
    if (fact.kind !== "memory-file") throw new Error("kind");
    expect(fact.role).toBe("fact");
    const patch = entity("memory-file", slug("project-a", "memory/.inbox/memory/0001.patch"));
    if (patch.kind !== "memory-file") throw new Error("kind");
    expect(patch.role).toBe("other");
    // Harness-written draft material: a memory file, never an installed Skill.
    const draft = entity("memory-file", slug("project-a", "memory/skills/skill-a/SKILL.md"));
    expect(draft.kind).toBe("memory-file");
    expect(
      result.entities.some(
        (item) => item.kind === "skill" && item.path.includes("/memory/skills/"),
      ),
    ).toBe(false);
    // D119: `MEMORY.md` is the only index name — a legacy `memory/GEMINI.md` is a fact.
    const legacy = entity("memory-file", slug("gone", "memory/GEMINI.md"));
    if (legacy.kind !== "memory-file") throw new Error("kind");
    expect(legacy.role).toBe("fact");
    expect(legacy.project).toBe(id("project", root("gone")));
  });

  it("gives one Skill per real directory and the rest as placements (edge 6)", () => {
    const skillC = entity("skill", home(".gemini/skills/skill-c"));
    if (skillC.kind !== "skill") throw new Error("kind");
    expect(skillC.harness).toBe("gemini-cli");
    expect(skillC.layout).toBe("copy");
    expect(loadedBy("skill", home(".gemini/skills/skill-c"))).toMatchObject({
      mode: "disabled",
      reason: "listed in skills.disabled",
      countsTowardHeadline: false,
    });
    // The symlink into the canonical store is a Placement, never a second Skill.
    const skillD = entity("skill", home(".agents/skills/skill-d"));
    if (skillD.kind !== "skill") throw new Error("kind");
    expect(skillD.harness).toBeNull();
    expect(skillD.layout).toBe("canonical");
    expect(skillD.placements.map((item) => [item.path, item.harness, item.isSymlink])).toEqual([
      [home(".agents/skills/skill-d"), null, false],
      [home(".gemini/skills/skill-d"), "gemini-cli", true],
    ]);
    expect(skillD.placements[1]?.linkTarget).toBe("../../.agents/skills/skill-d");
    expect(result.entities.some((item) => item.path === home(".gemini/skills/skill-d"))).toBe(
      false,
    );
    expect(loadedBy("skill", home(".agents/skills/skill-d"))).toMatchObject({
      mode: "description-only",
      placement: home(".agents/skills/skill-d"),
      effectiveName: "/skill-d",
    });
    // Plugin tier.
    const skillB = entity("skill", home(".gemini/extensions/ext-a/skills/skill-b"));
    if (skillB.kind !== "skill") throw new Error("kind");
    expect(skillB.layout).toBe("plugin");
    expect(skillB.removal).toEqual({ method: "none" });
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "provided-by" &&
          edge.from === skillB.id &&
          edge.to === id("plugin", home(".gemini/extensions/ext-a")),
      ),
    ).toBe(true);
    // `.agents` wins inside the workspace tier.
    const winner = entity("skill", root("project-a/.agents/skills/skill-e"));
    const loser = entity("skill", root("project-a/.gemini/skills/skill-e"));
    expect(winner.harness).toBeNull();
    expect(loser.harness).toBe("gemini-cli");
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "shadows" &&
          edge.from === winner.id &&
          edge.to === loser.id &&
          edge.rule === "workspace > user > extension; .agents wins within a tier",
      ),
    ).toBe(true);
    expect(
      loadedBy("skill", root("project-a/.gemini/skills/skill-e"), id("project", root("project-a"))),
    ).toMatchObject({ mode: "shadowed", countsTowardHeadline: false });
  });

  it("namespaces commands and spawns agent definitions on demand (D39, D74)", () => {
    expect(loadedBy("skill", home(".gemini/commands/cmd-a.toml"))).toMatchObject({
      mode: "manual",
      effectiveName: "/cmd-a",
      disableModelInvocation: true,
      countsTowardHeadline: false,
    });
    expect(loadedBy("skill", home(".gemini/commands/ns/cmd-b.toml")).effectiveName).toBe(
      "/ns:cmd-b",
    );
    const command = entity("skill", home(".gemini/commands/cmd-a.toml"));
    if (command.kind !== "skill") throw new Error("kind");
    expect(command.form).toBe("command-file");
    expect(command.format).toBe("toml");
    // The prompt is the body, not metadata.
    expect(Object.keys(command.frontmatter)).toEqual(["description"]);
    expect(loadedBy("skill", root("project-a/.gemini/commands/proj-cmd.toml")).mode).toBe("manual");
    expect(loadedBy("skill", home(".gemini/extensions/ext-a/commands/ext-cmd.toml")).mode).toBe(
      "manual",
    );
    for (const path of [
      home(".gemini/agents/agent-b.md"),
      home(".gemini/extensions/ext-a/agents/agent-a.md"),
      root("project-a/.gemini/agents/agent-c.md"),
    ]) {
      expect(loadedBy("agent-definition", path)).toMatchObject({
        mode: "on-demand",
        countsTowardHeadline: false,
        confidence: "medium",
      });
    }
  });

  it("models MCP entries at four places with the mcp.allowed list (edges 7, 9, D71)", () => {
    const serverA = entity("mcp-server", `${home(".gemini/settings.json")}#mcpServers/server-a`);
    const serverB = entity(
      "mcp-server",
      `${root("project-a/.gemini/settings.json")}#mcpServers/server-b`,
    );
    const serverC = entity(
      "mcp-server",
      `${root("project-a/.gemini/settings.json")}#mcpServers/server-c`,
    );
    const serverD = entity(
      "mcp-server",
      `${root("project-b/.gemini/settings.json")}#mcpServers/server-d`,
    );
    const extServer = entity(
      "mcp-server",
      `${home(".gemini/extensions/ext-a/gemini-extension.json")}#mcpServers/ext-server`,
    );
    if (
      serverA.kind !== "mcp-server" ||
      serverB.kind !== "mcp-server" ||
      serverC.kind !== "mcp-server" ||
      serverD.kind !== "mcp-server" ||
      extServer.kind !== "mcp-server"
    )
      throw new Error("kind");
    expect(serverA.transport).toBe("stdio");
    expect(serverA.envKeys).toEqual(["VAR_A"]);
    expect(serverA.secretKeys).toEqual([]);
    expect(serverA.rawKeys).toEqual([
      "command",
      "args",
      "env",
      "cwd",
      "timeout",
      "trust",
      "includeTools",
      "excludeTools",
    ]);
    expect(serverA.enabled).toBeNull();
    expect(serverA.approval).toBe("not-applicable");
    expect(serverA.removal).toEqual({ method: "backup-edit" });
    expect(
      loadedBy("mcp-server", `${home(".gemini/settings.json")}#mcpServers/server-a`),
    ).toMatchObject({ mode: "full" });
    expect(serverB.transport).toBe("http");
    expect(serverB.headerKeys).toEqual(["Authorization"]);
    expect(serverB.secretKeys).toEqual(["Authorization", "clientSecret"]);
    expect(serverB.hasOauth).toBe(true);
    expect(serverB.enabled).toBe(false);
    expect(
      loadedBy("mcp-server", `${root("project-a/.gemini/settings.json")}#mcpServers/server-b`),
    ).toMatchObject({ mode: "disabled", reason: "not in mcp.allowed" });
    // `url` alone is SSE; `type` is not a documented Gemini key.
    expect(serverC.transport).toBe("sse");
    expect(serverD.transport).toBe("stdio");
    expect(extServer.usesInterpolation).toBe(true);
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "provided-by" &&
          edge.from === extServer.id &&
          edge.to === id("plugin", home(".gemini/extensions/ext-a")),
      ),
    ).toBe(true);
  });

  it("models the plugin, its enablement overrides and the never-loaded project one (edge 8)", () => {
    const extA = entity("plugin", home(".gemini/extensions/ext-a"));
    if (extA.kind !== "plugin") throw new Error("kind");
    expect(extA.pluginId).toBe("ext-a");
    expect(extA.version).toBe("1.0.0");
    expect(extA.removal).toEqual({
      method: "delegate",
      command: "gemini extensions uninstall ext-a",
    });
    expect(extA.origin?.installer).toBe("gemini-extension");
    expect(extA.origin?.sourceType).toBe("git");
    expect(extA.hooks.map((hook) => hook.event)).toEqual(["BeforeAgent"]);
    // Last matching glob wins: `<ROOT>/**` enables everything, `!<ROOT>/gone/**` disables gone.
    expect(extA.installs[0]).toEqual({ scope: "user", project: null, enabled: null });
    const goneInstall = extA.installs.find(
      (install) => install.project === id("project", root("gone")),
    );
    expect(goneInstall?.enabled).toBe(false);
    expect(
      extA.installs.find((install) => install.project === id("project", root("project-a")))
        ?.enabled,
    ).toBe(true);
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "originates-from" &&
          edge.from === extA.id &&
          edge.to ===
            id("settings-file", home(".gemini/extensions/ext-a/.gemini-extension-install.json")),
      ),
    ).toBe(true);
    // The plugin's own context file is part of the baseline.
    expect(loadedBy("context-file", home(".gemini/extensions/ext-a/GEMINI.md"))).toMatchObject({
      mode: "full",
      countsTowardHeadline: true,
    });
    // A project extension directory exists but is never loaded on main.
    const legacy = entity("plugin", root("project-a/.gemini/extensions/legacy-ext"));
    if (legacy.kind !== "plugin") throw new Error("kind");
    expect(legacy.scope).toBe("project");
    expect(legacy.installs).toEqual([
      { scope: "project", project: id("project", root("project-a")), enabled: false },
    ]);
    expect(loadedBy("plugin", root("project-a/.gemini/extensions/legacy-ext"))).toMatchObject({
      mode: "never",
      reason: "project plugins are not loaded; only ~/.gemini/extensions is",
    });
  });

  it("lists settings files and never opens a credential store (edges 12, 13, D65)", () => {
    for (const [path, role] of [
      [home(".gemini/settings.json"), "settings"],
      [home(".gemini/projects.json"), "state"],
      [home(".gemini/trustedFolders.json"), "state"],
      [home(".gemini/extensions/extension-enablement.json"), "state"],
      [home(".gemini/extensions/ext-a/gemini-extension.json"), "manifest"],
      [home(".gemini/extensions/ext-a/.gemini-extension-install.json"), "plugin-registry"],
      [home(".gemini/extensions/ext-a/hooks/hooks.json"), "hooks"],
      [home(".gemini/acknowledgments/agents.json"), "state"],
      [home(".gemini/keybindings.json"), "settings"],
      [home(".gemini/installation_id"), "state"],
    ] as const) {
      const file = entity("settings-file", path);
      if (file.kind !== "settings-file") throw new Error("kind");
      expect(file.role).toBe(role);
      // D142: a settings file is never deleted; its entries are edited out.
      expect(file.protection).toBe("never");
      expect(file.removal).toEqual({ method: "none" });
    }
    const userSettings = entity("settings-file", home(".gemini/settings.json"));
    if (userSettings.kind !== "settings-file") throw new Error("kind");
    expect(userSettings.entries).toBe(1);
    expect(userSettings.hooks.map((hook) => [hook.event, hook.matcher !== null])).toEqual([
      ["BeforeTool", true],
      ["SessionStart", false],
    ]);
    const projectSettings = entity("settings-file", root("project-a/.gemini/settings.json"));
    if (projectSettings.kind !== "settings-file") throw new Error("kind");
    expect(projectSettings.hooks.map((hook) => hook.event)).toEqual(["AfterTool"]);
    for (const path of [
      home(".gemini/oauth_creds.json"),
      home(".gemini/google_accounts.json"),
      home(".gemini/mcp-oauth-tokens.json"),
      home(".gemini/.env"),
      root("project-a/.gemini/.env"),
      home(".gemini/extensions/ext-a/.env"),
    ]) {
      const file = entity("settings-file", path);
      if (file.kind !== "settings-file") throw new Error("kind");
      expect(file.role).toBe("credentials");
      expect(file.topLevelKeys).toEqual([]);
      expect(file.entries).toBeNull();
      expect(file.sensitive).toBe(true);
      expect(file.protection).toBe("never");
    }
    const secrets = opened.paths.filter(
      (path) => path.startsWith(tree.dir) && SECRET_PATH.test(path),
    );
    expect(secrets).toEqual([]);
  });

  it("builds the cache units of ticket 08's Gemini table with the id8 join (edge 10)", () => {
    const anchor = slug("project-a", "chats/session-2026-08-20T10-00-00-0a1b2c3d.jsonl");
    const session = entity("harness-cache", anchor);
    if (session.kind !== "harness-cache") throw new Error("kind");
    expect(session.cacheKind).toBe("transcript");
    expect(session.unit).toBe("session");
    expect(session.rule).toBe("swept");
    expect(session.retention).toEqual({
      days: 30,
      bytes: null,
      count: null,
      source: "general.sessionRetention.maxAge",
    });
    expect(session.metrics.ageDays).toBe(3);
    expect(session.label).toBe("session 0a1b2c3d · 2026-08-23");
    // The fixture's ids do not align, so nothing joins and the members are units of their own.
    expect(session.locator).toEqual({ type: "paths", paths: [anchor] });
    for (const [path, kind] of [
      [slug("project-a", "chats/00000000-0000-4000-8000-000000000001"), "subagent-transcript"],
      [slug("project-a", "logs/session-00000000-0000-4000-8000-000000000001.jsonl"), "log"],
      [slug("project-a", "00000000-0000-4000-8000-000000000001"), "plan"],
    ] as const) {
      const unit = entity("harness-cache", path);
      if (unit.kind !== "harness-cache") throw new Error("kind");
      expect(unit.cacheKind).toBe(kind);
      // D118: a member no chat file claims is undocumented, never swept.
      expect(unit.rule).toBe("undocumented");
    }
    const checkpoints = entity("harness-cache", slug("project-a", "checkpoints"));
    const tagged = entity("harness-cache", slug("project-a", "checkpoint-tag-a.json"));
    const shellHistory = entity("harness-cache", slug("project-a", "shell_history"));
    const projectRoot = entity("harness-cache", slug("project-a", ".project_root"));
    const legacyLog = entity("harness-cache", slug("project-a", "logs.json"));
    const shadowGit = entity("harness-cache", home(".gemini/history/project-a"));
    const bin = entity("harness-cache", home(".gemini/tmp/bin"));
    if (
      checkpoints.kind !== "harness-cache" ||
      tagged.kind !== "harness-cache" ||
      shellHistory.kind !== "harness-cache" ||
      projectRoot.kind !== "harness-cache" ||
      legacyLog.kind !== "harness-cache" ||
      shadowGit.kind !== "harness-cache" ||
      bin.kind !== "harness-cache"
    )
      throw new Error("kind");
    expect(checkpoints.rule).toBe("undocumented");
    expect([tagged.rule, tagged.userContent]).toEqual(["kept", true]);
    expect([shellHistory.rule, shellHistory.sensitive]).toEqual(["kept", true]);
    expect(projectRoot.rule).toBe("kept");
    expect([legacyLog.rule, legacyLog.protection, legacyLog.removal.method]).toEqual([
      "undocumented",
      "undocumented",
      "none",
    ]);
    // The shadow git's newest member is the copy-time `.git/HEAD`, so it is not aged.
    expect([shadowGit.cacheKind, shadowGit.rule]).toEqual(["checkpoint", "kept"]);
    expect([bin.protection, bin.removal.method]).toEqual(["undocumented", "none"]);
    // Both aged sessions are past the 30-day retention and are preselected.
    const goneSession = entity(
      "harness-cache",
      slug("gone", "chats/session-2026-04-01T09-00-00-2c3d4e5f.jsonl"),
    );
    const straySession = entity(
      "harness-cache",
      slug(
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "chats/session-2025-06-01T09-00-00-3d4e5f6a.json",
      ),
    );
    if (goneSession.kind !== "harness-cache" || straySession.kind !== "harness-cache")
      throw new Error("kind");
    expect(goneSession.metrics.ageDays).toBe(120);
    expect(goneSession.project).toBe(id("project", root("gone")));
    expect(straySession.metrics.ageDays).toBe(400);
    expect(straySession.project).toBeNull();
    const preselected = result.findings
      .filter((finding) => finding.category === "harness-cache")
      .flatMap((finding) => finding.targets)
      .filter((target) => target.preselect === true)
      .map((target) => target.id);
    expect(preselected).toContain(goneSession.id);
    expect(preselected).toContain(straySession.id);
    expect(preselected).not.toContain(session.id);
  });

  it("files the legacy Gemini Added Memories section as a shadow-memory finding (D84)", () => {
    const findings = geminiFindings(result);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      category: "shadow-memory",
      severity: "low",
      confidence: "certain",
      action: { kind: "open", preselect: false },
    });
    expect(findings[0]?.targets[0]?.id).toBe(id("context-file", home(".gemini/GEMINI.md")));
  });

  it("matches the audit snapshot", async () => {
    const stable = normaliseSnapshot(result, tree);
    stable.scan.durationMs = 0;
    await expect(stableTimes(formattedJson(stable) + "\n")).toMatchFileSnapshot(
      "./__snapshots__/from-docs.audit.json",
    );
  });
});

// ---------------------------------------------------------- zero-breadcrumbs

describe.runIf(POSIX_FIXTURE_HOST)("gemini-cli adapter over the zero-breadcrumbs case", () => {
  let tree: FixtureTree;
  let result: AuditIndex;
  const { home, root, id } = treePaths(() => tree);

  function entity(kind: string, path: string): Entity {
    const found = result.entities.find((item) => item.id === id(kind, path));
    if (found === undefined) throw new Error(`entity not found: ${id(kind, path)}`);
    return found;
  }

  function loadedBy(kind: string, path: string): LoadedByEdge {
    const from = id(kind, path);
    const edge = result.edges.find((item) => item.kind === "loaded-by" && item.from === from);
    if (edge === undefined || edge.kind !== "loaded-by")
      throw new Error(`loaded-by edge not found for ${from}`);
    return edge;
  }

  beforeAll(async () => {
    opened.paths.length = 0;
    ({ tree, result } = await runCase("gemini-cli/zero-breadcrumbs"));
  });

  afterAll(async () => {
    await tree.cleanup();
  });

  it("yields a Harness with no breadcrumbs and no Projects of its own (edge 1)", () => {
    const harness = result.harnesses[0];
    expect(result.harnesses).toHaveLength(1);
    expect(harness?.presence).toBe("installed");
    expect(harness?.capabilities.contextFileNames).toEqual(["GEMINI.md"]);
    expect(result.breadcrumbs).toEqual([]);
    expect(harness?.userScope.stray).toEqual([]);
    // The only Project comes from the marker walk; `~` and `~/.gemini` are never Projects.
    expect(result.projects.map((project) => [project.path, project.discoveredBy])).toEqual([
      [root("project-a"), ["marker-walk"]],
    ]);
    expect(result.projects.some((project) => project.path.includes(".gemini"))).toBe(false);
    // A zero-byte user context file still costs nothing and is still reported.
    const userFile = entity("context-file", home(".gemini/GEMINI.md"));
    expect(userFile.metrics.bytes).toBe(0);
    expect(userFile.metrics.tokens?.o200k).toBe(0);
    expect(loadedBy("context-file", home(".gemini/GEMINI.md"))).toMatchObject({
      mode: "full",
      tokensLoaded: 0,
    });
    // `AGENTS.md` is not in this user's `context.fileName`.
    expect(loadedBy("context-file", root("project-a/AGENTS.md"))).toMatchObject({
      mode: "never",
      reason: "file not read by the harness: context.fileName = [GEMINI.md]",
    });
  });

  it("dedupes the symlink fan-out and keeps the dangling link as its own Skill (edge 2)", () => {
    for (const name of ["find-skills", "next-best-practices"]) {
      const skill = entity("skill", home(`.agents/skills/${name}`));
      if (skill.kind !== "skill") throw new Error("kind");
      expect(skill.harness).toBeNull();
      expect(skill.layout).toBe("canonical");
      expect(skill.placements.map((item) => [item.path, item.harness, item.isSymlink])).toEqual([
        [home(`.agents/skills/${name}`), null, false],
        [home(`.gemini/skills/${name}`), "gemini-cli", true],
      ]);
      expect(loadedBy("skill", home(`.agents/skills/${name}`))).toMatchObject({
        mode: "description-only",
        placement: home(`.agents/skills/${name}`),
      });
    }
    const dangling = entity("skill", home(".gemini/skills/skill-gone"));
    if (dangling.kind !== "skill") throw new Error("kind");
    expect(dangling.placements).toHaveLength(1);
    expect(dangling.placements[0]).toMatchObject({
      dangling: true,
      isSymlink: true,
      linkTarget: "../../.agents/skills/skill-gone",
    });
    expect(dangling.metrics.bytes).toBe(0);
    // A link whose target is gone is loaded by no session.
    expect(
      result.edges.some((edge) => edge.kind === "loaded-by" && edge.from === dangling.id),
    ).toBe(false);
  });

  it("keeps Antigravity out of Gemini's own rows (edge 3, D121)", () => {
    const antigravity = entity("harness-cache", home(".gemini/antigravity"));
    if (antigravity.kind !== "harness-cache") throw new Error("kind");
    expect(antigravity.producer?.harness).toBe("other-app");
    expect(antigravity.rule).toBe("undocumented");
    expect(antigravity.protection).toBe("undocumented");
    expect(antigravity.removal).toEqual({ method: "none" });
    expect(antigravity.sensitive).toBe(false);
    // Nothing below it is ever read: no skill, no MCP entry, no context file.
    expect(result.entities.some((item) => item.path.includes("/antigravity/skills/"))).toBe(false);
    expect(result.entities.some((item) => item.path.includes("/global_skills/"))).toBe(false);
    expect(result.entities.some((item) => item.path.endsWith("mcp_config.json"))).toBe(false);
    expect(
      result.entities.filter((item) => item.path.includes("antigravity")).map((item) => item.path),
    ).toEqual([home(".gemini/antigravity")]);
  });

  it("reads the observed settings shape and the rotating backup (edges 4, 5, 6)", () => {
    const server = entity("mcp-server", `${home(".gemini/settings.json")}#mcpServers/server-a`);
    if (server.kind !== "mcp-server") throw new Error("kind");
    // `type` is not a documented Gemini key: `url` alone decides the transport.
    expect(server.transport).toBe("sse");
    expect(server.rawKeys).toEqual(["type", "url", "headers"]);
    expect(server.invalid).toBeNull();
    expect(server.secretKeys).toEqual(["Authorization"]);
    expect(server.enabled).toBeNull();
    expect(
      loadedBy("mcp-server", `${home(".gemini/settings.json")}#mcpServers/server-a`).mode,
    ).toBe("full");
    const backup = entity("harness-cache", home(".gemini/settings.json.orig"));
    if (backup.kind !== "harness-cache") throw new Error("kind");
    expect(backup.cacheKind).toBe("config-backup");
    expect(backup.rule).toBe("undocumented");
    expect(backup.metrics.ageDays).toBe(200);
    expect(backup.removal).toEqual({ method: "trash" });
    const preselected = result.findings
      .filter((finding) => finding.category === "harness-cache")
      .flatMap((finding) => finding.targets)
      .filter((target) => target.preselect === true);
    expect(preselected).toEqual([]);
    for (const path of [home(".gemini/oauth_creds.json"), home(".gemini/google_accounts.json")]) {
      const file = entity("settings-file", path);
      if (file.kind !== "settings-file") throw new Error("kind");
      expect(file.role).toBe("credentials");
      expect(file.metrics.bytes).toBe(0);
    }
    const secrets = opened.paths.filter(
      (path) => path.startsWith(tree.dir) && SECRET_PATH.test(path),
    );
    expect(secrets).toEqual([]);
  });

  it("matches the audit snapshot", async () => {
    const stable = normaliseSnapshot(result, tree);
    stable.scan.durationMs = 0;
    await expect(stableTimes(formattedJson(stable) + "\n")).toMatchFileSnapshot(
      "./__snapshots__/zero-breadcrumbs.audit.json",
    );
  });
});
