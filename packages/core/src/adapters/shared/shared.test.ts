/**
 * The shared-stores adapter (ticket 22): the canonical stores and their locks, `AGENTS.md` as one
 * file with N readers, the placements a Skill collects across harnesses, the git tree hash moldig
 * recomputes in pure JavaScript, and the cross-adapter merge that keeps all of it one entity.
 */
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit, scan } from "../../index.js";
import type {
  AuditIndex,
  ContextFile,
  Entity,
  Placement,
  SettingsFile,
  Skill,
} from "../../index/types.js";
import { mergeOutputs } from "../../scan/assemble.js";
import {
  loadFixture,
  normaliseSnapshot,
  treePaths,
  type FixtureTree,
  type TreePaths,
  fixtureCopyTime,
  POSIX_FIXTURE_HOST,
} from "../../testing/index.js";
import type { AdapterOutput } from "../adapter.js";
import { gitTreeSha1 } from "./hashes.js";

/** After every synthetic timestamp the shared cases carry (2026-02-01 at the latest). */
const NOW = new Date("2026-08-26T12:00:00.000Z");
const PLATFORM = "darwin";
const ISO_ANYWHERE = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;
const DATE_ANYWHERE = /(?<![\dT:-])\d{4}-\d{2}-\d{2}(?![\dT])/g;

/** Copy-time stamps differ per run; stamps the case fixed on `NOW`'s day grid stay. */
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

async function auditFixture(tree: FixtureTree): Promise<AuditIndex> {
  return audit(
    await scan({
      home: tree.home,
      roots: tree.roots,
      cwd: tree.cwd,
      platform: PLATFORM,
      env: tree.env,
      git: false,
      now: NOW,
    }),
  );
}

function finder(result: () => AuditIndex, tree: () => FixtureTree) {
  const { id } = treePaths(tree);
  const entity = (kind: string, path: string): Entity => {
    const found = result().entities.find((item) => item.id === id(kind, path));
    if (found === undefined) throw new Error(`entity not found: ${id(kind, path)}`);
    return found;
  };
  return {
    entity,
    skill: (path: string): Skill => {
      const found = entity("skill", path);
      if (found.kind !== "skill") throw new Error("kind");
      return found;
    },
    contextFile: (path: string): ContextFile => {
      const found = entity("context-file", path);
      if (found.kind !== "context-file") throw new Error("kind");
      return found;
    },
    settingsFile: (path: string): SettingsFile => {
      const found = entity("settings-file", path);
      if (found.kind !== "settings-file") throw new Error("kind");
      return found;
    },
  };
}

const placementView = (item: Placement): unknown[] => [
  item.path,
  item.harness,
  item.isSymlink,
  item.linkTarget,
  item.dangling,
];

