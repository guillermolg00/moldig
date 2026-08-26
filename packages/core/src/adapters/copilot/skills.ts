/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order and the per-Project `order` numbers depend on it */
/**
 * Skills, prompt files and agent definitions (research 02 [72][73][74][79]). One Skill per
 * **real** directory: `~/.copilot/skills/<n>` is usually a symlink into the canonical
 * `~/.agents/skills`, so it becomes a Placement on the store's Skill rather than a second row,
 * and `.github/skills/<n>` — a real directory of its own — is a Skill of the Project. Only
 * descriptions enter a session; a name in `config.json` `disabled_skills[]` keeps even that out.
 * Agent definitions are spawned on demand and never count toward the Headline (D39), and a
 * `.github/agents/<n>.md` without the documented `.agent.md` suffix is emitted with an
 * `unknown` verdict rather than a guess (D69).
 */
import { basename, dirname, join } from "node:path";
import type {
  AgentDefinition,
  GitStatus,
  LoadedByEdge,
  Placement,
  Skill,
} from "../../index/types.js";
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
import { ageDays, toIso } from "../../scan/fs.js";
import { locationMap, locationsOf, type Location } from "./config.js";
import {
  addEntity,
  baseEntity,
  evidence,
  loadedBy,
  type CopilotScan,
  type MemberScope,
} from "./model.js";

/** Frontmatter keys that reach the index, per kind (research 02 [73][74]). */
const PROMPT_KEYS = ["name", "description", "agent", "model", "tools", "argument-hint"];
const AGENT_KEYS = [
  "name",
  "description",
  "tools",
  "model",
  "handoffs",
  "agents",
  "user-invocable",
  "disable-model-invocation",
];

/** The skills directories both surfaces read without any setting (research 02 §Cross-harness). */
const PROJECT_SKILL_DIRS = [".github/skills", ".claude/skills", ".agents/skills"];
const USER_SKILL_DIRS = ["~/.copilot/skills", "~/.agents/skills", "~/.claude/skills"];
const PROJECT_AGENT_DIRS = [".github/agents", ".claude/agents"];
const PROJECT_PROMPT_DIRS = [".github/prompts"];

function projectKeys(
  frontmatter: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in frontmatter) out[key] = frontmatter[key];
  return out;
}

/** `<X>/.agents/skills/<n>` — the canonical store several harnesses link into. */
function inStore(path: string): boolean {
  const skills = dirname(path);
  return basename(skills) === "skills" && basename(dirname(skills)) === ".agents";
}

function sharedOf(gitStatus: GitStatus | null, inProject: boolean): boolean | null {
  if (gitStatus === null || gitStatus === "outside-repo") return null;
  return gitStatus === "tracked" && inProject;
}

export interface SkillSource {
  scope: "user" | "project";
  project: DiscoveredProject | null;
}

function placementOf(
  scan: CopilotScan,
  path: string,
  source: SkillSource,
  isSymlink: boolean,
  linkTarget: string | null,
  dangling: boolean,
): Placement {
  const gitStatus = source.project === null ? "outside-repo" : scan.ctx.gitStatusOf(path);
  return {
    path,
    harness: "copilot",
    // Both surfaces read the same directories (`.github/skills` natively, `~/.copilot/skills`
    // through the default `chat.agentSkillsLocations`), so the placement names no single one.
    surface: null,
    scope: source.scope,
    project: source.project?.id ?? null,
    gitStatus,
    shared: sharedOf(gitStatus, source.scope === "project"),
    isSymlink,
    linkTarget,
    dangling,
  };
}

