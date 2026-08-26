/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * Skills, agent definitions and commands (research 02 §OpenCode; §Skills table). OpenCode reads
 * both directory generations — the newer plural `skills/` (symlinks into the shared store) and
 * the older singular `skill/` (real copies) — plus `.claude/skills/` and `.agents/skills/`, at
 * project and user scope. One Skill per **real** directory: every path that reaches it is a
 * Placement (ADR-0007), and a placement under `.agents/skills` carries `harness: null` because
 * that directory belongs to the store, not to OpenCode.
 *
 * Only names and descriptions enter a session; `SKILL.md` bodies are read on demand, so the
 * verdict is `description-only` unless the effective `permission.skill` is `deny`. Agent
 * definitions never count toward the Headline number (D39).
 */
import { basename, dirname, join } from "node:path";
import type {
  AgentDefinition,
  DuplicatesEdge,
  Placement,
  ShadowsEdge,
  Skill,
} from "../../index/types.js";
import { warning } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import {
  countLines,
  isFile,
  isRecord,
  listDir,
  lstatOrNull,
  readJsonObject,
  readText,
  realpathOrSelf,
  sha256,
  treeStats,
} from "../../scan/fs.js";
import { parseFrontmatter } from "../../scan/markdown.js";
import { edgeId, isUnder } from "../../scan/paths.js";
import {
  layoutOf,
  originOf,
  readSkillLock,
  storeOf,
  type LockEntry,
} from "../claude-code/locks.js";
import { formatOfConfig } from "./config.js";
import { addEdge, addEntity, baseEntity, evidence, loadedBy, type OpenCodeScan } from "./model.js";

export interface SkillSource {
  scope: "user" | "project";
  project: DiscoveredProject | null;
  /** The directory holding the `<name>/SKILL.md` entries. */
  dir: string;
  /** `null` for `.agents/skills`: the store belongs to no harness (07 pt 7). */
  harness: "opencode" | null;
}

/** The skill directories OpenCode reads at user scope, in the order a placement is chosen. */
export function userSkillDirs(scan: OpenCodeScan): SkillSource[] {
  const { configDir, home } = scan.paths;
  return [
    { scope: "user", project: null, dir: join(configDir, "skills"), harness: "opencode" },
    { scope: "user", project: null, dir: join(configDir, "skill"), harness: "opencode" },
    { scope: "user", project: null, dir: join(home, ".claude", "skills"), harness: "opencode" },
    { scope: "user", project: null, dir: join(home, ".agents", "skills"), harness: null },
  ];
}

export function projectSkillDirs(project: DiscoveredProject, member: string): SkillSource[] {
  return [
    { scope: "project", project, dir: join(member, ".opencode", "skills"), harness: "opencode" },
    { scope: "project", project, dir: join(member, ".opencode", "skill"), harness: "opencode" },
    { scope: "project", project, dir: join(member, ".claude", "skills"), harness: "opencode" },
    { scope: "project", project, dir: join(member, ".agents", "skills"), harness: null },
  ];
}

/** `<X>/.agents/skills/<name>` — the canonical store a skills CLI installs into. */
function inStore(path: string): boolean {
  const skills = dirname(path);
  return basename(skills) === "skills" && basename(dirname(skills)) === ".agents";
}

function placementOf(
  scan: OpenCodeScan,
  path: string,
  source: SkillSource,
  isSymlink: boolean,
  linkTarget: string | null,
  dangling: boolean,
): Placement {
  const gitStatus = source.project === null ? "outside-repo" : scan.ctx.gitStatusOf(path);
  const shared =
    gitStatus === null || gitStatus === "outside-repo"
      ? null
      : gitStatus === "tracked" && source.scope === "project";
  return {
    path,
    harness: source.harness,
    surface: source.harness === null ? null : "cli",
    scope: source.scope,
    project: source.project?.id ?? null,
    gitStatus,
    shared,
    isSymlink,
    linkTarget,
    dangling,
  };
}