describe.runIf(POSIX_FIXTURE_HOST)("the shared stores over the skill-layouts case", () => {
  let tree: FixtureTree;
  let result: AuditIndex;
  const find = finder(
    () => result,
    () => tree,
  );
  const { home, root, id } = treePaths(() => tree);

  beforeAll(async () => {
    tree = await loadFixture("shared/skill-layouts", { now: NOW, platform: PLATFORM });
    result = await auditFixture(tree);
  });
  afterAll(async () => {
    await tree.cleanup();
  });

  it("keeps the canonical copy and the agent-dir symlink as one Skill (README edge 1)", () => {
    const stored = find.skill(home(".agents/skills/skill-a"));
    // The store belongs to no harness: it is the shared adapter's entity, not Claude's.
    expect(stored.harness).toBeNull();
    expect(stored.scope).toBe("user");
    expect(stored.layout).toBe("canonical");
    expect(stored.removal).toEqual({ method: "trash" });
    expect(stored.placements.map((item) => placementView(item))).toEqual([
      [home(".agents/skills/skill-a"), null, false, null, false],
      [home(".claude/skills/skill-a"), "claude-code", true, "../../.agents/skills/skill-a", false],
    ]);
    // One Skill per real directory: the link path is a Placement, never a second entity.
    expect(
      result.entities.filter((item) => item.kind === "skill" && item.name === "skill-a"),
    ).toHaveLength(2);
  });

  it("fills the origin from the v3 lock and points originates-from at its entry", () => {
    const stored = find.skill(home(".agents/skills/skill-a"));
    expect(stored.origin).toEqual({
      installer: "vercel-skills",
      sourceType: "github",
      source: "<redacted>",
      sourceUrl: "<redacted>",
      ref: null,
      skillPath: "<redacted>",
      // `<redacted-hash>` is neither 40- nor 64-hex: moldig cannot say which algorithm it is.
      recordedHash: { algo: "unknown", value: "<redacted-hash>" },
      installedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-02-01T00:00:00.000Z",
      lock: {
        type: "entry",
        file: home(".agents/.skill-lock.json"),
        format: "json",
        keyPath: ["skills", "skill-a"],
      },
    });
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === "originates-from" &&
          edge.from === stored.id &&
          edge.to === id("settings-file", home(".agents/.skill-lock.json")),
      ),
    ).toBe(true);
  });

  it("emits both lock schemas as skill-lock settings files no harness owns (README edge 5)", () => {
    const global = find.settingsFile(home(".agents/.skill-lock.json"));
    expect(global.role).toBe("skill-lock");
    expect(global.harness).toBeNull();
    expect(global.scope).toBe("user");
    expect(global.entries).toBe(2);
    expect(global.protection).toBe("never");
    expect(global.removal).toEqual({ method: "none" });
    expect(global.topLevelKeys).toEqual(["version", "skills", "lastSelectedAgents"]);

    const project = find.settingsFile(root("project-a/skills-lock.json"));
    expect(project.role).toBe("skill-lock");
    expect(project.scope).toBe("project");
    expect(project.entries).toBe(2);
    // Both files declare the version their name documents: no `unsupported-shape` warning.
    expect(result.warnings.filter((item) => item.code === "unsupported-shape")).toEqual([]);
  });

  it("leaves an unlocked real copy in the agent dir to its harness (README edge 2)", () => {
    const copy = find.skill(home(".claude/skills/skill-b"));
    expect(copy.harness).toBe("claude-code");
    expect(copy.layout).toBe("copy");
    expect(copy.origin).toBeNull();
    expect(copy.drift).toBe("unknown");
    expect(copy.placements).toHaveLength(1);
  });

  it("pairs the two copies of one origin and files them as drifted (README edge 4)", () => {
    const stored = find.skill(home(".agents/skills/skill-a"));
    const copy = find.skill(root("project-a/.claude/skills/skill-a"));
    // D43: inside a harness's own skills directory *and* recorded by a lock.
    expect(copy.layout).toBe("synced");
    expect(copy.origin?.lock).toEqual({
      type: "entry",
      file: root("project-a/skills-lock.json"),
      format: "json",
      keyPath: ["skills", "skill-a"],
    });
    const edge = result.edges.find((item) => item.kind === "duplicates");
    expect(edge).toMatchObject({
      from: stored.id,
      to: copy.id,
      same: "origin",
      // D79: `high` for one origin.
      confidence: "high",
    });
    // Different bytes on both sides and no lock hash moldig can reproduce: copies-differ (D80).
    expect([stored.drift, copy.drift]).toEqual(["copies-differ", "copies-differ"]);
    expect(stored.contentHash.map((item) => item.algo)).toEqual(["sha256-folder"]);
    expect(stored.contentHash[0]?.value).not.toBe(copy.contentHash[0]?.value);
    expect(result.findings.find((item) => item.category === "duplicate")?.message).toContain(
      "same origin",
    );
  });

  it("files a lock entry whose directory is gone as an orphan, at both scopes (README edge 3)", () => {
    const orphans = result.findings.filter(
      (item) => item.category === "orphan" && item.id.endsWith(":skill-c"),
    );
    expect(orphans.map((item) => item.targets[0]?.locator)).toEqual([
      {
        type: "entry",
        file: home(".agents/.skill-lock.json"),
        format: "json",
        keyPath: ["skills", "skill-c"],
      },
      {
        type: "entry",
        file: root("project-a/skills-lock.json"),
        format: "json",
        keyPath: ["skills", "skill-c"],
      },
    ]);
    // `skill-c` never becomes an entity: nothing on disk carries that name.
    expect(result.entities.some((item) => item.path.endsWith("skill-c"))).toBe(false);
  });

  it("matches the audit snapshot", async () => {
    const stable = normaliseSnapshot(result, tree);
    stable.scan.durationMs = 0;
    stable.moldig.version = "<VERSION>";
    await expect(stableTimes(formattedJson(stable) + "\n")).toMatchFileSnapshot(
      "./__snapshots__/skill-layouts.audit.json",
    );
  });
});

