/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order and the per-Project `order` numbers depend on it */
/**
 * Skills, custom commands and agent definitions (research 02, Gemini skills/commands/agents;
 * spec §6). Skills come from five directories — `<member>/.agents/skills`,
 * `<member>/.gemini/skills`, `~/.agents/skills`, `~/.gemini/skills` and `<plugin>/skills` —
 * with `workspace > user > extension` precedence and `.agents` winning inside a tier. One Skill
 * per **real** directory: every link that reaches it is a Placement (ADR-0007), and a directory
 * under a `.agents/skills` store belongs to no harness (`harness: null`, spec §12).
 *
 * Commands are TOML files whose subdirectories namespace them (`ns/cmd-b.toml` → `/ns:cmd-b`);
 * agent definitions follow D39 — spawned on demand, never part of the Headline number.
 */
import { basename, dirname, join, relative } from "node:path";
import type {
  AgentDefinition,
  GitStatus,
  Placement,
  Plugin,
  ShadowsEdge,
  Skill,
} from "../../index/types.js";
import { warning } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import {
  countLines,
  isFile,
  listDir,
  lstatOrNull,
  readText,
  realpathOrSelf,
  sha256,
  treeStats,
} from "../../scan/fs.js";
import { parseFrontmatter } from "../../scan/markdown.js";
import { edgeId, isUnder } from "../../scan/paths.js";
import {
  addEdge,
  addEntity,
  baseEntity,
  evidence,
  HARNESS,
  loadedBy,
  loadedByEdgeId,
  providedBy,
  settingsFor,
  type GeminiScan,
} from "./model.js";
import { hooksOf, nested, parseToml, stringList } from "./settings.js";

/** The known sidecar files ticket 07 lists, in a fixed order. */
const SIDECARS = [join("agents", "openai.yaml"), join(".claude-plugin", "plugin.json")];

/** Highest first: workspace 30, user 20, extension 10; `.agents` adds 1 inside a tier. */
const TIER_RANK = { workspace: 30, user: 20, extension: 10 } as const;

export interface SkillSource {
  tier: "workspace" | "user" | "extension";
  /** `.agents` wins inside a tier (research 02). */
  store: ".agents" | ".gemini" | "plugin";
  /** The directory holding `skills/`, `commands/` and `agents/`. */
  dir: string;
  scope: "user" | "project";
  project: DiscoveredProject | null;
  plugin?: Plugin;
}

function rankOf(source: SkillSource): number {
  return TIER_RANK[source.tier] + (source.store === ".agents" ? 1 : 0);
}

function tierLabel(source: SkillSource): string {
  return source.tier === "extension" ? "plugin" : `${source.tier} ${source.store}/skills`;
}

/** `<X>/.agents/skills/<name>` — the canonical store several harnesses share. */
function inStore(path: string): boolean {
  const skills = dirname(path);
  return basename(skills) === "skills" && basename(dirname(skills)) === ".agents";
}

function sharedOf(gitStatus: GitStatus | null, inProject: boolean): boolean | null {
  if (gitStatus === null || gitStatus === "outside-repo") return null;
  return gitStatus === "tracked" && inProject;
}

/**
 * One placement per distinct path (spec §12): the canonical store directory belongs to no
 * harness, every other path is the harness that reaches the skill through it.
 */
function placementOf(
  scan: GeminiScan,
  path: string,
  scope: "user" | "project",
  isSymlink: boolean,
  linkTarget: string | null,
  dangling: boolean,
): Placement {
  const project = scan.ctx.discovery.projectOf(path);
  const gitStatus = project === null ? "outside-repo" : scan.ctx.gitStatusOf(path);
  const canonical = inStore(path);
  return {
    path,
    harness: canonical ? null : HARNESS,
    surface: canonical ? null : "cli",
    scope,
    project: project?.id ?? null,
    gitStatus,
    shared: sharedOf(gitStatus, scope === "project"),
    isSymlink,
    linkTarget,
    dangling,
  };
}

function descriptionOf(frontmatter: Record<string, unknown>, body: string): string {
  const description =
    typeof frontmatter["description"] === "string" ? frontmatter["description"] : null;
  return description ?? body.trim().split(/\n\s*\n/)[0] ?? "";
}