/** The store directory itself: several harnesses link to it, so it belongs to none of them. */
function storePlacement(scan: CopilotScan, path: string): Placement {
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

function descriptionOf(frontmatter: Record<string, unknown>, body: string): string {
  const description =
    typeof frontmatter["description"] === "string" ? frontmatter["description"] : null;
  // `caps.skillDescriptionChars` is null for Copilot: nothing documents a cap, so the whole
  // description is counted.
  return description ?? body.trim().split(/\n\s*\n/)[0] ?? "";
}

function emitSkillLoad(
  scan: CopilotScan,
  entity: Skill,
  description: string,
  source: SkillSource,
  detail: string,
  enabled: boolean,
): void {
  const mode: LoadedByEdge["mode"] = enabled ? "description-only" : "disabled";
  const reason = enabled
    ? `${source.scope} skill: description listed, body on demand`
    : "listed in disabled_skills";
  loadedBy(scan, {
    from: entity.id,
    project: source.project?.id ?? null,
    mode,
    reason,
    placement: entity.placements.find((item) => item.harness !== null)?.path ?? null,
    effectiveName: entity.name,
    ordered: enabled,
    charsLoaded: enabled ? description.length : 0,
    importsResolved: null,
    tokensLoaded: enabled ? scan.ctx.tokenizer.count(description).o200k : 0,
    disableModelInvocation: null,
    countsTowardHeadline: enabled,
    evidence: [evidence("listing-rule", detail)],
  });
}

async function skillDirEntity(
  scan: CopilotScan,
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
  const intended = dangling && linkTarget !== null ? join(dirname(linkPath), linkTarget) : real;
  const store = inStore(intended);
  const tree = dangling
    ? { files: 0, bytes: 0, newestMs: null, oldestMs: null }
    : await treeStats(real);
  const placements =
    store && !scan.ctx.identity.same(intended, linkPath) && !dangling
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
    // A directory several harnesses reach through their own links belongs to none of them.
    ...(store ? { harness: null } : {}),
    metrics: {
      bytes: tree.bytes,
      files: tree.files,
      lines: text === null ? null : countLines(text),
      mtime: tree.newestMs === null ? null : toIso(tree.newestMs),
      ageDays: tree.newestMs === null ? null : ageDays(tree.newestMs, scan.ctx.options.now),
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
    layout: store ? "canonical" : "copy",
    placements,
    frontmatter: frontmatter.data,
    sidecars: [],
    contentHash: text === null ? [] : [{ algo: "sha256-folder", value: sha256(text) }],
    origin: null,
    // The folder hash and the drift verdict belong to the shared-stores pass (D44).
    drift: "unknown",
  };
  const added = addEntity(scan, entity);
  // A dangling link is still a Skill (ticket 07 "Dangling link"): no session ever loads it.
  if (dangling) return;
  emitSkillLoad(
    scan,
    added,
    descriptionOf(frontmatter.data, frontmatter.body),
    source,
    "skills are listed by description; the body is read on demand",
    !scan.config.disabledSkills.includes(added.name),
  );
}

async function promptEntity(
  scan: CopilotScan,
  path: string,
  source: SkillSource,
  enabled: boolean,
): Promise<void> {
  const text = await readText(path);
  if (text === null) return;
  const frontmatter = parseFrontmatter(text);
  const name = basename(path, ".md").replace(/\.prompt$/, "");
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
    frontmatter: projectKeys(frontmatter.data, PROMPT_KEYS),
    sidecars: [],
    contentHash: [{ algo: "sha256-folder", value: sha256(text) }],
    origin: null,
    drift: "unknown",
  };
  const added = addEntity(scan, entity);
  const description = descriptionOf(frontmatter.data, frontmatter.body);
  loadedBy(scan, {
    from: added.id,
    project: source.project?.id ?? null,
    mode: enabled ? "on-demand" : "disabled",
    reason: enabled
      ? `prompt file: run as /${name}`
      : "location disabled in chat.promptFilesLocations",
    placement: path,
    effectiveName: `/${name}`,
    ordered: false,
    charsLoaded: description.length,
    importsResolved: null,
    tokensLoaded: enabled ? scan.ctx.tokenizer.count(description).o200k : 0,
    disableModelInvocation: null,
    countsTowardHeadline: false,
    // Whether the `/name` listing reaches the model is not documented (D69).
    confidence: "medium",
    evidence: [evidence("listing-rule", "prompt files are invoked by name, not injected")],
  });
}

/** `.agent.md` and the legacy `.chatmode.md` are documented; a plain `.md` is not (D69). */
function agentSuffix(name: string): { stem: string; documented: boolean } | null {
  if (name.endsWith(".agent.md"))
    return { stem: name.slice(0, -".agent.md".length), documented: true };
  if (name.endsWith(".chatmode.md"))
    return { stem: name.slice(0, -".chatmode.md".length), documented: true };
  if (name.endsWith(".md")) return { stem: name.slice(0, -".md".length), documented: false };
  return null;
}