describe("the shared stores over the root-tree case", () => {
  let tree: FixtureTree;
  let result: AuditIndex;
  const find = finder(
    () => result,
    () => tree,
  );
  const { root, id } = treePaths(() => tree);

  beforeAll(async () => {
    tree = await loadFixture("shared/root-tree", { now: NOW, platform: PLATFORM });
    result = await auditFixture(tree);
  });
  afterAll(async () => {
    await tree.cleanup();
  });

  it("owns every AGENTS.md of a Project, root and nested, with no harness of its own", () => {
    const rootFile = find.contextFile(root("monorepo/AGENTS.md"));
    expect(rootFile.harness).toBeNull();
    expect(rootFile.form).toBe("context");
    expect(rootFile.fileName).toBe("AGENTS.md");
    expect(rootFile.scope).toBe("project");
    expect(rootFile.ownership).toBe("human");
    expect(rootFile.removal).toEqual({ method: "trash" });
    expect(rootFile.relativePath).toBe("AGENTS.md");

    const nested = find.contextFile(root("monorepo/apps/api/AGENTS.md"));
    expect(nested.relativePath).toBe("apps/api/AGENTS.md");
    expect(nested.project).toBe(id("project", root("monorepo")));
    // The nested marker the Root walk recorded now names the entity behind it.
    const monorepo = result.projects.find((item) => item.id === id("project", root("monorepo")));
    expect(monorepo?.nestedMarkers).toContainEqual({
      relativePath: "apps/api/AGENTS.md",
      marker: "AGENTS.md",
      entity: nested.id,
    });
  });

  it("emits no loaded-by edge of its own: every reader's verdict is its adapter's", () => {
    const rootFile = find.contextFile(root("monorepo/AGENTS.md"));
    // Claude Code does not read AGENTS.md (06 §14), and it is the only harness adapter here.
    expect(result.edges.filter((edge) => edge.from === rootFile.id)).toEqual([]);
    expect(result.harnesses.map((item) => item.harness)).toEqual(["claude-code"]);
  });

  it("reads a Project's own store and never mistakes a skill's AGENTS.md for context", () => {
    const skill = find.skill(root("monorepo/.agents/skills/skill-a"));
    expect(skill.harness).toBeNull();
    expect(skill.scope).toBe("project");
    expect(skill.layout).toBe("canonical");
    expect(skill.origin).toBeNull();
    expect(skill.placements.map((item) => placementView(item))).toEqual([
      [root("monorepo/.agents/skills/skill-a"), null, false, null, false],
    ]);
    // `<store>/<skill>/AGENTS.md` is payload; the walk stops at a directory holding a SKILL.md.
    expect(
      result.entities.some(
        (item) => item.path === root("monorepo/.agents/skills/skill-a/AGENTS.md"),
      ),
    ).toBe(false);
  });

  it("never reports a pruned, symlinked or too-deep file", () => {
    const paths = result.entities.map((item) => item.path);
    expect(paths.some((path) => path.includes("/node_modules/"))).toBe(false);
    expect(paths.some((path) => path.includes("/dist/"))).toBe(false);
    expect(paths.some((path) => path.includes("/vendor/"))).toBe(false);
    expect(paths.some((path) => path.includes("/link-to-monorepo/"))).toBe(false);
    expect(paths.some((path) => path.includes("/deep/"))).toBe(false);
    // `bare/` carries no marker: not a Project, so its files are never walked either.
    expect(paths.some((path) => path.includes("/bare/"))).toBe(false);
  });

  it("matches the audit snapshot", async () => {
    const stable = normaliseSnapshot(result, tree);
    stable.scan.durationMs = 0;
    stable.moldig.version = "<VERSION>";
    await expect(stableTimes(formattedJson(stable) + "\n")).toMatchFileSnapshot(
      "./__snapshots__/root-tree.audit.json",
    );
  });
});