async function skillDirEntity(
  scan: GeminiScan,
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
  const placement = placementOf(scan, linkPath, source.scope, isSymlink, linkTarget, dangling);
  const existing = scan.entities.get(scan.ctx.id("skill", path));
  if (existing !== undefined && existing.kind === "skill") {
    if (!existing.placements.some((item) => scan.ctx.identity.same(item.path, linkPath)))
      existing.placements.push(placement);
    return;
  }
  const intended = dangling && linkTarget !== null ? join(dirname(linkPath), linkTarget) : real;
  const store = inStore(intended);
  const tree = dangling
    ? { files: 0, bytes: 0, newestMs: null, oldestMs: null }
    : await treeStats(real);
  const placements =
    store && !scan.ctx.identity.same(intended, linkPath) && !dangling
      ? [placementOf(scan, real, source.scope, false, null, false), placement]
      : [placement];
  const sidecars: string[] = [];
  for (const sidecar of SIDECARS) {
    if (!dangling && (await isFile(join(real, sidecar)))) sidecars.push(sidecar);
  }
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
    // Ticket 14 §1: a plugin's skill is never removable on its own; it falls with the plugin.
    removal: source.plugin === undefined ? { method: "trash" } : { method: "none" },
    // A directory several harnesses reach through their own links belongs to none of them (§12).
    ...(store ? { harness: null } : {}),
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
    kind: "skill",
    form: "skill-dir",
    name: frontmatterName ?? dirName,
    dirName,
    frontmatterName,
    // A dangling link keys on the link path and still describes a canonical install (07).
    layout: source.plugin !== undefined ? "plugin" : store || dangling ? "canonical" : "copy",
    placements,
    frontmatter: frontmatter.data,
    sidecars,
    contentHash: text === null ? [] : [{ algo: "sha256-folder", value: sha256(text) }],
    // §13: locks, folder hashes and the drift verdict belong to the shared-stores adapter.
    origin: null,
    drift: "unknown",
  };
  const added = addEntity(scan, entity);
  if (source.plugin !== undefined) providedBy(scan, added.id, source.plugin);
  if (dangling) return;
  scan.skills.push({
    entity: added,
    rank: rankOf(source),
    tier: tierLabel(source),
    dir: source.dir,
    project: source.scope === "project" ? (source.project?.id ?? null) : null,
  });
  emitSkillLoad(scan, added, descriptionOf(frontmatter.data, frontmatter.body), source);
}

function emitSkillLoad(
  scan: GeminiScan,
  entity: Skill,
  description: string,
  source: SkillSource,
): void {
  const settings = settingsFor(scan, source.scope === "project" ? source.project : null);
  const enabled = nested(settings, "skills", "enabled") !== false;
  const disabled = stringList(nested(settings, "skills", "disabled")).includes(entity.name);
  const listed = enabled && !disabled;
  const reason = !enabled
    ? "skills.enabled is false"
    : disabled
      ? "listed in skills.disabled"
      : `${tierLabel(source)} skill: description listed, body on demand`;
  loadedBy(scan, {
    from: entity.id,
    project: source.scope === "project" ? (source.project?.id ?? null) : null,
    mode: listed ? "description-only" : "disabled",
    reason,
    // The highest-precedence path the harness reaches it through: the canonical directory when
    // both exist (research 01: a symlinked target loads once).
    placement:
      entity.placements.find((item) => item.harness === null)?.path ??
      entity.placements[0]?.path ??
      null,
    effectiveName: `/${entity.name}`,
    ordered: listed,
    charsLoaded: listed ? description.length : 0,
    importsResolved: null,
    tokensLoaded: listed ? scan.ctx.tokenizer.count(description).o200k : 0,
    disableModelInvocation: null,
    countsTowardHeadline: listed,
    evidence: [evidence("listing-rule", reason)],
  });
}