async function agentEntity(
  scan: CopilotScan,
  path: string,
  source: SkillSource,
  documented: boolean,
  stem: string,
  enabled: boolean,
): Promise<void> {
  const text = await readText(path);
  if (text === null) return;
  const frontmatter = parseFrontmatter(text);
  const name = typeof frontmatter.data["name"] === "string" ? frontmatter.data["name"] : stem;
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
    frontmatter: projectKeys(frontmatter.data, AGENT_KEYS),
    hooks: [],
  };
  const added = addEntity(scan, entity);
  const description =
    typeof frontmatter.data["description"] === "string" ? frontmatter.data["description"] : "";
  const manual = frontmatter.data["disable-model-invocation"] === true;
  const mode: LoadedByEdge["mode"] = !enabled
    ? "disabled"
    : documented
      ? manual
        ? "manual"
        : "on-demand"
      : "unknown";
  const reason = !enabled
    ? "location disabled in chat.agentFilesLocations"
    : documented
      ? manual
        ? "disable-model-invocation: only the user can invoke it"
        : "spawned on demand; no documented session cost"
      : "no .agent.md suffix: not a documented agent file name";
  loadedBy(scan, {
    from: added.id,
    project: source.project?.id ?? null,
    mode,
    reason,
    placement: path,
    effectiveName: name,
    ordered: false,
    charsLoaded: description.length,
    importsResolved: null,
    tokensLoaded: mode === "disabled" ? 0 : scan.ctx.tokenizer.count(description).o200k,
    disableModelInvocation: manual ? true : null,
    // D39: an agent definition never counts toward the Headline, for any harness.
    countsTowardHeadline: false,
    confidence: documented ? "medium" : "low",
    evidence: [evidence("listing-rule", reason)],
  });
}

async function skillsIn(scan: CopilotScan, location: Location, source: SkillSource): Promise<void> {
  if (!location.enabled) return;
  for (const entry of (await listDir(location.path)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    await skillDirEntity(scan, join(location.path, entry.name), source);
  }
}

async function agentsIn(scan: CopilotScan, location: Location, source: SkillSource): Promise<void> {
  for (const entry of (await listDir(location.path)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isFile()) continue;
    const suffix = agentSuffix(entry.name);
    if (suffix === null) continue;
    await agentEntity(
      scan,
      join(location.path, entry.name),
      source,
      suffix.documented,
      suffix.stem,
      location.enabled,
    );
  }
}

async function promptsIn(
  scan: CopilotScan,
  location: Location,
  source: SkillSource,
): Promise<void> {
  for (const entry of (await listDir(location.path)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isFile() && entry.name.endsWith(".prompt.md")) {
      await promptEntity(scan, join(location.path, entry.name), source, location.enabled);
    }
  }
}

/** User scope: the skills, agents and prompt files every session of this machine can reach. */
export async function collectUserSkills(scan: CopilotScan): Promise<void> {
  const source: SkillSource = { scope: "user", project: null };
  const { home } = scan.paths;
  const skillLocations = locationsOf(
    locationMap(scan.harnessSettings, "chat.agentSkillsLocations"),
    USER_SKILL_DIRS,
    home,
    home,
  ).filter((location) => location.userScope);
  for (const location of skillLocations) await skillsIn(scan, location, source);
  for (const location of locationsOf(
    locationMap(scan.harnessSettings, "chat.agentFilesLocations"),
    [join(scan.paths.cliHome, "agents")],
    home,
    home,
  ).filter((item) => item.userScope || item.isDefault)) {
    await agentsIn(scan, location, source);
  }
  for (const location of locationsOf(
    locationMap(scan.harnessSettings, "chat.promptFilesLocations"),
    [join(scan.paths.vscodeUser, "prompts"), join(scan.paths.cliHome, "prompts")],
    home,
    home,
  ).filter((item) => item.userScope || item.isDefault)) {
    await promptsIn(scan, location, source);
  }
}

/** Project scope: the skills, agents and prompt files a session started in this member reaches. */
export async function collectMemberSkills(scan: CopilotScan, scope: MemberScope): Promise<void> {
  const source: SkillSource = { scope: "project", project: scope.project };
  const { home } = scan.paths;
  const locationsFor = (key: string, defaults: readonly string[]): Location[] =>
    locationsOf(locationMap(scope.settings, key), defaults, scope.path, home).filter(
      (location) => !location.userScope,
    );
  for (const location of locationsFor("chat.agentSkillsLocations", PROJECT_SKILL_DIRS)) {
    await skillsIn(scan, location, source);
  }
  for (const location of locationsFor("chat.agentFilesLocations", PROJECT_AGENT_DIRS)) {
    await agentsIn(scan, location, source);
  }
  for (const location of locationsFor("chat.promptFilesLocations", PROJECT_PROMPT_DIRS)) {
    await promptsIn(scan, location, source);
  }
}
