/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * Skills, commands and agent definitions (research 01 §1–2): `.claude/skills/<name>/SKILL.md`
 * (one Skill per **real** directory — every link that reaches it is a Placement, ADR-0007),
 * `.claude/commands/<name>.md` (`form: command-file`) and `.claude/agents/<name>.md`, at user
 * scope, in every present member of a Project, and inside a plugin's install directory. Only
 * descriptions enter a session (1,536 chars); `disable-model-invocation: true` keeps even that
 * out, and an agent definition is spawned on demand and costs nothing at startup (D39).
 *
 * A skill directory a lock records carries its `Origin` and an `originates-from` edge to the lock
 * (ticket 14 §2). The folder hash and the drift verdict are the shared-stores ticket's: `drift`
 * stays `"unknown"` here (D44).
 */
import { basename, dirname, join } from "node:path";
import type {
  AgentDefinition,
  GitStatus,
  LoadedByEdge,
  OriginatesFromEdge,
  Placement,
  Plugin,
  Skill,
} from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import {
  countLines,
  isDirectory,
  isFile,
  listDir,
  lstatOrNull,
  readText,
  realpathOrSelf,
  sha256,
  treeStats,
} from "../../scan/fs.js";
import { parseFrontmatter } from "../../scan/markdown.js";
import { edgeId } from "../../scan/paths.js";
import { gitCloneOrigin, layoutOf, lockLocator, originOf, type LockEntry } from "./locks.js";
import { addEdge, addEntity, baseEntity, evidence, loadedBy, type ClaudeScan } from "./model.js";
import { providedBy } from "./plugins.js";
import { hooksOf, lastUsedOf } from "./state.js";

const DESCRIPTION_CHARS = 1536;

/** The known sidecar files ticket 07 lists, in a fixed order. */
const SIDECARS = [join(".claude-plugin", "plugin.json"), join("agents", "openai.yaml")];

function descriptionOf(frontmatter: Record<string, unknown>, body: string): string {
  const description =
    typeof frontmatter["description"] === "string" ? frontmatter["description"] : null;
  const whenToUse =
    typeof frontmatter["when_to_use"] === "string" ? frontmatter["when_to_use"] : "";
  const text =
    description === null
      ? (body.trim().split(/\n\s*\n/)[0] ?? "")
      : `${description} ${whenToUse}`.trim();
  return text.slice(0, DESCRIPTION_CHARS);
}

/** The plugin a set of items belongs to: it namespaces their names and pins their verdict. */
export interface PluginContext {
  entity: Plugin;
  /** `<plugin>` of `<plugin>@<marketplace>`. */
  name: string;
  mode: LoadedByEdge["mode"];
  reason: string;
}

export interface SkillSource {
  scope: "user" | "project";
  project: DiscoveredProject | null;
  /** The directory holding `skills/`, `commands/` and `agents/`. */
  dir: string;
  plugin?: PluginContext;
}

export interface SkillOptions {
  /** Overrides the `/`-name (a skills-dir plugin's root is the skill, not `skills/<name>`). */
  effectiveName?: string;
}

/** `<X>/.agents/skills/<name>` — the canonical store a skills CLI installs into. */
function inStore(path: string): boolean {
  const skills = dirname(path);
  return basename(skills) === "skills" && basename(dirname(skills)) === ".agents";
}

function sharedOf(gitStatus: GitStatus | null, inProject: boolean): boolean | null {
  if (gitStatus === null || gitStatus === "outside-repo") return null;
  return gitStatus === "tracked" && inProject;
}

function placementOf(
  scan: ClaudeScan,
  path: string,
  source: SkillSource,
  isSymlink: boolean,
  linkTarget: string | null,
  dangling: boolean,
): Placement {
  const gitStatus = source.project === null ? "outside-repo" : scan.ctx.gitStatusOf(path);
  return {
    path,
    harness: "claude-code",
    surface: "cli",
    scope: source.scope,
    project: source.project?.id ?? null,
    gitStatus,
    // Ticket 07: `shared` = tracked ∧ project scope; `null` when git did not run or there is no repo.
    shared: sharedOf(gitStatus, source.scope === "project"),
    isSymlink,
    linkTarget,
    dangling,
  };
}

/**
 * The store directory itself, listed first: it belongs to no harness (several link to it), so
 * `harness` and `surface` are null and the row reads "shared by N harnesses" (ticket 07 Q1).
 */
function storePlacement(scan: ClaudeScan, path: string): Placement {
  const project = scan.ctx.discovery.projectOf(path);
  const gitStatus = project === null ? "outside-repo" : scan.ctx.gitStatusOf(path);
  return {
    path,
    harness: null,
    surface: null,
    scope: project === null ? "user" : "project",
    project: project?.id ?? null,
    gitStatus,
    shared: sharedOf(gitStatus, project !== null),
    isSymlink: false,
    linkTarget: null,
    dangling: false,
  };
}