describe.runIf(POSIX_FIXTURE_HOST)("the shared stores beside a harness adapter", () => {
  let tree: FixtureTree;
  let result: AuditIndex;
  const find = finder(
    () => result,
    () => tree,
  );
  const { home, root } = treePaths(() => tree);

  beforeAll(async () => {
    tree = await loadFixture("claude-code/skills-and-plugins", {
      cwd: "root/project-b",
      now: NOW,
      platform: PLATFORM,
    });
    result = await audit(
      await scan({
        home: tree.home,
        roots: tree.roots,
        cwd: tree.cwd,
        platform: PLATFORM,
        env: tree.env,
        git: false,
        now: NOW,
        harnesses: ["claude-code"],
        isProcessAlive: () => false,
      }),
    );
  });
  afterAll(async () => {
    await tree.cleanup();
  });

  it("folds a store directory both adapters reach into one Skill with both placements", () => {
    const stored = find.skill(home(".agents/skills/skill-a"));
    expect(result.entities.filter((item) => item.id === stored.id)).toHaveLength(1);
    // The shared adapter owns the row (D38) — hashes, origin and layout are its own …
    expect(stored.harness).toBeNull();
    expect(stored.layout).toBe("canonical");
    expect(stored.contentHash.map((item) => item.algo)).toEqual(["sha256-folder"]);
    // … and Claude Code contributes the placement it reaches it through, plus its verdict.
    expect(stored.placements.map((item) => placementView(item))).toEqual([
      [home(".agents/skills/skill-a"), null, false, null, false],
      [home(".claude/skills/skill-a"), "claude-code", true, "../../.agents/skills/skill-a", false],
    ]);
    expect(result.edges.some((edge) => edge.kind === "loaded-by" && edge.from === stored.id)).toBe(
      true,
    );

    // The same fold at project scope: the store directory plus the link inside `.claude/skills`.
    const projectStore = find.skill(root("project-b/.agents/skills/skill-c"));
    expect(projectStore.harness).toBeNull();
    expect(projectStore.placements.map((item) => item.harness)).toEqual([null, "claude-code"]);
  });

  it("keeps a store nothing links as one Skill with its origin and no orphan row", () => {
    // 06 §15: the canonical store is read directly by Codex, Cursor, Gemini CLI, Copilot and
    // OpenCode, so a directory Claude Code happens not to link is not an Orphan.
    const orphan = find.skill(home(".agents/skills/skill-orphan"));
    expect(orphan.placements.map((item) => item.harness)).toEqual([null]);
    expect(orphan.origin?.installer).toBe("vercel-skills");
    expect(result.findings.some((item) => item.id.endsWith(":skill-orphan"))).toBe(false);
  });

  it("keeps a dangling link as one Skill with dangling placements and one orphan finding", () => {
    const dangling = find.skill(home(".claude/skills/skill-dangling"));
    expect(dangling.placements.every((item) => item.dangling)).toBe(true);
    expect(dangling.metrics.bytes).toBe(0);
    expect(dangling.contentHash).toEqual([]);
    // 07: the link points into the store, so the directory it *meant* decides the layout.
    expect(dangling.layout).toBe("canonical");
    const targetsIt = (target: { id?: string; locator?: { type: string } }): boolean =>
      target.id === dangling.id ||
      (target.locator?.type === "dir" &&
        "path" in target.locator &&
        target.locator.path === dangling.path);
    const findings = result.findings.filter(
      (item) => item.category === "orphan" && item.targets.some((target) => targetsIt(target)),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence[0]?.detail).toBe("../../.agents/skills/skill-dangling");
  });
});