/** The store directory itself: several harnesses link to it, so it belongs to none (07 Q1). */
function storePlacement(scan: OpenCodeScan, path: string): Placement {
  const project = scan.ctx.discovery.projectOf(path);
  const gitStatus = project === null ? "outside-repo" : scan.ctx.gitStatusOf(path);
  return {
    path,
    harness: null,
    surface: null,
    scope: project === null ? "user" : "project",
    project: project?.id ?? null,
    gitStatus,
    shared:
      gitStatus === null || gitStatus === "outside-repo"
        ? null
        : gitStatus === "tracked" && project !== null,
    isSymlink: false,
    linkTarget: null,
    dangling: false,
  };
}

function descriptionOf(frontmatter: Record<string, unknown>, name: string): string {
  const description =
    typeof frontmatter["description"] === "string" ? frontmatter["description"] : "";
  return `${name} ${description}`.trim();
}

/** `permission.skill` of the Project's layer, else the user's (research 02 `permission.skill`). */
function skillPermission(scan: OpenCodeScan, project: DiscoveredProject | null): string | null {
  const layers = [
    project === null ? undefined : scan.projectFacts.get(project.id)?.effectiveSettings,
    scan.harnessSettings,
  ];
  for (const layer of layers) {
    const permission = layer?.["permission"];
    if (isRecord(permission) && typeof permission["skill"] === "string") {
      return permission["skill"];
    }
  }
  return null;
}

/** The lock entry that speaks for this directory, when this adapter owns the real path (D38). */
function lockEntryFor(scan: OpenCodeScan, real: string, dirName: string): LockEntry | null {
  const fold = scan.ctx.identity.fold;
  const owns = scan.ownedSkillDirs.some((dir) => isUnder(fold(real), fold(dir)));
  if (!owns) return null;
  const same = scan.ctx.identity.same;
  for (const lock of scan.locks) {
    const exact = lock.entries.find((entry) => same(entry.storeDir, real));
    if (exact !== undefined) return exact;
  }
  for (const lock of scan.locks) {
    const named = lock.entries.find((entry) => entry.name === dirName);
    if (named !== undefined) return named;
  }
  return null;
}