/**
 * The lock entry that speaks for this directory (ticket 14 §2): the entry whose store directory
 * *is* it, else the entry of the same name in a lock of the same scope (a `--copy` install keeps
 * its name inside the harness's own skills directory).
 */
function lockEntryFor(
  scan: ClaudeScan,
  source: SkillSource,
  dirName: string,
  real: string,
): LockEntry | null {
  const same = scan.ctx.identity.same;
  const locks = scan.locks.filter((lock) =>
    source.scope === "user"
      ? lock.scope === "user"
      : lock.project !== null && lock.project.id === source.project?.id,
  );
  for (const lock of locks) {
    const exact = lock.entries.find((entry) => same(entry.storeDir, real));
    if (exact !== undefined) return exact;
  }
  for (const lock of locks) {
    const named = lock.entries.find((entry) => entry.name === dirName);
    if (named !== undefined) return named;
  }
  return null;
}

function attachOrigin(scan: ClaudeScan, entity: Skill, entry: LockEntry): void {
  entity.origin = originOf(entry);
  const edge: OriginatesFromEdge = {
    id: edgeId("originates-from", entity.id, scan.ctx.id("settings-file", entry.file)),
    kind: "originates-from",
    from: entity.id,
    to: scan.ctx.id("settings-file", entry.file),
    confidence: "certain",
    evidence: [evidence("lock-entry", `skills.${entry.name}`, lockLocator(entry))],
  };
  addEdge(scan, edge);
}

async function commandEntity(scan: ClaudeScan, path: string, source: SkillSource): Promise<void> {
  const text = await readText(path);
  if (text === null) return;
  const frontmatter = parseFrontmatter(text);
  const name = basename(path, ".md");
  const metrics = await scan.ctx.fileMetrics(path, text);
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
    removal: source.plugin === undefined ? { method: "trash" } : { method: "none" },
    metrics: { ...metrics, lastUsed: lastUsedOf(scan.claudeJson.usage.skills, name) },
  });
  const entity: Skill = {
    ...base,
    kind: "skill",
    form: "command-file",
    name,
    dirName: name,
    frontmatterName: null,
    layout: source.plugin === undefined ? "copy" : "plugin",
    placements: [placementOf(scan, path, source, false, null, false)],
    frontmatter: frontmatter.data,
    sidecars: [],
    contentHash: [{ algo: "sha256-folder", value: sha256(text) }],
    origin: null,
    drift: "unknown",
  };
  const added = addEntity(scan, entity);
  if (source.plugin !== undefined) providedBy(scan, added.id, source.plugin.entity);
  emitSkillLoad(
    scan,
    added,
    descriptionOf(frontmatter.data, frontmatter.body),
    source,
    source.plugin === undefined ? `/${name}` : `/${source.plugin.name}:${name}`,
    "command file: description listed, body on demand",
  );
}

function emitSkillLoad(
  scan: ClaudeScan,
  entity: Skill,
  description: string,
  source: SkillSource,
  effectiveName: string,
  detail: string,
): void {
  const disabled = entity.frontmatter["disable-model-invocation"] === true;
  const plugin = source.plugin;
  const loads = plugin === undefined || plugin.mode === "description-only";
  const listed = loads && !disabled;
  const mode: LoadedByEdge["mode"] = disabled
    ? "manual"
    : plugin === undefined
      ? "description-only"
      : plugin.mode;
  const reason = disabled
    ? "disable-model-invocation: only the user can invoke it, description not in context"
    : plugin === undefined
      ? `${source.scope} skill`
      : plugin.reason;
  loadedBy(scan, {
    from: entity.id,
    project: source.project?.id ?? null,
    mode,
    reason,
    placement: entity.placements.find((item) => item.harness !== null)?.path ?? null,
    effectiveName,
    ordered: listed,
    charsLoaded: listed ? description.length : 0,
    importsResolved: null,
    tokensLoaded: listed ? scan.ctx.tokenizer.count(description).o200k : 0,
    disableModelInvocation: disabled,
    countsTowardHeadline: listed,
    evidence: [evidence("listing-rule", detail)],
  });
}

