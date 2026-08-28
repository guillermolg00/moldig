import { describe, expect, it } from "vitest";
import type {
  AuditIndex,
  Edge,
  Entity,
  EntityBase,
  McpServer,
  Origin,
  Plugin,
  Skill,
} from "../index/types.js";
import { MULTIPLIERS } from "../tokens/tokenizer.js";
import { plan } from "./plan.js";
import type { PlanEnv } from "./types.js";
import { mcpUpdateVerdict, updateAllSelection } from "./update-all.js";

const NOW = new Date("2026-08-27T12:00:00.000Z");
const HOME = "/home/test";

function base(id: string, path: string, label: string): EntityBase {
  return {
    id,
    kind: "skill",
    harness: "claude-code",
    producer: null,
    project: null,
    scope: "user",
    ownership: "human",
    shared: null,
    gitStatus: null,
    path,
    relativePath: null,
    locator: { type: "dir", path },
    format: "dir",
    label,
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: {
      bytes: 0,
      files: 1,
      lines: null,
      mtime: null,
      ageDays: null,
      tokens: null,
      lastUsed: null,
    },
  };
}

function origin(installer: Origin["installer"], file: string, name: string): Origin {
  return {
    installer,
    sourceType: "github",
    source: "example/skills",
    sourceUrl: "https://github.com/example/skills",
    ref: null,
    skillPath: `skills/${name}`,
    recordedHash: null,
    installedAt: null,
    updatedAt: null,
    lock: {
      type: "entry",
      file,
      format: "json",
      keyPath: ["skills", name],
    },
  };
}

function skill(name: string, lockFile: string, overrides: Partial<Skill> = {}): Skill {
  const path = `${HOME}/.agents/skills/${name}`;
  return {
    ...base(`skill:${name}`, path, name),
    kind: "skill",
    form: "skill-dir",
    name,
    dirName: name,
    frontmatterName: null,
    layout: "canonical",
    placements: [],
    frontmatter: {},
    sidecars: [],
    contentHash: [],
    origin: origin("vercel-skills", lockFile, name),
    drift: "none",
    ...overrides,
  };
}

function mcp(
  name: string,
  command: string | null,
  args: readonly string[],
  overrides: Partial<McpServer> = {},
): McpServer {
  const file = `${HOME}/.config/mcp.json`;
  return {
    ...base(`mcp-server:${name}`, file, name),
    kind: "mcp-server",
    locator: {
      type: "entry",
      file,
      format: "json",
      keyPath: ["mcpServers", name],
    },
    format: "json",
    name,
    transport: "stdio",
    command,
    args: [...args],
    url: null,
    envKeys: [],
    headerKeys: [],
    secretKeys: [],
    hasOauth: false,
    usesInterpolation: false,
    enabled: true,
    approval: "not-applicable",
    invalid: null,
    endpointKey: `${command ?? "remote"}:${args.join(":")}`,
    rawKeys: [],
    ...overrides,
  };
}

function plugin(name: string): Plugin {
  const path = `${HOME}/.claude/plugins/${name}`;
  return {
    ...base(`plugin:${name}`, path, name),
    kind: "plugin",
    pluginId: `${name}@marketplace`,
    version: "1.0.0",
    marketplace: "marketplace",
    installs: [{ scope: "user", project: null, enabled: true }],
    origin: origin("claude-plugin", `${HOME}/.claude/plugins/installed_plugins.json`, name),
    hooks: [],
  };
}

