/* oxlint-disable no-await-in-loop -- sequential on purpose: the listing order and the per-Project `order` numbers depend on it */
/**
 * Skills, command files and agent definitions Cursor reads (research 02 [22][24][28]; spec §1.5):
 * `~/.cursor/skills/<n>/` and `<member>/.cursor/skills/<n>/` (recursively, e.g.
 * `apps/web/.cursor/skills/`), the canonical `~/.agents/skills` store and the compat directories
 * of Claude Code and Codex, `~/.cursor/skills-cursor/*` (bundled), `.cursor/commands/<cmd>.md` and
 * `.cursor/agents/<n>.md`.
 *
 * One Skill per **real** directory (ticket 07 Q1): every path a harness reaches it through is a
 * Placement, and `placement.harness` is the harness whose directory that path is in — so the
 * symlink `~/.cursor/skills/find-skills` is a Cursor placement on the store's Skill, not a second
 * entity. Only descriptions enter a session; `paths:` and `disable-model-invocation` keep even
 * that out. An agent definition costs nothing at startup (D39).
 */
import { basename, dirname, join } from "node:path";
import type {
  AgentDefinition,
  GitStatus,
  HarnessId,
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
import { addEntity, baseEntity, evidence, loadedBy, HARNESS, type CursorScan } from "./model.js";
import { nestedDirs } from "./context-files.js";

export interface SkillSource {
  scope: "user" | "project";
  project: DiscoveredProject | null;
  /** The directory holding `skills/`, `commands/` and `agents/` (`~/.cursor`, `<member>/.agents`…). */
  dir: string;
  /** Whose directory it is — `null` for the store several harnesses share (ticket 07 §4). */
  harness: HarnessId | null;
  /** Cursor's own directory: it also holds command files and agent definitions moldig owns. */
  own: boolean;
  /** The surface recorded on placements in this directory (`null` = every surface reads it). */
  surface: string | null;
}

function descriptionOf(frontmatter: Record<string, unknown>, body: string): string {
  const description =
    typeof frontmatter["description"] === "string" ? frontmatter["description"] : null;
  // No documented cap for Cursor (`caps.skillDescriptionChars: null`): the whole description counts.
  return description ?? body.trim().split(/\n\s*\n/)[0] ?? "";
}

function hasPathsScope(frontmatter: Record<string, unknown>): boolean {
  const paths = frontmatter["paths"];
  return Array.isArray(paths) ? paths.length > 0 : typeof paths === "string" && paths !== "";
}

function sharedOf(gitStatus: GitStatus | null, inProject: boolean): boolean | null {
  if (gitStatus === null || gitStatus === "outside-repo") return null;
  return gitStatus === "tracked" && inProject;
}

function placementOf(
  scan: CursorScan,
  path: string,
  source: SkillSource,
  isSymlink: boolean,
  linkTarget: string | null,
  dangling: boolean,
): Placement {
  const gitStatus = source.project === null ? "outside-repo" : scan.ctx.gitStatusOf(path);
  return {
    path,
    harness: source.harness,
    surface: source.surface,
    scope: source.scope,
    project: source.project?.id ?? null,
    gitStatus,
    shared: sharedOf(gitStatus, source.scope === "project"),
    isSymlink,
    linkTarget,
    dangling,
  };
}

/** The store directory itself: it belongs to no harness, so the row reads "shared by N harnesses". */
function storePlacement(scan: CursorScan, path: string): Placement {
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

/** `<X>/.agents/skills/<name>` — the canonical store a skills CLI installs into (D43). */
function inStore(path: string): boolean {
  const skills = dirname(path);
  return basename(skills) === "skills" && basename(dirname(skills)) === ".agents";
}

interface LoadInput {
  entity: Skill;
  description: string;
  project: DiscoveredProject | null;
  placement: string | null;
  reason: string;
  bundled?: boolean;
}

function emitSkillLoad(scan: CursorScan, input: LoadInput): void {
  const { entity } = input;
  const disabled = entity.frontmatter["disable-model-invocation"] === true;
  const scoped = hasPathsScope(entity.frontmatter);
  const listed = !disabled && !scoped;
  const mode: LoadedByEdge["mode"] = disabled
    ? "manual"
    : scoped
      ? "on-demand"
      : "description-only";
  const reason = disabled
    ? "disable-model-invocation: only the user can invoke it, description not in context"
    : scoped
      ? "paths-scoped skill: attached when matching files are in context"
      : input.reason;
  loadedBy(scan, {
    from: entity.id,
    project: input.project?.id ?? null,
    mode,
    reason,
    placement: input.placement,
    effectiveName: `/${entity.name}`,
    ordered: listed,
    charsLoaded: listed ? input.description.length : 0,
    tokensLoaded: listed ? scan.ctx.tokenizer.count(input.description).o200k : 0,
    disableModelInvocation: disabled,
    countsTowardHeadline: listed,
    evidence: [evidence("listing-rule", reason)],
  });
}

export interface SkillOptions {
  /** Bundled skills ship with the harness: harness-owned, never removable (ticket 07 §4). */
  bundled?: boolean;
}

export async function skillDirEntity(
  scan: CursorScan,
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
  const parsed = parseFrontmatter(text ?? "");
  const dirName = basename(linkPath);
  const frontmatterName = typeof parsed.data["name"] === "string" ? parsed.data["name"] : null;
  // A dangling link is still a Skill (ticket 07 "Dangling link"): its path is the link path.
  const path = dangling ? linkPath : real;
  const placement = placementOf(scan, linkPath, source, isSymlink, linkTarget, dangling);
  const existing = scan.entities.get(scan.ctx.id("skill", path));
  if (existing !== undefined && existing.kind === "skill") {
    if (!existing.placements.some((item) => scan.ctx.identity.same(item.path, linkPath)))
      existing.placements.push(placement);
    return;
  }
  const store = !dangling && inStore(real);
  const tree = dangling ? { files: 0, bytes: 0, newestMs: null } : await treeStats(real);
  const placements =
    store && !scan.ctx.identity.same(real, linkPath)
      ? [storePlacement(scan, real), placement]
      : [placement];
  const base = baseEntity(scan, {
    kind: "skill",
    path,
    scope: source.scope,
    project: dangling ? source.project : (scan.ctx.discovery.projectOf(path) ?? source.project),
    ownership: options.bundled === true ? "harness" : "human",
    locator: { type: "dir", path },
    format: "dir",
    label: frontmatterName ?? dirName,
    sensitive: false,
    protection: options.bundled === true ? "never" : "none",
    removal: options.bundled === true ? { method: "none" } : { method: "trash" },
    // A directory several harnesses reach through their own links belongs to none of them.
    harness: store ? null : source.harness,
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
    layout: options.bundled === true ? "bundled" : store ? "canonical" : "copy",
    placements,
    frontmatter: parsed.data,
    sidecars: [],
    contentHash: text === null ? [] : [{ algo: "sha256-folder", value: sha256(text) }],
    // The lock files are the shared stores' business (ticket 22): this adapter claims no origin.
    origin: null,
    drift: "unknown",
  };
  const added = addEntity(scan, entity);
  if (dangling) return;
  emitSkillLoad(scan, {
    entity: added,
    description: descriptionOf(parsed.data, parsed.body),
    project: source.project,
    placement: linkPath,
    reason:
      options.bundled === true
        ? "bundled skill: description listed, body on demand"
        : `${source.scope} skill: description listed, body on demand`,
  });
}

/** `.cursor/commands/<cmd>.md`: a Skill of form `command-file`, listed as `/<cmd>` (07 §3). */
async function commandEntity(scan: CursorScan, path: string, source: SkillSource): Promise<void> {
  const text = await readText(path);
  if (text === null) return;
  const parsed = parseFrontmatter(text);
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
    frontmatterName: typeof parsed.data["name"] === "string" ? parsed.data["name"] : null,
    layout: "canonical",
    placements: [placementOf(scan, path, source, false, null, false)],
    frontmatter: parsed.data,
    sidecars: [],
    contentHash: [{ algo: "sha256-folder", value: sha256(text) }],
    origin: null,
    drift: "unknown",
  };
  const added = addEntity(scan, entity);
  emitSkillLoad(scan, {
    entity: added,
    description: descriptionOf(parsed.data, parsed.body),
    project: source.project,
    placement: path,
    reason: `command file: listed as /${name}`,
  });
}

/** `.cursor/agents/<n>.md`: listed for delegation, spawned on demand — never in the number (D39). */
async function agentEntity(scan: CursorScan, path: string, source: SkillSource): Promise<void> {
  const text = await readText(path);
  if (text === null) return;
  const parsed = parseFrontmatter(text);
  const name =
    typeof parsed.data["name"] === "string" ? parsed.data["name"] : basename(path, ".md");
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
    harness: source.harness,
    metrics: await scan.ctx.fileMetrics(path, text),
  });
  const entity: AgentDefinition = {
    ...base,
    kind: "agent-definition",
    name,
    form: "markdown",
    frontmatter: parsed.data,
    hooks: [],
  };
  const added = addEntity(scan, entity);
  const description =
    typeof parsed.data["description"] === "string" ? parsed.data["description"] : "";
  loadedBy(scan, {
    from: added.id,
    project: source.project?.id ?? null,
    mode: "on-demand",
    reason: "spawned on demand; no documented session cost",
    placement: path,
    effectiveName: name,
    ordered: false,
    charsLoaded: description.length,
    tokensLoaded: scan.ctx.tokenizer.count(description).o200k,
    countsTowardHeadline: false,
    confidence: "medium",
    evidence: [evidence("listing-rule", "agent descriptions are listed so Cursor can delegate")],
  });
}