async function skillDirEntity(
  scan: OpenCodeScan,
  linkPath: string,
  source: SkillSource,
): Promise<void> {
  const stats = await lstatOrNull(linkPath);
  if (stats === null) return;
  const isSymlink = stats.isSymbolicLink();
  let linkTarget: string | null = null;
  if (isSymlink) {
    const { readlink } = await import("node:fs/promises");
    linkTarget = await readlink(linkPath).catch(() => null);
  }
  const real = await realpathOrSelf(linkPath);
  const skillFile = join(real, "SKILL.md");
  const dangling = !(await isFile(skillFile));
  const text = dangling ? null : await readText(skillFile);
  const frontmatter = parseFrontmatter(text ?? "");
  const dirName = basename(linkPath);
  const frontmatterName =
    typeof frontmatter.data["name"] === "string" ? frontmatter.data["name"] : null;
  const path = dangling ? linkPath : real;
  const placement = placementOf(scan, linkPath, source, isSymlink, linkTarget, dangling);
  const existing = scan.entities.get(scan.ctx.id("skill", path));
  if (existing !== undefined && existing.kind === "skill") {
    if (!existing.placements.some((item) => scan.ctx.identity.same(item.path, linkPath)))
      existing.placements.push(placement);
    return;
  }
  const tree = dangling
    ? { files: 0, bytes: 0, newestMs: null, oldestMs: null }
    : await treeStats(real);
  const store = inStore(real);
  const lock = lockEntryFor(scan, real, dirName);
  const placements =
    store && !scan.ctx.identity.same(real, linkPath) && !dangling
      ? [storePlacement(scan, real), placement]
      : [placement];
  const base = baseEntity(scan, {
    kind: "skill",
    path,
    scope: source.scope,
    project: dangling ? source.project : (scan.ctx.discovery.projectOf(path) ?? source.project),
    ownership: "human",
    locator: { type: "dir", path },
    format: "dir",
    label: frontmatterName ?? dirName,
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: {
      bytes: tree.bytes,
      files: tree.files,
      lines: text === null ? null : countLines(text),
      mtime: tree.newestMs === null ? null : new Date(tree.newestMs).toISOString(),
      ageDays:
        tree.newestMs === null
          ? null
          : Math.max(0, Math.floor((scan.ctx.options.now.getTime() - tree.newestMs) / 86_400_000)),
      tokens: text === null ? null : scan.ctx.tokenizer.count(text),
      lastUsed: null,
    },
  });
  const entity: Skill = {
    ...base,
    // A directory several harnesses reach through their own links belongs to none of them.
    harness: store ? null : base.harness,
    kind: "skill",
    form: "skill-dir",
    name: frontmatterName ?? dirName,
    dirName,
    frontmatterName,
    layout: layoutOf({
      realPath: path,
      inStore: store,
      inPlugin: false,
      lockRecorded: lock !== null,
    }),
    placements,
    frontmatter: frontmatter.data,
    sidecars: [],
    contentHash: text === null ? [] : [{ algo: "sha256-folder", value: sha256(text) }],
    origin: lock === null ? null : originOf(lock),
    drift: "unknown",
  };
  const added = addEntity(scan, entity);
  // A link whose target is missing is still a Skill (07 "Dangling link"); no session loads it.
  if (dangling) return;
  const denied = skillPermission(scan, source.project) === "deny";
  const description = descriptionOf(frontmatter.data, added.name);
  loadedBy(scan, {
    from: added.id,
    project: source.project?.id ?? null,
    mode: denied ? "disabled" : "description-only",
    reason: denied ? "permission.skill: deny" : `${source.scope} skill`,
    placement: linkPath,
    effectiveName: added.name,
    ordered: !denied,
    charsLoaded: denied ? 0 : description.length,
    importsResolved: null,
    tokensLoaded: denied ? 0 : scan.ctx.tokenizer.count(description).o200k,
    disableModelInvocation: null,
    countsTowardHeadline: !denied,
    evidence: [
      evidence("listing-rule", "skill listed by name and description, SKILL.md on demand"),
    ],
  });
}

async function commandEntity(scan: OpenCodeScan, path: string, source: SkillSource): Promise<void> {
  const text = await readText(path);
  if (text === null) return;
  const frontmatter = parseFrontmatter(text);
  const name = basename(path, ".md");
  const base = baseEntity(scan, {
    kind: "skill",
    path,
    scope: source.scope,
    project: source.project,
    ownership: "human",
    locator: { type: "file", path },
    format: "md",
    label: name,
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: await scan.ctx.fileMetrics(path, text),
  });
  const entity: Skill = {
    ...base,
    kind: "skill",
    form: "command-file",
    name,
    dirName: name,
    frontmatterName: typeof frontmatter.data["name"] === "string" ? frontmatter.data["name"] : null,
    layout: "copy",
    placements: [placementOf(scan, path, source, false, null, false)],
    frontmatter: frontmatter.data,
    sidecars: [],
    contentHash: [{ algo: "sha256-folder", value: sha256(text) }],
    origin: null,
    drift: "unknown",
  };
  const added = addEntity(scan, entity);
  loadedBy(scan, {
    from: added.id,
    project: source.project?.id ?? null,
    mode: "manual",
    reason: "slash command: expanded only when typed",
    placement: path,
    effectiveName: `/${name}`,
    ordered: false,
    charsLoaded: null,
    importsResolved: null,
    tokensLoaded: 0,
    disableModelInvocation: null,
    countsTowardHeadline: false,
    evidence: [evidence("listing-rule", "slash commands are expanded when typed, never listed")],
  });
}