describe("the lock reader", () => {
  it("warns once, and only once, when a lock declares a version its shape denies", async () => {
    // The captured lock says `version: 1` with v3 entry keys: a shape moldig reads by field name
    // and never guesses at (06 §13).
    const tree = await loadFixture("opencode/db-and-config", { now: NOW, platform: PLATFORM });
    const { home, id } = treePaths(tree);
    try {
      const result = await auditFixture(tree);
      const unsupported = result.warnings.filter((item) => item.code === "unsupported-shape");
      expect(unsupported).toHaveLength(1);
      expect(unsupported[0]).toMatchObject({
        harness: null,
        path: home(".agents/.skill-lock.json"),
        effect: "degraded",
      });
      // Degraded, not skipped: the entries are still read, and still fill an origin.
      const stored = result.entities.find(
        (item) => item.id === id("skill", home(".agents/skills/find-skills")),
      );
      expect(stored?.kind === "skill" && stored.origin?.installer).toBe("vercel-skills");
      // A `<redacted>` sourceType is not a value index v0 names.
      expect(stored?.kind === "skill" && stored.origin?.sourceType).toBe("unknown");
    } finally {
      await tree.cleanup();
    }
  });
});

/** git's blob object, spelled out from the format git documents. */
function blob(bytes: Buffer | string): string {
  return createHash("sha1")
    .update(
      Buffer.concat([
        Buffer.from(`blob ${Buffer.byteLength(bytes)}\0`, "utf8"),
        Buffer.from(bytes),
      ]),
    )
    .digest("hex");
}

/** git's tree object: `<mode> <name>\0<20 raw bytes>`, entries sorted, dirs sorted as `name/`. */
function treeObject(entries: { mode: string; name: string; sha: string }[]): string {
  const body = Buffer.concat(
    entries
      .toSorted((a, b) => {
        const ka = a.mode === "40000" ? `${a.name}/` : a.name;
        const kb = b.mode === "40000" ? `${b.name}/` : b.name;
        return ka < kb ? -1 : 1;
      })
      .map((entry) =>
        Buffer.concat([
          Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"),
          Buffer.from(entry.sha, "hex"),
        ]),
      ),
  );
  return createHash("sha1")
    .update(Buffer.concat([Buffer.from(`tree ${body.length}\0`, "utf8"), body]))
    .digest("hex");
}