/** Every skill directory of one source, sorted; `commands/` and `agents/` when Cursor owns it. */
export async function collectFrom(
  scan: CursorScan,
  source: SkillSource,
  skillsOnly = false,
): Promise<void> {
  const skillsDir = join(source.dir, "skills");
  for (const entry of (await listDir(skillsDir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    await skillDirEntity(scan, join(skillsDir, entry.name), source);
  }
  if (skillsOnly) return;
  if (source.own) {
    const commandsDir = join(source.dir, "commands");
    for (const entry of (await listDir(commandsDir)).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      if (entry.isFile() && entry.name.endsWith(".md"))
        await commandEntity(scan, join(commandsDir, entry.name), source);
    }
  }
  if (source.harness === null) return;
  const agentsDir = join(source.dir, "agents");
  for (const entry of (await listDir(agentsDir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isFile() && entry.name.endsWith(".md"))
      await agentEntity(scan, join(agentsDir, entry.name), source);
  }
}

/** The directories a user-scope session reads, Cursor's own first (research 02 §Cross-harness). */
function userSources(scan: CursorScan): SkillSource[] {
  const home = scan.paths.home;
  return [
    {
      scope: "user",
      project: null,
      dir: scan.paths.configDir,
      harness: HARNESS,
      own: true,
      surface: null,
    },
    {
      scope: "user",
      project: null,
      dir: join(home, ".agents"),
      harness: null,
      own: false,
      surface: null,
    },
    {
      scope: "user",
      project: null,
      dir: join(home, ".claude"),
      harness: "claude-code",
      own: false,
      surface: "cli",
    },
    {
      scope: "user",
      project: null,
      dir: join(home, ".codex"),
      harness: "codex",
      own: false,
      surface: "cli",
    },
  ];
}

export async function collectUserSkills(scan: CursorScan): Promise<void> {
  for (const source of userSources(scan)) await collectFrom(scan, source);
  // `~/.cursor/skills-cursor/*`: shipped by Cursor itself — harness-owned, never removable.
  const bundled = join(scan.paths.configDir, "skills-cursor");
  for (const entry of (await listDir(bundled)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    await skillDirEntity(
      scan,
      join(bundled, entry.name),
      {
        scope: "user",
        project: null,
        dir: bundled,
        harness: HARNESS,
        own: false,
        surface: null,
      },
      { bundled: true },
    );
  }
}

export async function collectProjectSkills(
  scan: CursorScan,
  project: DiscoveredProject,
): Promise<void> {
  if (project.reachability !== "present") return;
  for (const member of project.members) {
    if (member.reachability !== "present") continue;
    const sources: SkillSource[] = [
      {
        scope: "project",
        project,
        dir: join(member.path, ".cursor"),
        harness: HARNESS,
        own: true,
        surface: null,
      },
      {
        scope: "project",
        project,
        dir: join(member.path, ".agents"),
        harness: null,
        own: false,
        surface: null,
      },
      {
        scope: "project",
        project,
        dir: join(member.path, ".claude"),
        harness: "claude-code",
        own: false,
        surface: "cli",
      },
      {
        scope: "project",
        project,
        dir: join(member.path, ".codex"),
        harness: "codex",
        own: false,
        surface: "cli",
      },
    ];
    for (const source of sources) await collectFrom(scan, source);
    // Research 02 [22]: project skills are discovered recursively (`apps/web/.cursor/skills/`).
    for (const dir of await nestedDirs(member.path)) {
      await collectFrom(
        scan,
        {
          scope: "project",
          project,
          dir: join(dir, ".cursor"),
          harness: HARNESS,
          own: true,
          surface: null,
        },
        true,
      );
    }
  }
}