async function agentEntity(scan: OpenCodeScan, path: string, source: SkillSource): Promise<void> {
  const text = await readText(path);
  if (text === null) return;
  const frontmatter = parseFrontmatter(text);
  const name =
    typeof frontmatter.data["name"] === "string" ? frontmatter.data["name"] : basename(path, ".md");
  const base = baseEntity(scan, {
    kind: "agent-definition",
    path,
    scope: source.scope,
    project: source.project,
    ownership: "human",
    locator: { type: "file", path },
    format: "md",
    label: name,
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: await scan.ctx.fileMetrics(path, text),
  });
  const entity: AgentDefinition = {
    ...base,
    kind: "agent-definition",
    name,
    form: "markdown",
    frontmatter: frontmatter.data,
    hooks: [],
  };
  emitAgentLoad(scan, addEntity(scan, entity), source.project?.id ?? null, path);
}

/**
 * D39: an agent definition is spawned on demand and no source documents a startup cost for its
 * description, so it never enters the Headline number — for any harness, `mode` included.
 */
function emitAgentLoad(
  scan: OpenCodeScan,
  entity: AgentDefinition,
  project: string | null,
  placement: string | null,
): void {
  const description =
    typeof entity.frontmatter["description"] === "string" ? entity.frontmatter["description"] : "";
  loadedBy(scan, {
    from: entity.id,
    project,
    mode: "on-demand",
    reason: "spawned on demand; no documented session cost",
    placement,
    effectiveName: entity.name,
    ordered: false,
    charsLoaded: description.length,
    importsResolved: null,
    tokensLoaded: scan.ctx.tokenizer.count(description).o200k,
    disableModelInvocation: null,
    countsTowardHeadline: false,
    confidence: "medium",
    evidence: [
      evidence("listing-rule", "agent definitions are selected or delegated to, never preloaded"),
    ],
  });
}

/** `agent.<name>` and `command.<name>` objects inside a configuration file. */
async function collectConfigEntries(
  scan: OpenCodeScan,
  layer: { path: string; project: DiscoveredProject | null; scope: "user" | "project" },
  data: Record<string, unknown>,
): Promise<void> {
  const format = formatOfConfig(layer.path);
  const agents = data["agent"];
  if (isRecord(agents)) {
    for (const [name, entry] of Object.entries(agents)) {
      if (!isRecord(entry)) continue;
      const base = baseEntity(scan, {
        kind: "agent-definition",
        path: layer.path,
        keyPath: ["agent", name],
        scope: layer.scope,
        project: layer.project,
        ownership: "human",
        locator: { type: "entry", file: layer.path, format, keyPath: ["agent", name] },
        format,
        label: name,
        sensitive: false,
        protection: "none",
        removal: { method: "backup-edit" },
        metrics: await scan.ctx.fileMetrics(layer.path, null),
      });
      const entity: AgentDefinition = {
        ...base,
        kind: "agent-definition",
        name,
        form: "json",
        frontmatter: entry,
        hooks: [],
      };
      emitAgentLoad(scan, addEntity(scan, entity), layer.project?.id ?? null, null);
    }
  }
  const commands = data["command"];
  if (!isRecord(commands)) return;
  for (const [name, entry] of Object.entries(commands)) {
    if (!isRecord(entry)) continue;
    const base = baseEntity(scan, {
      kind: "skill",
      path: layer.path,
      keyPath: ["command", name],
      scope: layer.scope,
      project: layer.project,
      ownership: "human",
      locator: { type: "entry", file: layer.path, format, keyPath: ["command", name] },
      format,
      label: name,
      sensitive: false,
      protection: "none",
      removal: { method: "backup-edit" },
      metrics: await scan.ctx.fileMetrics(layer.path, null),
    });
    const entity: Skill = {
      ...base,
      kind: "skill",
      form: "command-file",
      name,
      dirName: name,
      frontmatterName: null,
      layout: "copy",
      placements: [],
      frontmatter: entry,
      sidecars: [],
      contentHash: [],
      origin: null,
      drift: "unknown",
    };
    const added = addEntity(scan, entity);
    loadedBy(scan, {
      from: added.id,
      project: layer.project?.id ?? null,
      mode: "manual",
      reason: "slash command: expanded only when typed",
      placement: null,
      effectiveName: `/${name}`,
      ordered: false,
      charsLoaded: null,
      importsResolved: null,
      tokensLoaded: 0,
      disableModelInvocation: null,
      countsTowardHeadline: false,
      evidence: [evidence("listing-rule", "slash commands are expanded when typed, never listed")],
    });
  }
}