describe("the git tree hash, computed in pure JavaScript", () => {
  let dir: string;
  /**
   * What the host's filesystem actually recorded for the tree this `beforeAll` built. On Windows
   * there are no POSIX permission bits — Node documents `fs.chmod` as changing the write
   * permission only there — so `run.sh` reads back `100644` and toggling the bit changes nothing;
   * a link is a real reparse point when `fs.symlink` succeeds and an `EPERM` when it does not,
   * never a silent copy, but the entry is read back rather than assumed either way.
   *
   * That the mode is unavailable is precisely why D44 never asks for a git tree hash on win32.
   * The expectations below therefore assert git's formula over the tree the host really holds —
   * the assertion is unchanged, only its input stops assuming POSIX.
   */
  let executableBit = false;
  let linkIsSymlink = true;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "moldig-tree-"));
    await writeFile(join(dir, "hello.txt"), "hello world\n");
    await writeFile(join(dir, "empty.txt"), "");
    await writeFile(join(dir, "run.sh"), "#!/bin/sh\n");
    await chmod(join(dir, "run.sh"), 0o755);
    executableBit = ((await stat(join(dir, "run.sh"))).mode & 0o111) !== 0;
    await symlink("hello.txt", join(dir, "link"));
    linkIsSymlink = (await lstat(join(dir, "link"))).isSymbolicLink();
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(join(dir, "sub", "a.md"), "a\n");
    // Never hashed: git does not store its own object database, and `skills` skips it too.
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    // Never hashed either: git cannot record a directory with no entries.
    await mkdir(join(dir, "empty-dir"), { recursive: true });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reproduces the two blob hashes git itself publishes", () => {
    // `git hash-object -t blob /dev/null` and `echo "hello world" | git hash-object --stdin`.
    expect(blob("")).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    expect(blob("hello world\n")).toBe("3b18e512dba79e4c8300dd08aeb37f8e728b8dad");
  });

  it("hashes a small tree exactly as git write-tree would", async () => {
    const expected = treeObject([
      { mode: "100644", name: "empty.txt", sha: blob("") },
      { mode: "100644", name: "hello.txt", sha: blob("hello world\n") },
      // A symlink's blob is its link text, never the file it points at.
      linkIsSymlink
        ? { mode: "120000", name: "link", sha: blob("hello.txt") }
        : { mode: "100644", name: "link", sha: blob("hello world\n") },
      {
        mode: executableBit ? "100755" : "100644",
        name: "run.sh",
        sha: blob("#!/bin/sh\n"),
      },
      {
        mode: "40000",
        name: "sub",
        sha: treeObject([{ mode: "100644", name: "a.md", sha: blob("a\n") }]),
      },
    ]);
    expect(await gitTreeSha1(dir)).toBe(expected);
  });

  it("changes when the executable bit does, which is why win32 leaves drift unknown", async (context) => {
    context.skip(!executableBit, "this host's chmod cannot set the execute bit — the D44 case");
    const before = await gitTreeSha1(dir);
    await chmod(join(dir, "hello.txt"), 0o755);
    try {
      expect(await gitTreeSha1(dir)).not.toBe(before);
    } finally {
      await chmod(join(dir, "hello.txt"), 0o644);
    }
  });

  it("is null for a directory git could store nothing of", async () => {
    expect(await gitTreeSha1(join(dir, "empty-dir"))).toBeNull();
    expect(await gitTreeSha1(join(dir, "nope"))).toBeNull();
  });
});

const fold = (path: string): string => path.toLowerCase();

function output(entities: Entity[]): AdapterOutput {
  return { harness: null, breadcrumbs: [], entities, edges: [], projectFacts: new Map() };
}

/** One `AGENTS.md`, as the adapter named by `harness` would emit it. */
function agentsFile(harness: string | null): ContextFile {
  return {
    id: "context-file:/w/p/agents.md",
    kind: "context-file",
    harness,
    producer: null,
    project: "project:/w/p",
    scope: "project",
    ownership: "human",
    shared: null,
    gitStatus: null,
    path: "/w/p/AGENTS.md",
    relativePath: "AGENTS.md",
    locator: { type: "file", path: "/w/p/AGENTS.md" },
    format: "md",
    label: "AGENTS.md",
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: {
      bytes: 10,
      files: 1,
      lines: 1,
      mtime: null,
      ageDays: null,
      tokens: null,
      lastUsed: null,
    },
    form: "context",
    fileName: "AGENTS.md",
    frontmatter: {},
    importCount: 0,
    containsMemorySection: false,
  };
}

function fakePlacement(path: string, harness: string | null): Placement {
  return {
    path,
    harness,
    surface: harness === null ? null : "cli",
    scope: "user",
    project: null,
    gitStatus: "outside-repo",
    shared: null,
    isSymlink: harness !== null,
    linkTarget: harness === null ? null : "../../.agents/skills/skill-a",
    dangling: false,
  };
}

/** One store Skill, as the adapter named by `harness` would emit it. */
function fakeSkill(harness: string | null, placements: Placement[]): Skill {
  return {
    id: "skill:/h/.agents/skills/skill-a",
    kind: "skill",
    harness,
    producer: null,
    project: null,
    scope: "user",
    ownership: "human",
    shared: null,
    gitStatus: "outside-repo",
    path: "/h/.agents/skills/skill-a",
    relativePath: null,
    locator: { type: "dir", path: "/h/.agents/skills/skill-a" },
    format: "dir",
    label: "skill-a",
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: {
      bytes: 1,
      files: 1,
      lines: 1,
      mtime: null,
      ageDays: null,
      tokens: null,
      lastUsed: null,
    },
    form: "skill-dir",
    name: "skill-a",
    dirName: "skill-a",
    frontmatterName: null,
    layout: harness === null ? "canonical" : "copy",
    placements,
    frontmatter: {},
    sidecars: [],
    contentHash: [],
    origin: null,
    drift: "unknown",
  };
}

