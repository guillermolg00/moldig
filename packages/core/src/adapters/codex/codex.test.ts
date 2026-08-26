import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit, scan } from "../../index.js";
import type {
  AuditIndex,
  Breadcrumb,
  Entity,
  HarnessCache,
  LoadedByEdge,
} from "../../index/types.js";
import {
  loadFixture,
  normaliseSnapshot,
  treePaths,
  type FixtureTree,
  fixtureCopyTime,
  POSIX_FIXTURE_HOST,
} from "../../testing/index.js";
import { applyChainCap } from "./context-files.js";

/** After the fixture's synthetic timestamps (2023-11-14); `ages` are relative to it. */
const NOW = new Date("2026-08-26T12:00:00.000Z");
const ISO_ANYWHERE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const DATE_ANYWHERE = /(?<![\dT:-])\d{4}-\d{2}-\d{2}(?![\dT])/g;
const PLATFORM = "darwin";

let tree: FixtureTree;
let result: AuditIndex;
/** The same case scanned from inside `project-a/packages/x`: the chain order and the cap. */
let nested: { tree: FixtureTree; result: AuditIndex };

/** Ids fold the path part on darwin, never the `#keyPath` (ticket 07). */
const { home, root, id } = treePaths(() => tree);

function entity(kind: string, path: string, from: AuditIndex = result): Entity {
  const found = from.entities.find((item) => item.id === id(kind, path));
  if (found === undefined) throw new Error(`entity not found: ${id(kind, path)}`);
  return found;
}

function cache(path: string): HarnessCache {
  const found = entity("harness-cache", path);
  if (found.kind !== "harness-cache") throw new Error(`not a cache unit: ${path}`);
  return found;
}

function loadedBy(kind: string, path: string, from: AuditIndex = result): LoadedByEdge {
  const target = id(kind, path);
  const edge = from.edges.find((item) => item.kind === "loaded-by" && item.from === target);
  if (edge === undefined || edge.kind !== "loaded-by")
    throw new Error(`loaded-by edge not found for ${target}`);
  return edge;
}

function crumb(predicate: (item: Breadcrumb) => boolean): Breadcrumb {
  const found = result.breadcrumbs.find(predicate);
  if (found === undefined) throw new Error("breadcrumb not found");
  return found;
}

async function scanTree(
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<{ tree: FixtureTree; result: AuditIndex }> {
  const fixture: Parameters<typeof loadFixture>[1] = { now: NOW, platform: PLATFORM };
  if (options.cwd !== undefined) fixture.cwd = options.cwd;
  if (options.env !== undefined) fixture.env = options.env;
  const loaded = await loadFixture("codex/trust-and-state", fixture);
  const index = await scan({
    home: loaded.home,
    roots: loaded.roots,
    cwd: loaded.cwd,
    platform: PLATFORM,
    env: loaded.env,
    git: false,
    now: NOW,
    harnesses: ["codex"],
  });
  return { tree: loaded, result: await audit(index) };
}

/** Every file below `dir` with its mtime, for the tree-unchanged test. */
async function treeState(dir: string): Promise<Map<string, number>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const parts = await Promise.all(
    entries.map(async (item): Promise<[string, number][]> => {
      const path = join(dir, item.name);
      if (item.isDirectory()) return Array.from(await treeState(path));
      return [[path, (await stat(path)).mtimeMs]];
    }),
  );
  return new Map(parts.flat());
}

/**
 * Files the fixture does not age carry the copy's mtime; any timestamp within three days of the
 * real clock is a copy-time stamp and would differ per run. Stamps derived from `NOW` lie on a
 * whole-day grid from it and are kept.
 */
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

/** `<path> <mtime>` per file, sorted — one comparable string list per tree state. */
function mtimeRows(state: Map<string, number>): string[] {
  return [...state]
    .map(([path, mtime]) => `${path} ${mtime}`)
    .toSorted((a, b) => a.localeCompare(b));
}

/** Everything a scan produced except the harness row, for the "changes nothing else" comparison. */
function indexBody(index: { entities: unknown; breadcrumbs: unknown; edges: unknown }): string {
  return JSON.stringify([index.entities, index.breadcrumbs, index.edges]);
}

beforeAll(async () => {
  const first = await scanTree();
  tree = first.tree;
  result = first.result;
  nested = await scanTree({ cwd: "root/project-a/packages/x" });
});

afterAll(async () => {
  await tree.cleanup();
  await nested.tree.cleanup();
});