async function collectFrom(scan: OpenCodeScan, sources: readonly SkillSource[]): Promise<void> {
  for (const source of sources) {
    const entries = (await listDir(source.dir)).toSorted((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      await skillDirEntity(scan, join(source.dir, entry.name), source);
    }
  }
}

async function collectMarkdownDir(
  scan: OpenCodeScan,
  dir: string,
  source: SkillSource,
  kind: "agents" | "commands",
): Promise<void> {
  for (const entry of (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const path = join(dir, entry.name);
    if (kind === "agents") await agentEntity(scan, path, source);
    else await commandEntity(scan, path, source);
  }
}

export async function collectUserSkills(scan: OpenCodeScan): Promise<void> {
  const source: SkillSource = {
    scope: "user",
    project: null,
    dir: scan.paths.configDir,
    harness: "opencode",
  };
  await collectFrom(scan, userSkillDirs(scan));
  await collectMarkdownDir(scan, join(scan.paths.configDir, "agents"), source, "agents");
  await collectMarkdownDir(scan, join(scan.paths.configDir, "commands"), source, "commands");
  for (const layer of scan.layers) {
    if (layer.present && !layer.parseError)
      await collectConfigEntries(scan, { ...layer, scope: "user", project: null }, layer.data);
  }
}

export async function collectProjectSkills(
  scan: OpenCodeScan,
  project: DiscoveredProject,
): Promise<void> {
  if (project.reachability !== "present") return;
  for (const member of project.members) {
    if (member.reachability !== "present") continue;
    const source: SkillSource = {
      scope: "project",
      project,
      dir: join(member.path, ".opencode"),
      harness: "opencode",
    };
    await collectFrom(scan, projectSkillDirs(project, member.path));
    await collectMarkdownDir(scan, join(member.path, ".opencode", "agents"), source, "agents");
    await collectMarkdownDir(scan, join(member.path, ".opencode", "commands"), source, "commands");
  }
  for (const layer of scan.projectLayers.get(project.id) ?? []) {
    if (layer.present && !layer.parseError)
      await collectConfigEntries(scan, { ...layer, scope: "project", project }, layer.data);
  }
}

/**
 * §1.5: two real directories with the same `name` are `duplicates` — `same: "content"` with
 * `confidence: "certain"` when their hashes match, `same: "name"` (`medium`) when they differ.
 * Two links to one directory are placements, never duplicates.
 */
export function skillDuplicates(scan: OpenCodeScan): void {
  const byName = new Map<string, Skill[]>();
  for (const entity of scan.entities.values()) {
    if (entity.kind !== "skill" || entity.form !== "skill-dir") continue;
    byName.set(entity.name, [...(byName.get(entity.name) ?? []), entity]);
  }
  for (const [, group] of byName) {
    const sorted = group.toSorted((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const from = sorted[i];
        const to = sorted[j];
        if (from === undefined || to === undefined) continue;
        const hash = from.contentHash[0]?.value;
        const same = hash !== undefined && hash === to.contentHash[0]?.value;
        const edge: DuplicatesEdge = {
          id: edgeId("duplicates", from.id, to.id),
          kind: "duplicates",
          from: from.id,
          to: to.id,
          confidence: same ? "certain" : "medium",
          evidence: [
            same
              ? evidence("content-hash", `sha256 ${(hash ?? "").slice(0, 12)}`)
              : evidence("name-only", from.name),
          ],
          same: same ? "content" : "name",
        };
        addEdge(scan, edge);
      }
    }
  }
}

/** Project scope wins over user scope for a command or an agent of the same name (research 02). */
export function shadowByName(scan: OpenCodeScan): void {
  const groups = new Map<string, { user: string[]; project: Map<string, string[]> }>();
  for (const entity of scan.entities.values()) {
    if (
      entity.kind !== "agent-definition" &&
      !(entity.kind === "skill" && entity.form === "command-file")
    )
      continue;
    const key = `${entity.kind}:${entity.name}`;
    const group = groups.get(key) ?? { user: [], project: new Map<string, string[]>() };
    if (entity.scope === "user") group.user.push(entity.id);
    else if (entity.project !== null)
      group.project.set(entity.project, [...(group.project.get(entity.project) ?? []), entity.id]);
    groups.set(key, group);
  }
  for (const [, group] of groups) {
    for (const [projectId, winners] of group.project) {
      for (const winner of winners.toSorted()) {
        for (const loser of group.user.toSorted()) {
          const edge: ShadowsEdge = {
            id: edgeId("shadows", winner, loser),
            kind: "shadows",
            from: winner,
            to: loser,
            confidence: "certain",
            evidence: [
              evidence(
                "precedence-rule",
                "a project definition of the same name wins over the user one",
              ),
            ],
            rule: "project > user",
          };
          addEdge(scan, edge);
          // D136: the user entity keeps its baseline verdict and gains a per-Project one.
          loadedBy(scan, {
            from: loser,
            project: projectId,
            mode: "shadowed",
            reason: "a project-scope definition of the same name wins",
            placement: null,
            effectiveName: null,
            ordered: false,
            charsLoaded: 0,
            importsResolved: null,
            tokensLoaded: 0,
            disableModelInvocation: null,
            countsTowardHeadline: false,
            evidence: [evidence("precedence-rule", "project > user")],
          });
        }
      }
    }
  }
}

/**
 * The Vercel skill locks, read only to fill `Origin` for skills this adapter owns (the shared
 * store itself is the shared-stores adapter's, ticket 22). The fixture's lock declares
 * `version: 1` with version-3 entry keys: one `unsupported-shape` warning, and its entries are
 * left alone rather than guessed at.
 */
export async function readLocks(scan: OpenCodeScan): Promise<void> {
  const files: string[] = [];
  const xdg = scan.ctx.consultEnv("XDG_STATE_HOME");
  if (xdg !== undefined) files.push(join(xdg, "skills", ".skill-lock.json"));
  files.push(join(scan.paths.home, ".agents", ".skill-lock.json"));
  for (const file of files) {
    const raw = await readJsonObject(file);
    if (raw === null) {
      if (await isFile(file)) {
        scan.ctx.warn(
          warning("parse-error", ".skill-lock.json is not valid JSON", "opencode", file, "partial"),
        );
      }
      continue;
    }
    // v3 records `skillFolderHash` per entry, v1 the `computedHash` it can reproduce. A version
    // that disagrees with the keys is a shape moldig has not seen: report it, never guess.
    const skills = raw["skills"];
    const version = typeof raw["version"] === "number" ? raw["version"] : null;
    const v3Keys =
      isRecord(skills) &&
      Object.values(skills).some((entry) => isRecord(entry) && "skillFolderHash" in entry);
    if (version !== 3 && v3Keys) {
      scan.ctx.warn(
        warning(
          "unsupported-shape",
          `.skill-lock.json declares version ${version ?? "unknown"} with version-3 entry keys: skill origins are not read`,
          "opencode",
          file,
          "partial",
        ),
      );
      continue;
    }
    const lock = await readSkillLock(file, storeOf(file), "user", null);
    if (lock.present && !lock.parseError) scan.locks.push(lock);
  }
}