function index(entities: readonly Entity[], edges: readonly Edge[] = []): AuditIndex {
  return {
    schemaVersion: 0,
    generatedAt: NOW.toISOString(),
    moldig: { version: "0.0.0" },
    scan: {
      home: HOME,
      roots: ["/work"],
      cwd: "/work/project-a",
      platform: "linux",
      caseFold: false,
      env: {},
      git: { available: false, version: null },
      durationMs: 0,
    },
    tokenizer: {
      name: "gpt-tokenizer",
      version: "0",
      encoding: "o200k_base",
      fallbackUsed: false,
      multipliers: MULTIPLIERS,
    },
    harnesses: [],
    projects: [],
    breadcrumbs: [],
    entities: [...entities],
    edges: [...edges],
    warnings: [],
    totals: {
      entities: entities.length,
      files: 0,
      bytes: 0,
      harnessCacheBytes: 0,
      memoryBytes: 0,
      tokens: 0,
    },
    findings: [],
    headline: {
      scope: "user-controllable",
      focus: { project: null, reason: "none" },
      perHarness: [],
    },
  };
}

const ENV: PlanEnv = {
  home: HOME,
  platform: "linux",
  dataDir: `${HOME}/.local/share/moldig`,
  now: NOW,
  moldig: { version: "0.0.0" },
  command: "moldig update",
  deviceOf: () => ({ dev: 1, kind: "local" }),
};

function providedBy(from: string, to: string): Edge {
  return {
    id: `edge:provided-by:${from}:${to}`,
    kind: "provided-by",
    from,
    to,
    confidence: "certain",
    evidence: [{ kind: "manifest" }],
  };
}

describe("Update all batching", () => {
  it("runs Vercel Skills once per lock scope with sorted names and excludes local changes", () => {
    const globalLock = `${HOME}/.agents/.skill-lock.json`;
    const projectLock = "/work/project-a/skills-lock.json";
    const preview = updateAllSelection(
      index([
        skill("beta", globalLock),
        skill("alpha", globalLock),
        skill("project-skill", projectLock, {
          project: "project:/work/project-a",
          scope: "project",
        }),
        skill("changed", globalLock, { drift: "local-modified" }),
      ]),
    );

    expect(preview.counts).toMatchObject({
      batches: 2,
      skillsReady: 3,
      excluded: 1,
    });
    expect(preview.notices).toEqual([
      expect.objectContaining({
        label: "changed",
        kind: "excluded",
        reason: "locally modified Skills are excluded from Update all",
      }),
    ]);

    const batches = preview.selection.flatMap((target) =>
      target.updateBatch === undefined ? [] : [target.updateBatch],
    );
    expect(batches).toEqual([
      expect.objectContaining({
        kind: "vercel-skills",
        label: "Skills · global · 2",
        scope: "global",
        names: ["alpha", "beta"],
      }),
      expect.objectContaining({
        kind: "vercel-skills",
        label: "Skills · project · 1",
        scope: "project",
        names: ["project-skill"],
      }),
    ]);

    const runPlan = plan(index([]), preview.selection, ENV);
    expect(runPlan.groups).toHaveLength(1);
    expect(
      runPlan.groups[0]?.rows.map((row) => ({
        argv: row.disposition.argv,
        cwd: row.disposition.cwd,
      })),
    ).toEqual([
      {
        argv: ["npx", "skills", "update", "alpha", "beta", "-g", "-y"],
        cwd: HOME,
      },
      {
        argv: ["npx", "skills", "update", "project-skill", "-p", "-y"],
        cwd: "/work/project-a",
      },
    ]);
  });

  it("updates a parent plugin once and leaves its provided Skill and MCP server managed by it", () => {
    const parent = plugin("bundle");
    const childSkill = skill("bundled-skill", `${HOME}/ignored.json`, {
      layout: "plugin",
      origin: null,
    });
    const childMcp = mcp("bundled-mcp", "node", ["server.js"]);
    const preview = updateAllSelection(
      index(
        [parent, childSkill, childMcp],
        [providedBy(childSkill.id, parent.id), providedBy(childMcp.id, parent.id)],
      ),
    );

    expect(preview.selection).toEqual([{ action: "update", id: parent.id }]);
    expect(preview.counts).toMatchObject({ batches: 1, pluginsReady: 1, managed: 2 });
    expect(preview.notices).toEqual([
      expect.objectContaining({ subject: "mcp-server", kind: "managed" }),
      expect.objectContaining({ subject: "skill", kind: "managed" }),
    ]);
  });

  it("blocks a parent plugin when one of its provided Skills was modified locally", () => {
    const parent = plugin("bundle");
    const changed = skill("bundled-skill", `${HOME}/ignored.json`, {
      layout: "plugin",
      origin: null,
      drift: "local-modified",
    });
    const sibling = mcp("bundled-mcp", "node", ["server.js"]);
    const preview = updateAllSelection(
      index(
        [parent, changed, sibling],
        [providedBy(changed.id, parent.id), providedBy(sibling.id, parent.id)],
      ),
    );

    expect(preview.selection).toEqual([]);
    expect(preview.counts).toMatchObject({ batches: 0, pluginsReady: 0, excluded: 3 });
    expect(preview.notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ label: "bundle", kind: "excluded" }),
        expect.objectContaining({ label: "bundled-skill", kind: "excluded" }),
        expect.objectContaining({ label: "bundled-mcp", kind: "excluded" }),
      ]),
    );
  });

  it("never passes option-shaped Skill or plugin identifiers to an Installer", () => {
    const badPlugin = { ...plugin("bundle"), pluginId: "--all@marketplace" };
    const preview = updateAllSelection(
      index([skill("--all", `${HOME}/.agents/.skill-lock.json`), badPlugin]),
    );

    expect(preview.selection).toEqual([]);
    expect(preview.notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ subject: "skill", kind: "unsupported" }),
        expect.objectContaining({ subject: "plugin", kind: "unsupported" }),
      ]),
    );
  });
});