describe("the cross-adapter merge (D38)", () => {
  it("folds one AGENTS.md two adapters reached into one entity, owned by the shared one", () => {
    // The harness adapter runs second, exactly as `scan` registers them.
    const merged = mergeOutputs([output([agentsFile(null)]), output([agentsFile("codex")])], fold);
    expect(merged.entities).toHaveLength(1);
    expect(merged.entities[0]?.harness).toBeNull();
  });

  it("unions the placements of one Skill three adapters reached", () => {
    const merged = mergeOutputs(
      [
        output([fakeSkill(null, [fakePlacement("/h/.agents/skills/skill-a", null)])]),
        output([
          fakeSkill("claude-code", [fakePlacement("/h/.claude/skills/skill-a", "claude-code")]),
        ]),
        output([fakeSkill("codex", [fakePlacement("/h/.codex/skills/skill-a", "codex")])]),
      ],
      fold,
    );
    expect(merged.entities).toHaveLength(1);
    const [only] = merged.entities;
    expect(only?.kind === "skill" && only.layout).toBe("canonical");
    expect(only?.kind === "skill" && only.placements.map((item) => item.harness)).toEqual([
      null,
      "claude-code",
      "codex",
    ]);
  });
});

/**
 * A synthetic home + root pair in a temp directory: the cases below need a lock hash moldig can
 * actually reproduce, and every committed fixture records `<redacted-hash>` on purpose.
 */
async function tempTree(): Promise<{ dir: string; home: string; root: string }> {
  // `scan` realpaths `home` and the Roots, and `/var` is a symlink to `/private/var` on darwin.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "moldig-shared-")));
  const home = join(dir, "home");
  const root = join(dir, "root");
  await mkdir(root, { recursive: true });
  await mkdir(join(home, ".agents", "skills"), { recursive: true });
  return { dir, home, root };
}

async function writeSkill(store: string, name: string, body: string): Promise<void> {
  await mkdir(join(store, name), { recursive: true });
  await writeFile(join(store, name, "SKILL.md"), body);
}