async function collectSkillDir(scan: GeminiScan, source: SkillSource): Promise<void> {
  const skillsDir = join(source.dir, "skills");
  for (const entry of (await listDir(skillsDir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    await skillDirEntity(scan, join(skillsDir, entry.name), source);
  }
}

/**
 * Precedence across the five locations: the highest-ranked directory wins a name, every other
 * copy is `shadowed` and carries a `shadows` edge (research 02; fixture from-docs edge 6).
 */
function applySkillPrecedence(scan: GeminiScan): void {
  const byName = new Map<string, typeof scan.skills>();
  for (const item of scan.skills) {
    byName.set(item.entity.name, [...(byName.get(item.entity.name) ?? []), item]);
  }
  for (const [, group] of byName) {
    if (group.length < 2) continue;
    const sorted = group.toSorted(
      (a, b) => b.rank - a.rank || a.entity.id.localeCompare(b.entity.id),
    );
    const winner = sorted[0];
    if (winner === undefined) continue;
    for (const loser of sorted.slice(1)) {
      if (loser.rank >= winner.rank) continue;
      if (winner.project !== null && winner.project !== loser.project) continue;
      const edge: ShadowsEdge = {
        id: edgeId("shadows", winner.entity.id, loser.entity.id),
        kind: "shadows",
        from: winner.entity.id,
        to: loser.entity.id,
        confidence: "certain",
        evidence: [
          evidence(
            "precedence-rule",
            `a ${winner.tier} skill of the same name wins over ${loser.tier}`,
          ),
        ],
        rule: "workspace > user > extension; .agents wins within a tier",
      };
      addEdge(scan, edge);
      const shadowed = scan.edges.get(loadedByEdgeId(loser.entity.id, loser.project));
      if (shadowed?.kind === "loaded-by" && shadowed.mode === "description-only") {
        shadowed.mode = "shadowed";
        shadowed.reason = `a ${winner.tier} skill of the same name wins`;
        shadowed.order = null;
        shadowed.charsLoaded = 0;
        shadowed.tokensLoaded = 0;
        shadowed.countsTowardHeadline = false;
      }
    }
  }
}

// ---------- commands ----------

interface CommandFile {
  path: string;
  /** Subdirectories below `commands/`, which namespace the command with `:`. */
  namespace: string[];
}

async function commandFiles(dir: string, namespace: string[] = []): Promise<CommandFile[]> {
  const out: CommandFile[] = [];
  for (const entry of (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await commandFiles(path, [...namespace, entry.name])));
    else if (entry.isFile() && entry.name.endsWith(".toml")) out.push({ path, namespace });
  }
  return out;
}

async function commandEntity(
  scan: GeminiScan,
  file: CommandFile,
  source: SkillSource,
): Promise<void> {
  const text = await readText(file.path);
  if (text === null) return;
  const table = parseToml(text);
  if (table === null) {
    scan.ctx.warn(
      warning(
        "parse-error",
        `${basename(file.path)} is not valid TOML`,
        HARNESS,
        file.path,
        "skipped",
      ),
    );
    return;
  }
  const name = basename(file.path, ".toml");
  const effectiveName = `/${[...file.namespace, name].join(":")}`;
  // `prompt` is the body, not metadata: it never enters `frontmatter` (spec §6).
  const frontmatter = Object.fromEntries(Object.entries(table).filter(([key]) => key !== "prompt"));
  const base = baseEntity(scan, {
    kind: "skill",
    path: file.path,
    scope: source.scope,
    project: source.project,
    ownership: "human",
    locator: { type: "file", path: file.path },
    format: "toml",
    label: name,
    sensitive: false,
    protection: "none",
    removal: source.plugin === undefined ? { method: "trash" } : { method: "none" },
    metrics: await scan.ctx.fileMetrics(file.path, text),
  });
  const entity: Skill = {
    ...base,
    kind: "skill",
    form: "command-file",
    name,
    dirName: name,
    frontmatterName: null,
    layout: source.plugin === undefined ? "canonical" : "plugin",
    placements: [placementOf(scan, file.path, source.scope, false, null, false)],
    frontmatter,
    sidecars: [],
    contentHash: [{ algo: "sha256-folder", value: sha256(text) }],
    origin: null,
    drift: "unknown",
  };
  const added = addEntity(scan, entity);
  if (source.plugin !== undefined) providedBy(scan, added.id, source.plugin);
  const reason = `custom command: expanded when the user invokes ${effectiveName}`;
  loadedBy(scan, {
    from: added.id,
    project: source.scope === "project" ? (source.project?.id ?? null) : null,
    mode: "manual",
    reason,
    placement: file.path,
    effectiveName,
    ordered: false,
    charsLoaded: 0,
    importsResolved: null,
    tokensLoaded: 0,
    // D74: a Gemini custom command is expanded on invocation; its description is not listed.
    disableModelInvocation: true,
    countsTowardHeadline: false,
    evidence: [evidence("listing-rule", reason)],
  });
}

async function collectCommandDir(scan: GeminiScan, source: SkillSource): Promise<Skill[]> {
  const out: Skill[] = [];
  for (const file of await commandFiles(join(source.dir, "commands"))) {
    const before = scan.entities.size;
    await commandEntity(scan, file, source);
    const entity = scan.entities.get(scan.ctx.id("skill", file.path));
    if (entity?.kind === "skill" && scan.entities.size >= before) out.push(entity);
  }
  return out;
}

// ---------- agent definitions ----------

async function agentEntity(scan: GeminiScan, path: string, source: SkillSource): Promise<void> {
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
    removal: source.plugin === undefined ? { method: "trash" } : { method: "none" },
    metrics: await scan.ctx.fileMetrics(path, text),
  });
  const entity: AgentDefinition = {
    ...base,
    kind: "agent-definition",
    name,
    form: "markdown",
    frontmatter: frontmatter.data,
    hooks: hooksOf({ hooks: frontmatter.data["hooks"] }),
  };
  const added = addEntity(scan, entity);
  if (source.plugin !== undefined) providedBy(scan, added.id, source.plugin);
  const description =
    typeof frontmatter.data["description"] === "string" ? frontmatter.data["description"] : "";
  // D39/D74: an agent definition is spawned on demand; no source documents a startup cost.
  loadedBy(scan, {
    from: added.id,
    project: source.scope === "project" ? (source.project?.id ?? null) : null,
    mode: "on-demand",
    reason: "spawned on demand; no documented session cost",
    placement: path,
    effectiveName: name,
    ordered: false,
    charsLoaded: description.length,
    importsResolved: null,
    tokensLoaded: scan.ctx.tokenizer.count(description).o200k,
    disableModelInvocation: null,
    countsTowardHeadline: false,
    confidence: "medium",
    evidence: [evidence("listing-rule", "agent definitions are spawned on demand")],
  });
}

