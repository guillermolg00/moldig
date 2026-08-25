/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * Skills, commands and agent definitions (research 01 §1–2): `.claude/skills/<name>/SKILL.md`
 * (one Skill per real directory, links are placements), `.claude/commands/<name>.md` (the
 * same mechanism, `form: command-file`) and `.claude/agents/<name>.md`, at user scope and in
 * every present member of a Project. Only descriptions enter a session (1,536 chars cap);
 * `disable-model-invocation: true` keeps even that out.
 */
import { basename, join } from "node:path";
import type { AgentDefinition, Placement, Skill } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import {
  isFile,
  listDir,
  lstatOrNull,
  readText,
  realpathOrSelf,
  sha256,
  treeStats,
} from "../../scan/fs.js";
import { parseFrontmatter } from "../../scan/markdown.js";
import { addEntity, baseEntity, evidence, loadedBy, type ClaudeScan } from "./model.js";

const DESCRIPTION_CHARS = 1536;

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

interface SkillSource {
  scope: "user" | "project";
  project: DiscoveredProject | null;
  dir: string;
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
    shared: gitStatus === null ? null : gitStatus === "tracked" && source.scope === "project",
    isSymlink,
    linkTarget,
    dangling,
  };
}

async function commandEntity(scan: ClaudeScan, path: string, source: SkillSource): Promise<void> {
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
    frontmatterName: null,
    layout: "canonical",
    placements: [placementOf(scan, path, source, false, null, false)],
    frontmatter: frontmatter.data,
    sidecars: [],
    contentHash: [{ algo: "sha256-folder", value: sha256(text) }],
    origin: null,
    drift: "unknown",
  };
  const added = addEntity(scan, entity);
  emitSkillLoad(
    scan,
    added,
    descriptionOf(frontmatter.data, frontmatter.body),
    source,
    `/${name}`,
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
  const tokens = disabled ? 0 : scan.ctx.tokenizer.count(description).o200k;
  loadedBy(scan, {
    from: entity.id,
    project: source.project?.id ?? null,
    mode: disabled ? "manual" : "description-only",
    reason: disabled
      ? "disable-model-invocation: only the user can invoke it, description not in context"
      : `${source.scope} skill`,
    placement: entity.placements[0]?.path ?? null,
    effectiveName,
    ordered: !disabled,
    charsLoaded: disabled ? 0 : description.length,
    importsResolved: null,
    tokensLoaded: tokens,
    disableModelInvocation: disabled,
    countsTowardHeadline: !disabled,
    evidence: [evidence("listing-rule", detail)],
  });
}

async function skillDirEntity(
  scan: ClaudeScan,
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
      lines: text === null ? null : text.split("\n").length,
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
    layout: "canonical",
    placements: [placement],
    frontmatter: frontmatter.data,
    sidecars: [],
    contentHash: text === null ? [] : [{ algo: "sha256-folder", value: sha256(text) }],
    origin: null,
    drift: "unknown",
  };
  const added = addEntity(scan, entity);
  if (!dangling)
    emitSkillLoad(
      scan,
      added,
      descriptionOf(frontmatter.data, frontmatter.body),
      source,
      `/${added.name}`,
      "description listed, body on demand",
    );
}

async function agentEntity(scan: ClaudeScan, path: string, source: SkillSource): Promise<void> {
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
  const added = addEntity(scan, entity);
  const description =
    typeof frontmatter.data["description"] === "string" ? frontmatter.data["description"] : "";
  loadedBy(scan, {
    from: added.id,
    project: source.project?.id ?? null,
    mode: "description-only",
    reason: `${source.scope} agent definition: description listed for delegation, body when spawned`,
    placement: path,
    effectiveName: name,
    ordered: true,
    charsLoaded: description.length,
    importsResolved: null,
    tokensLoaded: scan.ctx.tokenizer.count(description).o200k,
    disableModelInvocation: null,
    countsTowardHeadline: true,
    evidence: [evidence("listing-rule", "subagent descriptions are listed so Claude can delegate")],
  });
}

async function collectFrom(scan: ClaudeScan, source: SkillSource): Promise<void> {
  const skillsDir = join(source.dir, "skills");
  for (const entry of (await listDir(skillsDir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "synced" || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
    await skillDirEntity(scan, join(skillsDir, entry.name), source);
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