describe("MCP Update all classification", () => {
  it.each([
    {
      name: "remote server",
      server: mcp("remote", null, [], { transport: "http", url: "https://mcp.example.test" }),
      kind: "managed",
      reason: "updated by its operator",
    },
    {
      name: "unpinned npx launcher",
      server: mcp("npx", "npx", ["-y", "@modelcontextprotocol/server-filesystem"]),
      kind: "managed",
      reason: "ephemeral launcher",
    },
    {
      name: "pinned npx launcher",
      server: mcp("npx-pinned", "npx", ["@modelcontextprotocol/server-filesystem@1.2.3"]),
      kind: "excluded",
      reason: "never rewrites that pin",
    },
    {
      name: "unpinned uvx launcher",
      server: mcp("uvx", "uvx", ["mcp-server-fetch"]),
      kind: "managed",
      reason: "ephemeral launcher",
    },
    {
      name: "pinned uvx launcher",
      server: mcp("uvx-pinned", "uvx", ["mcp-server-fetch==1.2.3"]),
      kind: "excluded",
      reason: "never rewrites that pin",
    },
    {
      name: "uvx constraints",
      server: mcp("uvx-constraint", "uvx", ["--constraint", "constraints.txt", "mcp-server-fetch"]),
      kind: "unsupported",
      reason: "cannot be identified safely",
    },
    {
      name: "direct binary",
      server: mcp("binary", "/usr/local/bin/custom-mcp", []),
      kind: "unsupported",
      reason: "no non-destructive updater",
    },
    {
      name: "Docker image",
      server: mcp("docker", "docker", [
        "run",
        "--rm",
        "--env",
        "TOKEN",
        "ghcr.io/example/mcp:stable",
      ]),
      kind: "docker-image",
      image: "ghcr.io/example/mcp:stable",
    },
    {
      name: "Docker digest",
      server: mcp("docker-digest", "docker", [
        "run",
        `ghcr.io/example/mcp@sha256:${"a".repeat(64)}`,
      ]),
      kind: "excluded",
      reason: "pinned by digest",
    },
    {
      name: "ambiguous Docker arguments",
      server: mcp("docker-ambiguous", "docker", ["run", "--unknown-short-form"]),
      kind: "unsupported",
      reason: "cannot be identified safely",
    },
  ])("classifies $name conservatively", ({ server, kind, reason, image }) => {
    const verdict = mcpUpdateVerdict(server);
    expect(verdict.kind).toBe(kind);
    const actualReason = "reason" in verdict ? verdict.reason : null;
    const reasonMatches =
      reason === undefined ? actualReason === null : (actualReason?.includes(reason) ?? false);
    expect(reasonMatches).toBe(true);
    expect(verdict.kind === "docker-image" ? verdict.image : undefined).toBe(image);
  });

  it("never repeats raw launcher URLs or interpolated targets in a notice", () => {
    const credential = "https://user:token@example.test/private.tgz";
    const url = mcp("url", "npx", ["--registry", credential, "server-package"]);
    const interpolated = mcp("interpolated", "npx", ["${MCP_PACKAGE}"], {
      usesInterpolation: true,
    });

    for (const server of [url, interpolated]) {
      const verdict = mcpUpdateVerdict(server);
      expect(verdict.kind).toBe("unsupported");
      expect("reason" in verdict ? verdict.reason : "").not.toContain("token");
      expect("reason" in verdict ? verdict.reason : "").not.toContain("MCP_PACKAGE");
    }
  });

  it("deduplicates repeated Docker configurations by updater target and plans one argv-only pull", () => {
    const image = "ghcr.io/example/mcp:stable";
    const first = mcp("docker-a", "docker", ["run", "--rm", image]);
    const second = mcp("docker-b", "docker", ["run", "-i", image], {
      harness: "codex",
      locator: {
        type: "entry",
        file: `${HOME}/.codex/config.toml`,
        format: "toml",
        keyPath: ["mcp_servers", "docker-b"],
      },
    });
    const preview = updateAllSelection(
      index([
        first,
        second,
        mcp("remote", null, [], { transport: "sse", url: "https://mcp.example.test" }),
        mcp("pinned", "npx", ["server-package@2.0.0"]),
        mcp("unknown", "custom-mcp", []),
      ]),
    );

    expect(preview.counts).toEqual({
      batches: 1,
      skillsReady: 0,
      pluginsReady: 0,
      mcpServersReady: 2,
      managed: 1,
      excluded: 1,
      unsupported: 1,
    });
    expect(preview.selection).toEqual([
      {
        action: "update",
        updateBatch: expect.objectContaining({
          kind: "docker-image",
          label: `MCP image ${image} · 2`,
          image,
        }),
      },
    ]);

    const runPlan = plan(index([]), preview.selection, ENV);
    const row = runPlan.groups[0]?.rows[0];
    expect(row?.disposition).toMatchObject({
      kind: "update",
      argv: ["docker", "image", "pull", image],
      cwd: null,
      runnable: true,
    });
    expect(row?.disposition.command).toBe(`docker image pull ${image}`);
  });

  it("keeps the trusted Docker command name, context and platform without running configured paths", () => {
    const image = "ghcr.io/example/mcp:stable";
    const preview = updateAllSelection(
      index([
        mcp("default", "docker", ["run", image]),
        mcp("windows", "docker.exe", ["run", image]),
        mcp("configured-path", "/tmp/attacker/docker", ["run", image]),
        mcp("remote-context", "docker", [
          "--context",
          "build-machine",
          "run",
          "--platform",
          "linux/arm64",
          image,
        ]),
      ]),
    );

    expect(preview.counts).toMatchObject({
      batches: 3,
      mcpServersReady: 3,
      unsupported: 1,
    });
    const commands = plan(index([]), preview.selection, ENV)
      .groups.flatMap((group) => group.rows)
      .map((row) => row.disposition.argv);
    expect(commands).toEqual(
      expect.arrayContaining([
        ["docker", "image", "pull", image],
        ["docker.exe", "image", "pull", image],
        [
          "docker",
          "--context",
          "build-machine",
          "image",
          "pull",
          "--platform",
          "linux/arm64",
          image,
        ],
      ]),
    );
    expect(commands.flat()).not.toContain("/tmp/attacker/docker");
  });
});