async function collectAgentDir(scan: GeminiScan, source: SkillSource): Promise<void> {
  const dir = join(source.dir, "agents");
  for (const entry of (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith(".md"))
      await agentEntity(scan, join(dir, entry.name), source);
  }
}

// ---------- the pass ----------

/** Every source of skills, commands and agents, in load order (highest precedence first). */
export function skillSources(
  scan: GeminiScan,
  projects: readonly DiscoveredProject[],
): SkillSource[] {
  const out: SkillSource[] = [];
  for (const project of projects) {
    if (project.reachability !== "present") continue;
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      out.push({
        tier: "workspace",
        store: ".agents",
        dir: join(member.path, ".agents"),
        scope: "project",
        project,
      });
      out.push({
        tier: "workspace",
        store: ".gemini",
        dir: join(member.path, ".gemini"),
        scope: "project",
        project,
      });
    }
  }
  out.push({
    tier: "user",
    store: ".agents",
    dir: dirname(scan.paths.agentsStore),
    scope: "user",
    project: null,
  });
  out.push({
    tier: "user",
    store: ".gemini",
    dir: scan.paths.geminiDir,
    scope: "user",
    project: null,
  });
  for (const extension of scan.extensions) {
    out.push({
      tier: "extension",
      store: "plugin",
      dir: extension.dir,
      scope: "user",
      project: null,
      plugin: extension.entity,
    });
  }
  return out;
}

export async function collectSkills(
  scan: GeminiScan,
  projects: readonly DiscoveredProject[],
): Promise<void> {
  const sources = skillSources(scan, projects);
  for (const source of sources) await collectSkillDir(scan, source);
  applySkillPrecedence(scan);

  // Commands: project wins over user for the same name (research 02).
  const commands: { entity: Skill; rank: number; project: string | null }[] = [];
  for (const source of sources) {
    // `.agents` holds skills only — commands and agents live under `.gemini` and in plugins.
    if (source.store === ".agents") continue;
    for (const entity of await collectCommandDir(scan, source)) {
      commands.push({
        entity,
        rank: rankOf(source),
        project: source.scope === "project" ? (source.project?.id ?? null) : null,
      });
    }
    await collectAgentDir(scan, source);
  }
  const byName = new Map<string, typeof commands>();
  for (const item of commands)
    byName.set(item.entity.name, [...(byName.get(item.entity.name) ?? []), item]);
  for (const [, group] of byName) {
    if (group.length < 2) continue;
    const sorted = group.toSorted(
      (a, b) => b.rank - a.rank || a.entity.id.localeCompare(b.entity.id),
    );
    const winner = sorted[0];
    if (winner === undefined) continue;
    for (const loser of sorted.slice(1)) {
      if (loser.rank >= winner.rank) continue;
      addEdge(scan, {
        id: edgeId("shadows", winner.entity.id, loser.entity.id),
        kind: "shadows",
        from: winner.entity.id,
        to: loser.entity.id,
        confidence: "certain",
        evidence: [evidence("precedence-rule", `a project command of the same name wins`)],
        rule: "project > user",
      } satisfies ShadowsEdge);
    }
  }
}

/** The relative label of a path inside a directory, for messages. */
export function relativeLabel(dir: string, path: string): string {
  return relative(dir, path).split(/[/\\]/).join("/");
}

/** Whether `path` lies under `dir` (folded) — used by the plugin payload passes. */
export function under(scan: GeminiScan, path: string, dir: string): boolean {
  const fold = scan.ctx.identity.fold;
  return isUnder(fold(path), fold(dir));
}