describe("origins and drift over a lock moldig can reproduce", () => {
  let dir: string;
  let home: string;
  let root: string;
  let env: Record<string, string>;
  const skillBody = "---\nname: drifted\ndescription: d\n---\n\nbody\n";

  const run = async (platform: "darwin" | "win32" = PLATFORM): Promise<AuditIndex> =>
    audit(await scan({ home, roots: [root], cwd: root, platform, env, git: false, now: NOW }));

  /** The synthetic tree as `treePaths` sees it: real host paths, the platform of the run. */
  const pathsFor = (platform: "darwin" | "win32"): TreePaths =>
    treePaths({ dir, home, root, platform, harness: "shared", slug: (path) => path });

  const storeSkill = (
    result: AuditIndex,
    name: string,
    platform: "darwin" | "win32" = PLATFORM,
  ): Skill => {
    const found = result.entities.find(
      (item) => item.id === pathsFor(platform).id("skill", join(home, ".agents", "skills", name)),
    );
    if (found?.kind !== "skill") throw new Error(`skill not found: ${name}`);
    return found;
  };

  beforeAll(async () => {
    ({ dir, home, root } = await tempTree());
    const store = join(home, ".agents", "skills");
    await writeSkill(store, "drifted", skillBody);
    await writeSkill(store, "shared-name", "---\nname: shared-name\n---\n\nx\n");
    // A skill installed by `git clone` rather than by an installer with a lock (14 §2, D42).
    await writeSkill(store, "cloned", "---\nname: cloned\n---\n\ny\n");
    await mkdir(join(store, "cloned", ".git"), { recursive: true });
    await writeFile(
      join(store, "cloned", ".git", "config"),
      '[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = https://user:token@github.com/o/r.git\n\tfetch = +refs/heads/*\n',
    );
    await writeFile(join(store, "cloned", ".git", "HEAD"), "ref: refs/heads/main\n");
    // The hash the lock records, spelled out here from git's format, never from moldig's code.
    const recorded = treeObject([{ mode: "100644", name: "SKILL.md", sha: blob(skillBody) }]);
    await writeFile(
      join(home, ".agents", ".skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: {
          drifted: { source: "o/r", sourceType: "github", skillFolderHash: recorded },
          "shared-name": { source: "from-home", sourceType: "github", skillFolderHash: recorded },
        },
      }),
    );
    // D75: `$XDG_STATE_HOME/skills/.skill-lock.json` is read in addition and wins by name.
    await mkdir(join(dir, "xdg", "skills"), { recursive: true });
    await writeFile(
      join(dir, "xdg", "skills", ".skill-lock.json"),
      JSON.stringify({
        version: 3,
        skills: { "shared-name": { source: "from-xdg", sourceType: "gitlab", ref: "v2" } },
      }),
    );
    env = { XDG_STATE_HOME: join(dir, "xdg") };
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("says drift: none while the recorded git tree hash still matches the directory", async () => {
    const skill = storeSkill(await run(), "drifted");
    expect(skill.drift).toBe("none");
    // §13: the git tree hash is computed because the lock records a 40-hex value; the folder
    // SHA-256 is the additional entry (D44).
    expect(skill.contentHash.map((item) => item.algo)).toEqual(["git-tree-sha1", "sha256-folder"]);
  });

  it("reads both locks when XDG_STATE_HOME is set, the env one winning by name (D75)", async () => {
    const result = await run();
    expect(result.scan.env["XDG_STATE_HOME"]).toBe(join(dir, "xdg"));
    const skill = storeSkill(result, "shared-name");
    expect(skill.origin?.source).toBe("from-xdg");
    // `gitlab` is not an index v0 value: §13 folds it onto `git`.
    expect(skill.origin?.sourceType).toBe("git");
    expect(skill.origin?.ref).toBe("v2");
    // Both files are still entities of their own.
    for (const path of [
      join(home, ".agents", ".skill-lock.json"),
      join(dir, "xdg", "skills", ".skill-lock.json"),
    ]) {
      const lock = result.entities.find(
        (item) => item.id === pathsFor(PLATFORM).id("settings-file", path),
      );
      expect(lock?.kind === "settings-file" && lock.role).toBe("skill-lock");
    }
  });

  it("recognises a `.git` inside a skill directory as the git-clone installer (D42)", async () => {
    expect(storeSkill(await run(), "cloned").origin).toEqual({
      installer: "git-clone",
      sourceType: "git",
      // The userinfo of the remote URL never reaches the index (D64).
      source: "https://github.com/o/r.git",
      sourceUrl: "https://github.com/o/r.git",
      ref: "main",
      skillPath: null,
      recordedHash: null,
      installedAt: null,
      updatedAt: null,
      lock: { type: "file", path: join(home, ".agents", "skills", "cloned", ".git", "config") },
    });
  });

  it("leaves drift unknown on win32, where the mode bits a tree hash needs are unavailable", async () => {
    const skill = storeSkill(await run("win32"), "drifted", "win32");
    expect(skill.drift).toBe("unknown");
    expect(skill.contentHash.map((item) => item.algo)).toEqual(["sha256-folder"]);
  });

  it("says drift: local-modified once the directory stops matching the lock", async () => {
    const file = join(home, ".agents", "skills", "drifted", "SKILL.md");
    await writeFile(file, skillBody + "edited\n");
    try {
      expect(storeSkill(await run(), "drifted").drift).toBe("local-modified");
    } finally {
      await writeFile(file, skillBody);
    }
  });
});