describe.runIf(POSIX_FIXTURE_HOST)("codex adapter over the trust-and-state case", () => {
  it("describes the harness from what it wrote to disk", () => {
    const harness = result.harnesses[0];
    expect(result.harnesses).toHaveLength(1);
    expect(harness?.id).toBe("harness:codex");
    expect(harness?.displayName).toBe("Codex");
    // One Harness per product family: the CLI and the desktop app share `~/.codex`.
    expect(harness?.surfaces).toEqual(["cli", "desktop"]);
    expect(harness?.presence).toBe("installed");
    // D54: the newest `threads.cli_version`, and the fixture redacts every one of them.
    expect(harness?.version).toBe("<redacted>");
    expect(harness?.effectiveModel).toBe("<redacted>");
    expect(harness?.modelFamily).toBeNull();
    expect(harness?.contextWindowTokens).toBeNull();
    expect(harness?.capabilities).toEqual({
      memoryLocation: "file",
      memoryReadSignal: "unchecked",
      contextFileNames: ["AGENTS.override.md", "AGENTS.md"],
      sweepDocumented: false,
    });
    expect(harness?.caps).toEqual({
      memoryIndexLines: null,
      memoryIndexBytes: null,
      chainMaxBytes: 32_768,
      skillDescriptionChars: null,
      importDepth: null,
    });
    expect(harness?.userScope.paths).toEqual([
      { path: home(".codex"), role: "data", source: "default", envVar: null },
    ]);
    expect(harness?.breadcrumbSources).toEqual([
      { kind: "trust-entry", path: home(".codex/config.toml"), readInV1: true },
      { kind: "session-cwd", path: home(".codex/state_5.sqlite"), readInV1: true },
      { kind: "session-cwd", path: home(".codex/sessions"), readInV1: false },
      { kind: "workspace-record", path: home(".codex/.codex-global-state.json"), readInV1: false },
      { kind: "session-cwd", path: home(".codex/sqlite/codex-dev.db"), readInV1: false },
    ]);
    // D64: `shell_environment_policy.set` and the MCP `env` map keep their key names only.
    expect(harness?.effectiveSettings["shell_environment_policy"]).toEqual({
      set: { "entry-1": "<redacted>" },
    });
    expect(result.scan.env).toEqual({});
    // The `config.toml` parses and `state_5.sqlite` opens: git is the only degraded source.
    expect(result.warnings.map((item) => item.code)).toEqual(["git-missing"]);
  });

  it("case 1: the trust map yields projects, an orphan and three stray containers", () => {
    const trust = (key: string): Breadcrumb =>
      crumb((item) => item.kind === "trust-entry" && item.raw === key);
    expect(trust(root("project-a")).project).toBe(id("project", root("project-a")));
    expect(trust(root("project-a")).locator).toEqual({
      type: "entry",
      file: home(".codex/config.toml"),
      format: "toml",
      keyPath: ["projects", root("project-a")],
    });
    const projectA = result.projects.find((item) => item.id === id("project", root("project-a")));
    const projectB = result.projects.find((item) => item.id === id("project", root("project-b")));
    expect(projectA?.perHarness["codex"]?.trusted).toBe(true);
    expect(projectB?.perHarness["codex"]?.trusted).toBe(false);
    // A gone directory keeps a Project identified by the recorded path, reachability `orphan`.
    const gone = result.projects.find((item) => item.id === id("project", root("gone")));
    expect(gone?.kind).toBe("unknown");
    expect(gone?.reachability).toBe("orphan");
    expect(trust(root("gone")).reachability).toBe("orphan");
    // D57: `~`, the Root and `/` are containers — Stray, never Projects, never propagating trust.
    for (const key of [tree.root, tree.home, "/"]) {
      expect(trust(key).project).toBeNull();
      expect(trust(key).strayReason).toBe("bare-directory");
    }
    expect(result.projects.map((item) => item.path)).toEqual([
      root("gone"),
      root("project-a"),
      root("project-b"),
    ]);
    const stray = result.harnesses[0]?.userScope.stray ?? [];
    expect(stray).toHaveLength(4);
    expect(stray.filter((item) => item.includes("#projects/"))).toHaveLength(3);
    // The untrusted Project's own layer is still listed; only its verdicts say it is gated off.
    expect(entity("settings-file", root("project-b/.codex/config.toml")).scope).toBe("project");
    const rejected = loadedBy(
      "mcp-server",
      `${root("project-b/.codex/config.toml")}#mcp_servers/project-server`,
    );
    expect(rejected.mode).toBe("never");
    expect(rejected.reason).toBe("untrusted project");
    const server = entity(
      "mcp-server",
      `${root("project-b/.codex/config.toml")}#mcp_servers/project-server`,
    );
    expect(server.kind === "mcp-server" && server.approval).toBe("rejected");
  });

  it("case 2 and 3: thread cwds aggregate one per path, `/` included", () => {
    const sessionCwd = (raw: string): Breadcrumb =>
      crumb((item) => item.kind === "session-cwd" && item.raw === raw);
    const packages = sessionCwd(root("project-a/packages/x"));
    // A subdirectory of a repository folds into the repository's Project.
    expect(packages.project).toBe(id("project", root("project-a")));
    expect(packages.relativePathInProject).toBe("packages/x");
    expect(packages.occurrences.count).toBe(1);
    expect(packages.locator).toEqual({
      type: "sqlite",
      file: home(".codex/state_5.sqlite"),
      table: "threads",
      keyColumn: "cwd",
      keyValue: root("project-a/packages/x"),
    });
    const projectA = sessionCwd(root("project-a"));
    expect(projectA.refs.lastSessionId).toBe("00000000-0000-4000-8000-000000000001");
    expect(projectA.state).toEqual([
      id(
        "harness-cache",
        home(
          ".codex/sessions/2026/08/20/rollout-2026-08-20T10-00-00-00000000-0000-4000-8000-000000000001.jsonl",
        ),
      ),
    ]);
    // The filesystem root is a container: Stray, and the rollout behind it is user-scope state.
    expect(sessionCwd("/").strayReason).toBe("bare-directory");
    const projectless = cache(
      home(
        ".codex/sessions/2026/02/02/rollout-2026-02-02T10-00-00-00000000-0000-4000-8000-000000000004.jsonl",
      ),
    );
    expect(projectless.project).toBeNull();
    expect(result.breadcrumbs.every((item) => item.recordedForm === "path")).toBe(true);
    // Four rows, four distinct cwds, so four `session-cwd` breadcrumbs and no more.
    expect(result.breadcrumbs.filter((item) => item.kind === "session-cwd")).toHaveLength(4);
  });

  it("case 3 and 5: compressed, archived and pre-2025-09-16 rollouts are kept units", () => {
    const compressed = cache(
      home(
        ".codex/sessions/2026/03/01/rollout-2026-03-01T10-00-00-00000000-0000-4000-8000-000000000007.jsonl.zst",
      ),
    );
    expect(compressed.format).toBe("jsonl.zst");
    expect(compressed.project).toBeNull();
    expect(compressed.rule).toBe("kept");
    const archived = cache(
      home(
        ".codex/archived_sessions/rollout-2026-01-15T10-00-00-00000000-0000-4000-8000-000000000006.jsonl",
      ),
    );
    expect(archived.label.endsWith(" · archived")).toBe(true);
    expect(archived.project).toBeNull();
    // The flat pre-2025-09-16 format has no `cwd` at all and no row: shown, never swept.
    const flat = cache(
      home(
        ".codex/sessions/2025/09/01/rollout-2025-09-01T10-00-00-00000000-0000-4000-8000-000000000005.jsonl",
      ),
    );
    expect(flat.project).toBeNull();
    expect(flat.metrics.ageDays).toBe(358);
    expect(flat.rule).toBe("kept");
    expect(flat.label).toBe("rollout 00000000 · 2025-09-01");
    // Codex documents no sweep for any of its own state, so nothing here is ever preselected.
    const units = result.entities.filter((item) => item.kind === "harness-cache");
    expect(units.every((item) => item.kind === "harness-cache" && item.rule !== "swept")).toBe(
      true,
    );
    expect(
      result.findings.every((finding) =>
        finding.targets.every((target) => target.preselect !== true),
      ),
    ).toBe(true);
  });

  it("case 4: a deleted rollout drops out of the breadcrumb's state with no warning", async () => {
    const gone = await scanTree();
    const rollout = gone.tree.path(
      "home/.codex/sessions/2026/02/01/rollout-2026-02-01T10-00-00-00000000-0000-4000-8000-000000000003.jsonl",
    );
    const { rm } = await import("node:fs/promises");
    await rm(rollout);
    const index = await scan({
      home: gone.tree.home,
      roots: gone.tree.roots,
      cwd: gone.tree.cwd,
      platform: PLATFORM,
      env: gone.tree.env,
      git: false,
      now: NOW,
      harnesses: ["codex"],
    });
    const crumbAfter = index.breadcrumbs.find(
      (item) => item.kind === "session-cwd" && item.raw === treePaths(gone.tree).root("gone"),
    );
    expect(crumbAfter?.state).toEqual([]);
    expect(index.warnings.map((item) => item.code)).toEqual(["git-missing"]);
    await gone.tree.cleanup();
  });

  it("case 6: history.jsonl and session_index.jsonl are state, never breadcrumb sources", () => {
    expect(result.breadcrumbs.some((item) => item.raw.includes("history.jsonl"))).toBe(false);
    const history = cache(home(".codex/history.jsonl"));
    expect(history.rule).toBe("kept");
    expect(history.cacheKind).toBe("log");
    // Every prompt ever typed: user content, so `clean` never touches it unattended.
    expect(history.userContent).toBe(true);
    expect(history.retention.source).toBe("history.max_bytes");
    expect(history.removal).toEqual({ method: "trash" });
    const index = cache(home(".codex/session_index.jsonl"));
    expect(index.rule).toBe("undocumented");
    expect(index.protection).toBe("undocumented");
    expect(index.removal).toEqual({ method: "none" });
  });

  it("case 7: the instruction chain, its shadows and the 32 KiB cap", () => {
    const user = loadedBy("context-file", home(".codex/AGENTS.md"));
    expect(user.mode).toBe("full");
    expect(user.order).toBe(0);
    expect(user.project).toBeNull();
    expect(user.countsTowardHeadline).toBe(true);
    const override = loadedBy("context-file", home(".codex/AGENTS.override.md"));
    expect(override.mode).toBe("never");
    expect(override.reason).toBe("empty file: Codex skips it");
    // In a Project the override wins and the `AGENTS.md` beside it is shadowed, with an edge.
    const projectOverride = loadedBy("context-file", root("project-a/AGENTS.override.md"));
    expect(projectOverride.mode).toBe("full");
    expect(projectOverride.order).toBe(0);
    expect(entity("context-file", root("project-a/AGENTS.override.md")).scope).toBe("local");
    expect(
      entity("context-file", root("project-a/AGENTS.override.md")).kind === "context-file",
    ).toBe(true);
    const shadowed = loadedBy("context-file", root("project-a/AGENTS.md"));
    expect(shadowed.mode).toBe("shadowed");
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "shadows" &&
          edge.from === id("context-file", root("project-a/AGENTS.override.md")) &&
          edge.to === id("context-file", root("project-a/AGENTS.md")) &&
          edge.rule === "AGENTS.override.md > AGENTS.md > project_doc_fallback_filenames",
      ),
    ).toBe(true);
    // From outside the Project the nested file is read only by sessions started there.
    const belowSession = loadedBy("context-file", root("project-a/packages/x/AGENTS.md"));
    expect(belowSession.mode).toBe("full");
    expect(belowSession.countsTowardHeadline).toBe(false);
    expect(belowSession.reason).toBe(
      "loaded by sessions started in packages/x (Codex walks root→cwd once, no lazy loading)",
    );
    // D58: an untrusted Project still loads its `AGENTS.md`; only `.codex/` layers are gated.
    const untrusted = loadedBy("context-file", root("project-b/AGENTS.md"));
    expect(untrusted.mode).toBe("full");
    expect(untrusted.reason).toBe("AGENTS.md of the project root");
  });

  it("case 7: a session inside packages/x pins the chain order and the cap", () => {
    const chainOf = (path: string): LoadedByEdge =>
      nested.result.edges.find(
        (edge): edge is LoadedByEdge =>
          edge.kind === "loaded-by" && edge.from === id("context-file", path),
      ) ??
      (() => {
        throw new Error(`no verdict for ${path}`);
      })();
    const nestedRoot = treePaths(nested.tree).root;
    const rootFile = chainOf(nestedRoot("project-a/AGENTS.override.md"));
    const leaf = chainOf(nestedRoot("project-a/packages/x/AGENTS.md"));
    expect(rootFile.order).toBe(0);
    expect(rootFile.reason).toBe("AGENTS.override.md of the project root");
    expect(leaf.order).toBe(1);
    expect(leaf.reason).toBe("AGENTS.md of the session directory");
    expect(leaf.countsTowardHeadline).toBe(true);
    // 441 + 111 + 222 bytes are far inside `project_doc_max_bytes = 32768`: nothing is dropped.
    expect(nested.result.harnesses[0]?.caps.chainMaxBytes).toBe(32_768);
    expect(
      nested.result.edges.some(
        (edge) => edge.kind === "loaded-by" && edge.reason.startsWith("beyond "),
      ),
    ).toBe(false);
  });

  it("D58: the user file counts against the cap and the file that crosses it is excluded whole", () => {
    // The chain stops at the first file that would cross, and every later file stops with it.
    expect(applyChainCap([10, 10, 10], 0, 32_768)).toEqual([true, true, true]);
    expect(applyChainCap([100, 100], 32_700, 32_768)).toEqual([false, false]);
    expect(applyChainCap([60, 20], 32_700, 32_768)).toEqual([true, false]);
    expect(applyChainCap([60, 5], 32_700, 32_768)).toEqual([true, true]);
    expect(applyChainCap([68], 32_700, 32_768)).toEqual([true]);
    expect(applyChainCap([69], 32_700, 32_768)).toEqual([false]);
  });

  it("case 8: memories are one exempt unit, shown and never acted on", () => {
    const index = entity("memory-file", home(".codex/memories/MEMORY.md"));
    const fact = entity("memory-file", home(".codex/memories/memory-a.md"));
    expect(index.kind === "memory-file" && index.role).toBe("index");
    expect(fact.kind === "memory-file" && fact.role).toBe("fact");
    expect(fact.metrics.ageDays).toBe(90);
    for (const file of [index, fact]) {
      expect(file.protection).toBe("never");
      expect(file.removal).toEqual({ method: "none" });
      expect(file.ownership).toBe("harness");
      expect(file.kind === "memory-file" && file.unit).toBe(home(".codex/memories"));
      expect(file.kind === "memory-file" && file.owner).toBe("global");
      expect(file.kind === "memory-file" && file.readSignal).toEqual({
        source: "none",
        exact: false,
        bashParsed: false,
      });
    }
    const verdict = loadedBy("memory-file", home(".codex/memories/MEMORY.md"));
    expect(verdict.mode).toBe("unknown");
    expect(verdict.reason).toBe(
      "features.memories = true; Codex documents no loading rule or cap for memory files",
    );
    expect(verdict.countsTowardHeadline).toBe(false);
    // D109: no `memories_1.sqlite` in this case, so no database row for it either.
    expect(result.entities.some((item) => item.path.includes("memories_1.sqlite"))).toBe(false);
    expect(result.entities.filter((item) => item.kind === "memory-file")).toHaveLength(2);
  });

  it("case 9: three skill generations, one entity per real directory", () => {
    const shared = entity("skill", home(".agents/skills/find-skills"));
    if (shared.kind !== "skill") throw new Error("not a skill");
    // The store belongs to no harness; the link under `$CODEX_HOME` is the harness's placement.
    expect(shared.harness).toBeNull();
    expect(shared.layout).toBe("canonical");
    expect(shared.placements.map((item) => [item.path, item.harness, item.isSymlink])).toEqual([
      [home(".agents/skills/find-skills"), null, false],
      [home(".codex/skills/find-skills"), "codex", true],
    ]);
    expect(shared.placements[1]?.linkTarget).toBe("../../.agents/skills/find-skills");
    // Discovery order 3 (`$CODEX_HOME/skills`) reaches it before order 4 (`~/.agents/skills`).
    const sharedVerdict = loadedBy("skill", home(".agents/skills/find-skills"));
    expect(sharedVerdict.placement).toBe(home(".codex/skills/find-skills"));
    expect(sharedVerdict.mode).toBe("description-only");
    expect(sharedVerdict.reason).toBe("user skill");

    // Two real directories of one public skill: two entities, a `name` duplicate, no shadowing.
    const userCopy = entity("skill", home(".codex/skills/vercel-react-best-practices"));
    const projectCopy = entity(
      "skill",
      root("project-a/.codex/skills/vercel-react-best-practices"),
    );
    if (userCopy.kind !== "skill" || projectCopy.kind !== "skill") throw new Error("not skills");
    expect(userCopy.sidecars).toEqual(["agents/openai.yaml"]);
    expect(userCopy.contentHash[0]?.algo).toBe("sha256-folder");
    expect(userCopy.contentHash[0]?.value).not.toBe(projectCopy.contentHash[0]?.value);
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "duplicates" &&
          edge.same === "name" &&
          edge.confidence === "medium" &&
          edge.from === userCopy.id &&
          edge.to === projectCopy.id,
      ),
    ).toBe(true);
    expect(result.edges.some((edge) => edge.kind === "shadows" && edge.from === userCopy.id)).toBe(
      false,
    );
    // `allow_implicit_invocation: true` keeps the description in the listing.
    expect(loadedBy("skill", home(".codex/skills/vercel-react-best-practices")).mode).toBe(
      "description-only",
    );
    // A skill payload's `AGENTS.md` is part of the skill's bytes, never a context file.
    expect(
      result.entities.some(
        (item) => item.kind === "context-file" && item.path.includes("vercel-react-best-practices"),
      ),
    ).toBe(false);
    expect(userCopy.metrics.bytes).toBeGreaterThan(64_360);

    // The bundled `.system` tier: harness-owned, never actionable, never in the Headline.
    const bundled = entity("skill", home(".codex/skills/.system/skill-creator"));
    if (bundled.kind !== "skill") throw new Error("not a skill");
    expect(bundled.layout).toBe("bundled");
    expect(bundled.ownership).toBe("harness");
    expect(bundled.protection).toBe("never");
    expect(bundled.removal).toEqual({ method: "none" });
    const bundledVerdict = loadedBy("skill", home(".codex/skills/.system/skill-creator"));
    expect(bundledVerdict.mode).toBe("description-only");
    expect(bundledVerdict.countsTowardHeadline).toBe(false);
    // The marker beside it is not an entity.
    expect(result.entities.some((item) => item.path.endsWith(".codex-system-skills.marker"))).toBe(
      false,
    );

    // The universal project location: `harness: null` placement, project scope.
    const projectStore = entity("skill", root("project-a/.agents/skills/skill-b"));
    if (projectStore.kind !== "skill") throw new Error("not a skill");
    expect(projectStore.placements[0]?.harness).toBeNull();
    expect(projectStore.scope).toBe("project");
    expect(loadedBy("skill", root("project-a/.agents/skills/skill-b")).reason).toBe(
      "project skill",
    );
  });

  it("case 10: the desktop state file, its backup clone and its unfinished write", () => {
    const state = entity("settings-file", home(".codex/.codex-global-state.json"));
    if (state.kind !== "settings-file") throw new Error("not a settings file");
    expect(state.role).toBe("state");
    expect(state.producer).toEqual({ harness: "codex", surface: "desktop" });
    expect(state.topLevelKeys).toEqual([
      "active-workspace-roots",
      "local-projects",
      "pinned-thread-ids",
    ]);
    expect(state.entries).toBe(2);
    expect(state.protection).toBe("never");
    expect(state.removal).toEqual({ method: "none" });
    // D55: the backup clone is tickable (trash), never preselected.
    const backup = cache(home(".codex/.codex-global-state.json.bak"));
    expect(backup.cacheKind).toBe("config-backup");
    expect(backup.rule).toBe("undocumented");
    expect(backup.protection).toBe("none");
    expect(backup.removal).toEqual({ method: "trash" });
    expect(backup.surface).toBe("desktop");
    expect(backup.metrics.ageDays).toBe(40);
    const leftover = result.entities.find(
      (item) =>
        item.kind === "harness-cache" && item.path.includes("..codex-global-state.json.tmp-"),
    );
    expect(leftover?.protection).toBe("undocumented");
    expect(leftover?.removal).toEqual({ method: "none" });
    // `local-projects` names `<ROOT>/gone`, but it is a `readInV1: false` source: no breadcrumb.
    expect(
      result.breadcrumbs.some(
        (item) => item.locator.type === "file" && item.locator.path === state.path,
      ),
    ).toBe(false);
    expect(result.breadcrumbs.filter((item) => item.kind === "workspace-record")).toHaveLength(0);
  });

  it("reads MCP configuration for key names and sanitised endpoints only", () => {
    const stdio = entity("mcp-server", `${home(".codex/config.toml")}#mcp_servers/x`);
    if (stdio.kind !== "mcp-server") throw new Error("not an MCP server");
    expect(stdio.transport).toBe("stdio");
    expect(stdio.envKeys).toEqual(["EXAMPLE_VAR"]);
    expect(stdio.secretKeys).toEqual([]);
    // `cwd` stays a raw key name and never becomes a breadcrumb.
    expect(stdio.rawKeys).toContain("cwd");
    expect(stdio.rawKeys).toContain("tools");
    expect(stdio.removal).toEqual({ method: "delegate", command: "codex mcp remove x" });
    expect(loadedBy("mcp-server", `${home(".codex/config.toml")}#mcp_servers/x`).mode).toBe("full");
    const http = entity("mcp-server", `${home(".codex/config.toml")}#mcp_servers/y`);
    if (http.kind !== "mcp-server") throw new Error("not an MCP server");
    expect(http.transport).toBe("http");
    expect(http.hasOauth).toBe(true);
    expect(http.headerKeys).toEqual(["Authorization"]);
    expect(http.secretKeys).toEqual(["Authorization"]);
    expect(http.sensitive).toBe(true);
    // D60: outside the user configuration moldig neither edits TOML nor delegates.
    const project = entity(
      "mcp-server",
      `${root("project-a/.codex/config.toml")}#mcp_servers/project-server`,
    );
    if (project.kind !== "mcp-server") throw new Error("not an MCP server");
    expect(project.approval).toBe("approved");
    expect(project.removal).toEqual({ method: "none" });
    expect(
      loadedBy("mcp-server", `${root("project-a/.codex/config.toml")}#mcp_servers/project-server`)
        .reason,
    ).toBe("project scope: trusted project");
    expect(
      result.projects.find((item) => item.id === id("project", root("project-a")))?.perHarness[
        "codex"
      ]?.effectiveSettings["project_doc_max_bytes"],
    ).toBe(32_768);
  });

  it("lists the rules, hooks and databases as ticket 08 does", () => {
    for (const path of [
      home(".codex/rules/default.rules"),
      root("project-a/.codex/rules/default.rules"),
    ]) {
      const rules = entity("settings-file", path);
      if (rules.kind !== "settings-file") throw new Error("not a settings file");
      expect(rules.role).toBe("policy");
      expect(rules.format).toBe("starlark");
      expect(rules.entries).toBe(3);
    }
    const userHooks = entity("settings-file", home(".codex/hooks.json"));
    if (userHooks.kind !== "settings-file") throw new Error("not a settings file");
    expect(userHooks.role).toBe("hooks");
    expect(userHooks.hooks.map((hook) => hook.event)).toEqual(["SessionStart", "PreToolUse"]);
    const projectHooks = entity("settings-file", root("project-a/.codex/hooks.json"));
    if (projectHooks.kind !== "settings-file") throw new Error("not a settings file");
    expect(projectHooks.hooks.map((hook) => hook.event)).toEqual([
      "UserPromptSubmit",
      "PreToolUse",
    ]);
    // D104: a database is `kept` in the `rule` column and `never` in the `protection` column.
    const database = cache(home(".codex/state_5.sqlite"));
    expect(database.cacheKind).toBe("database");
    expect(database.unit).toBe("database");
    expect(database.rule).toBe("kept");
    expect(database.protection).toBe("never");
    expect(database.removal).toEqual({ method: "none" });
    expect(database.locator).toEqual({ type: "file", path: home(".codex/state_5.sqlite") });
    // The undocumented size-only rows, and the empty `log/` unit that exists before its first line.
    const shellSnapshots = cache(home(".codex/shell_snapshots"));
    expect(shellSnapshots.cacheKind).toBe("shell-snapshot");
    expect(shellSnapshots.surface).toBeNull();
    expect(shellSnapshots.protection).toBe("undocumented");
    expect(cache(home(".codex/version.json")).cacheKind).toBe("undocumented");
    const log = cache(home(".codex/log"));
    expect(log.rule).toBe("kept");
    expect(log.metrics.bytes).toBe(0);
    // `version.json` is a cache row, never the harness version.
    expect(result.harnesses[0]?.version).not.toBe("0.0.0");
  });

  it("CODEX_HOME moves the user scope and changes nothing else", async () => {
    // One tree, two scans: only the environment differs, so any other difference is the adapter's.
    const own = await scanTree();
    const codexHome = treePaths(own.tree).home(".codex");
    try {
      const moved = await scan({
        home: own.tree.home,
        roots: own.tree.roots,
        cwd: own.tree.cwd,
        platform: PLATFORM,
        env: { CODEX_HOME: codexHome },
        git: false,
        now: NOW,
        harnesses: ["codex"],
      });
      expect(moved.scan.env).toEqual({ CODEX_HOME: codexHome });
      expect(moved.harnesses[0]?.userScope.paths).toEqual([
        { path: codexHome, role: "data", source: "env", envVar: "CODEX_HOME" },
      ]);
      expect(own.result.harnesses[0]?.userScope.paths[0]?.source).toBe("default");
      expect(indexBody(moved)).toBe(indexBody(own.result));
    } finally {
      await own.tree.cleanup();
    }
  });

  it("a zero-byte state_5.sqlite warns once and leaves the trust entries standing", async () => {
    const broken = await scanTree();
    try {
      await writeFile(broken.tree.path("home/.codex/state_5.sqlite"), "");
      const index = await scan({
        home: broken.tree.home,
        roots: broken.tree.roots,
        cwd: broken.tree.cwd,
        platform: PLATFORM,
        env: broken.tree.env,
        git: false,
        now: NOW,
        harnesses: ["codex"],
      });
      const unreadable = index.warnings.filter((item) => item.code === "sqlite-unreadable");
      expect(unreadable).toHaveLength(1);
      expect(unreadable[0]?.harness).toBe("codex");
      expect(unreadable[0]?.path).toBe(broken.tree.path("home/.codex/state_5.sqlite"));
      // The trust map still resolves: one unreadable source never costs the others.
      expect(index.breadcrumbs.filter((item) => item.kind === "trust-entry")).toHaveLength(6);
      expect(index.breadcrumbs.filter((item) => item.kind === "session-cwd")).toHaveLength(0);
      expect(index.harnesses[0]?.version).toBeNull();
    } finally {
      await broken.tree.cleanup();
    }
  });

  it("leaves the tree exactly as it found it", async () => {
    const untouched = await scanTree();
    try {
      const before = await treeState(untouched.tree.dir);
      await scan({
        home: untouched.tree.home,
        roots: untouched.tree.roots,
        cwd: untouched.tree.cwd,
        platform: PLATFORM,
        env: untouched.tree.env,
        git: false,
        now: NOW,
        harnesses: ["codex"],
      });
      const after = await treeState(untouched.tree.dir);
      expect(mtimeRows(after)).toEqual(mtimeRows(before));
      // `?immutable=1` is what keeps a WAL-flagged database from growing sidecars beside it.
      for (const suffix of ["-wal", "-shm"]) {
        expect(after.has(untouched.tree.path("home/.codex/state_5.sqlite") + suffix)).toBe(false);
      }
    } finally {
      await untouched.tree.cleanup();
    }
  });

  it("files the audit findings the case earns", () => {
    // Two copies of one skill that differ are both a duplicate and a drift finding (D80).
    expect(result.findings.map((finding) => finding.category)).toEqual([
      "drift",
      "drift",
      "duplicate",
      "duplicate",
      "harness-cache",
      "orphan",
    ]);
    const orphan = result.findings.find((finding) => finding.category === "orphan");
    expect(orphan?.container).toBe(id("project", root("gone")));
    expect(orphan?.targets.filter((target) => target.role === "breadcrumb")).toHaveLength(2);
    const headline = result.headline;
    expect(headline.perHarness[0]?.harness).toBe("codex");
    expect(headline.perHarness[0]?.pctOfContext).toBeNull();
    expect(headline.perHarness[0]?.baseline.mid).toBeGreaterThan(0);
  });

  it("D147: a tree with no trace of Codex gets no Harness row, no verdicts, no warnings", async () => {
    // `shared/root-tree` has `AGENTS.md` files and a `.agents/skills` store but no `$CODEX_HOME`
    // and no `.codex/` layer: a machine with two harnesses must not read as a machine with six.
    const other = await loadFixture("shared/root-tree", { now: NOW, platform: PLATFORM });
    try {
      const index = await scan({
        home: other.home,
        roots: other.roots,
        cwd: other.root,
        platform: PLATFORM,
        env: other.env,
        git: false,
        now: NOW,
        harnesses: ["codex"],
      });
      expect(index.harnesses).toEqual([]);
      expect(index.breadcrumbs).toEqual([]);
      // The shared stores adapter always runs (D21), so the tree's `AGENTS.md` files and its
      // store are still indexed; none of it belongs to this harness or carries its verdict.
      expect(index.entities.every((item) => item.harness === null)).toBe(true);
      expect(index.edges.every((edge) => edge.to !== "harness:codex")).toBe(true);
      // The only warning is the one `scan` itself files for `git: false`.
      expect(index.warnings.map((item) => item.code)).toEqual(["git-missing"]);
      expect(index.projects.every((project) => project.perHarness["codex"] === undefined)).toBe(
        true,
      );
    } finally {
      await other.cleanup();
    }
  });

  it("matches the audit snapshot", async () => {
    const stable = normaliseSnapshot(result, tree);
    stable.scan.durationMs = 0;
    stable.moldig.version = "<VERSION>";
    await expect(stableTimes(formattedJson(stable) + "\n")).toMatchFileSnapshot(
      "./__snapshots__/trust-and-state.audit.json",
    );
  });
});