export async function skillDirEntity(
  scan: ClaudeScan,
  linkPath: string,
  source: SkillSource,
  options: SkillOptions = {},
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
  const tree = dangling
    ? { files: 0, bytes: 0, newestMs: null, oldestMs: null }
    : await treeStats(real);
  const placement = placementOf(scan, linkPath, source, isSymlink, linkTarget, dangling);
  const existing = scan.entities.get(scan.ctx.id("skill", path));
  if (existing !== undefined && existing.kind === "skill") {
    if (!existing.placements.some((item) => scan.ctx.identity.same(item.path, linkPath)))
      existing.placements.push(placement);
    return;
  }
  // A dangling link still points somewhere: the intended directory decides the layout.
  const intended = dangling && linkTarget !== null ? join(dirname(linkPath), linkTarget) : real;
  const store = inStore(intended);
  const lock = lockEntryFor(scan, source, dirName, intended);
  const placements =
    store && !scan.ctx.identity.same(intended, linkPath) && !dangling
      ? [storePlacement(scan, real), placement]
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
      lastUsed: lastUsedOf(scan.claudeJson.usage.skills, frontmatterName ?? dirName),
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
      inPlugin: source.plugin !== undefined,
      lockRecorded: lock !== null,
    }),
    placements,
    frontmatter: frontmatter.data,
    sidecars,
    contentHash: text === null ? [] : [{ algo: "sha256-folder", value: sha256(text) }],
    origin: null,
    drift: "unknown",
  };
  const added = addEntity(scan, entity);
  if (lock !== null) attachOrigin(scan, added, lock);
  else if (!dangling && (await isDirectory(join(real, ".git"))))
    added.origin = gitCloneOrigin(real);
  if (source.plugin !== undefined) providedBy(scan, added.id, source.plugin.entity);
  // A link whose target is missing is still a Skill (07 "Dangling link"): the Orphan finding
  // targets it, and no session ever loads it.
  if (!dangling)
    emitSkillLoad(
      scan,
      added,
      descriptionOf(frontmatter.data, frontmatter.body),
      source,
      options.effectiveName ??
        (source.plugin === undefined ? `/${added.name}` : `/${source.plugin.name}:${added.name}`),
      "description listed, body on demand",
    );
}

async function agentEntity(scan: ClaudeScan, path: string, source: SkillSource): Promise<void> {
  const text = await readText(path);
  if (text === null) return;
  const frontmatter = parseFrontmatter(text);
  const name =
    typeof frontmatter.data["name"] === "string" ? frontmatter.data["name"] : basename(path, ".md");
  const metrics = await scan.ctx.fileMetrics(path, text);
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
    metrics: { ...metrics, lastUsed: lastUsedOf(scan.claudeJson.usage.agents, name) },
  });
  const entity: AgentDefinition = {
    ...base,
    kind: "agent-definition",
    name,
    form: "markdown",
    frontmatter: frontmatter.data,
    // Frontmatter `hooks:` uses the settings shape (`{<Event>: [{matcher, hooks: […]}]}`).
    hooks: hooksOf({ hooks: frontmatter.data["hooks"] }),
  };
  const added = addEntity(scan, entity);
  if (source.plugin !== undefined) providedBy(scan, added.id, source.plugin.entity);
  const description =
    typeof frontmatter.data["description"] === "string" ? frontmatter.data["description"] : "";
  // D39: an agent definition is spawned on demand and no source documents a startup cost for its
  // description, so it never enters the Headline number — for any harness.
  loadedBy(scan, {
    from: added.id,
    project: source.project?.id ?? null,
    mode: "on-demand",
    reason: "spawned on demand; no documented session cost",
    placement: path,
    effectiveName: source.plugin === undefined ? name : `${source.plugin.name}:${name}`,
    ordered: false,
    charsLoaded: description.length,
    importsResolved: null,
    tokensLoaded: scan.ctx.tokenizer.count(description).o200k,
    disableModelInvocation: null,
    countsTowardHeadline: false,
    confidence: "medium",
    evidence: [evidence("listing-rule", "subagent descriptions are listed so Claude can delegate")],
  });
}

export async function collectFrom(scan: ClaudeScan, source: SkillSource): Promise<void> {
  const skillsDir = join(source.dir, "skills");
  for (const entry of (await listDir(skillsDir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    // `synced` is a reserved folder name at every level (research 01 §1), never a skill itself.
    if (entry.name === "synced" || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    const dir = join(skillsDir, entry.name);
    // A `.claude-plugin/plugin.json` beside a `SKILL.md` at user scope makes the directory a
    // **plugin**, not a skill (research 01 §1): `plugins.ts` emits it and its single skill.
    if (
      source.plugin === undefined &&
      source.scope === "user" &&
      (await isFile(join(dir, ".claude-plugin", "plugin.json")))
    )
      continue;
    await skillDirEntity(scan, dir, source);
  }
  const commandsDir = join(source.dir, "commands");
  for (const entry of (await listDir(commandsDir)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isFile() && entry.name.endsWith(".md"))
      await commandEntity(scan, join(commandsDir, entry.name), source);
  }
  const agentsDir = join(source.dir, "agents");
  for (const entry of (await listDir(agentsDir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith(".md"))
      await agentEntity(scan, join(agentsDir, entry.name), source);
  }
}

export async function collectUserSkills(scan: ClaudeScan): Promise<void> {
  await collectFrom(scan, { scope: "user", project: null, dir: scan.paths.configDir });
}

export async function collectProjectSkills(
  scan: ClaudeScan,
  project: DiscoveredProject,
): Promise<void> {
  if (project.reachability !== "present") return;
  for (const member of project.members) {
    if (member.reachability !== "present") continue;
    await collectFrom(scan, { scope: "project", project, dir: join(member.path, ".claude") });
  }
}
