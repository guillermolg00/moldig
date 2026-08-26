/* oxlint-disable no-await-in-loop -- sequential on purpose: the discovery order decides which path becomes the placement */
/**
 * Codex's three generations of skill directories, in the order it discovers them (research 02
 * §Skills): `<dir>/.codex/skills` and `<dir>/.agents/skills` for every directory root→session
 * dir, then `$CODEX_HOME/skills`, `~/.agents/skills` and finally the bundled `$CODEX_HOME/skills/
 * .system`. `/etc/codex/skills` is not read in v1 (D56).
 *
 * One Skill per **real** directory; every path that reaches it is a Placement, and a placement
 * under a `.agents/skills` store carries `harness: null` because the store belongs to no harness
 * (ticket 07 Q1). Only a skill's name and description enter a session; `SKILL.md` is read on
 * demand, which is what `mode: "description-only"` records.
 */
import { basename, dirname, join } from "node:path";
import type {
  DuplicatesEdge,
  GitStatus,
  LoadedByEdge,
  Placement,
  Skill,
} from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import {
  countLines,
  isFile,
  isRecord,
  listDir,
  lstatOrNull,
  readText,
  realpathOrSelf,
  treeStats,
} from "../../scan/fs.js";
import { parseFrontmatter } from "../../scan/markdown.js";
import { ageDays, toIso } from "../../scan/fs.js";
import { edgeId } from "../../scan/paths.js";
import {
  addEdge,
  addEntity,
  baseEntity,
  evidence,
  loadedBy,
  sessionDirOf,
  trustOf,
  type CodexScan,
} from "./model.js";
import { folderHash } from "./folder-hash.js";
import { bundledSkillsEnabled, skillConfig } from "./state.js";
import { ancestors, isUnder } from "../../scan/paths.js";

const SYSTEM_DIR = ".system";
const SYSTEM_MARKER = ".codex-system-skills.marker";
const OPENAI_SIDECAR = join("agents", "openai.yaml");

/** Codex lists every skill's name and description; the body is fetched only when invoked. */
const LISTING_RULE =
  "name and description listed, SKILL.md on demand (≤ 2 % of the context window or 8,000 chars for the whole list)";

export interface SkillSource {
  /** Where in Codex's discovery order this directory sits — lower reaches the skill first. */
  order: number;
  scope: "user" | "project" | "system";
  project: DiscoveredProject | null;
  /** `skills/` directory being listed. */
  dir: string;
  /** `true` for `.agents/skills` — the store belongs to no single harness. */
  store: boolean;
  bundled?: boolean;
  /** Why the verdict is what it is: `user skill`, `project skill`, `bundled skill`. */
  reason: string;
  /** Trust of the Project when the location is one Codex gates on it (`.codex/skills`). */
  gated?: boolean;
}

function sharedOf(gitStatus: GitStatus | null, inProject: boolean): boolean | null {
  if (gitStatus === null || gitStatus === "outside-repo") return null;
  return gitStatus === "tracked" && inProject;
}

function placementOf(
  scan: CodexScan,
  path: string,
  source: SkillSource,
  isSymlink: boolean,
  linkTarget: string | null,
  dangling: boolean,
): Placement {
  const gitStatus = source.project === null ? "outside-repo" : scan.ctx.gitStatusOf(path);
  return {
    path,
    harness: source.store ? null : "codex",
    surface: source.store ? null : "cli",
    scope: source.scope,
    project: source.project?.id ?? null,
    gitStatus,
    shared: sharedOf(gitStatus, source.scope === "project"),
    isSymlink,
    linkTarget,
    dangling,
  };
}

/** The store directory itself, listed beside the harness's link: it belongs to no harness. */
function storePlacement(scan: CodexScan, path: string): Placement {
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

function descriptionOf(frontmatter: Record<string, unknown>, name: string): string {
  const description =
    typeof frontmatter["description"] === "string" ? frontmatter["description"] : "";
  return `${name} ${description}`.trim();
}

/**
 * `agents/openai.yaml` — Codex's own sidecar. Only `policy.allow_implicit_invocation` changes a
 * verdict (D59, confidence `medium`: the key name is read, no loading rule is published). The file
 * is parsed with the shared frontmatter reader, which covers exactly this shape.
 */
async function allowsImplicitInvocation(dir: string): Promise<boolean | null> {
  const text = await readText(join(dir, OPENAI_SIDECAR));
  if (text === null) return null;
  const parsed = parseFrontmatter(`---\n${text.trimEnd()}\n---\n`);
  const policy = parsed.data["policy"];
  if (!isRecord(policy)) return null;
  const value = policy["allow_implicit_invocation"];
  return typeof value === "boolean" ? value : null;
}

interface Verdict {
  mode: LoadedByEdge["mode"];
  reason: string;
  counts: boolean;
  confidence: "certain" | "medium";
  disableModelInvocation: boolean | null;
}

function verdictOf(
  scan: CodexScan,
  entity: Skill,
  source: SkillSource,
  implicit: boolean | null,
): Verdict {
  if (source.bundled === true && !bundledSkillsEnabled(scan.raw)) {
    return {
      mode: "disabled",
      reason: "skills.bundled = false",
      counts: false,
      confidence: "certain",
      disableModelInvocation: null,
    };
  }
  const fold = scan.ctx.identity.fold;
  const disabled = skillConfig(scan.raw).find(
    (item) =>
      item.enabled === false &&
      ((item.path !== null && fold(item.path) === fold(entity.path)) || item.name === entity.name),
  );
  if (disabled !== undefined) {
    return {
      mode: "disabled",
      reason: "disabled in [[skills.config]]",
      counts: false,
      confidence: "certain",
      disableModelInvocation: null,
    };
  }
  if (source.gated === true) {
    const trusted = source.project === null ? null : trustOf(scan, source.project);
    if (trusted === false) {
      return {
        mode: "never",
        reason: "untrusted project",
        counts: false,
        confidence: "certain",
        disableModelInvocation: null,
      };
    }
    if (trusted === null) {
      return {
        mode: "unknown",
        reason: "no trust entry: Codex asks before loading the project layer",
        counts: false,
        confidence: "certain",
        disableModelInvocation: null,
      };
    }
  }
  if (implicit === false) {
    return {
      mode: "manual",
      reason: "allow_implicit_invocation: false — only the user can invoke it",
      counts: false,
      confidence: "medium",
      disableModelInvocation: true,
    };
  }
  return {
    mode: "description-only",
    reason: source.reason,
    // A bundled skill is not user-controllable, so it never enters the Headline number.
    counts: source.bundled !== true,
    confidence: "certain",
    disableModelInvocation: implicit === null ? null : false,
  };
}

/** Every real skill directory this adapter emitted, for the duplicates pass. */
export const skillSources: WeakMap<Skill, SkillSource> = new WeakMap();

async function skillDirEntity(
  scan: CodexScan,
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
    if (!existing.placements.some((item) => scan.ctx.identity.same(item.path, linkPath))) {
      existing.placements.push(placement);
    }
    return;
  }

  const intended = dangling && linkTarget !== null ? join(dirname(linkPath), linkTarget) : real;
  const store = inStore(intended);
  const placements =
    store && !scan.ctx.identity.same(intended, linkPath) && !dangling
      ? [storePlacement(scan, real), placement]
      : [placement];
  const tree = dangling
    ? { files: 0, bytes: 0, newestMs: null, oldestMs: null }
    : await treeStats(real);
  const sidecars = dangling || !(await isFile(join(real, OPENAI_SIDECAR))) ? [] : [OPENAI_SIDECAR];
  const bundled = source.bundled === true;
  const base = baseEntity(scan, {
    kind: "skill",
    path,
    scope: source.scope,
    project: dangling ? source.project : (scan.ctx.discovery.projectOf(path) ?? source.project),
    // A bundled skill is the harness's own copy: never edited, never removed (07 point 4).
    ownership: bundled ? "harness" : "human",
    locator: { type: "dir", path },
    format: "dir",
    label: frontmatterName ?? dirName,
    sensitive: false,
    protection: bundled ? "never" : "none",
    removal: bundled ? { method: "none" } : { method: "trash" },
    harness: store ? null : "codex",
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
    // D43: `bundled` for the harness's own tier, `canonical` for a real directory in a store,
    // `copy` for anything else. Codex installs nothing itself, so `synced`/`plugin` never apply.
    layout: bundled ? "bundled" : store ? "canonical" : "copy",
    placements,
    frontmatter: frontmatter.data,
    sidecars,
    // A real `sha256-folder` over the directory: two copies of one public skill differ by their
    // payloads even when their `SKILL.md` bytes are identical (fixture edge case 9).
    contentHash: dangling ? [] : [{ algo: "sha256-folder", value: await folderHash(real) }],
    // The shared-stores adapter attaches origins from the locks (ticket 14 §2); D44 leaves drift.
    origin: null,
    drift: "unknown",
  };
  const added = addEntity(scan, entity);
  skillSources.set(added, source);
  // A dangling link is still a Skill (07 "Dangling link"): the Orphan finding targets it, and no
  // session ever loads it.
  if (dangling) return;
  const implicit = await allowsImplicitInvocation(real);
  const verdict = verdictOf(scan, added, source, implicit);
  const description = descriptionOf(frontmatter.data, added.name);
  const listed = verdict.mode === "description-only";
  loadedBy(scan, {
    from: added.id,
    project: source.project?.id ?? null,
    mode: verdict.mode,
    reason: verdict.reason,
    placement: linkPath,
    effectiveName: added.name,
    ordered: listed && verdict.counts,
    charsLoaded: listed ? description.length : 0,
    importsResolved: null,
    tokensLoaded: listed ? scan.ctx.tokenizer.count(description).o200k : 0,
    disableModelInvocation: verdict.disableModelInvocation,
    countsTowardHeadline: listed && verdict.counts,
    confidence: verdict.confidence,
    evidence: [evidence("listing-rule", LISTING_RULE)],
  });
}

async function collectFrom(scan: CodexScan, source: SkillSource): Promise<void> {
  for (const entry of (await listDir(source.dir)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    // `.system` is the bundled tier, listed by its own source; its marker file is not an entity.
    if (entry.name === SYSTEM_DIR || entry.name === SYSTEM_MARKER) continue;
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    await skillDirEntity(scan, join(source.dir, entry.name), source);
  }
}

/**
 * Project scope, discovery order 1–2: `<dir>/.codex/skills` then `<dir>/.agents/skills`, for every
 * directory from the project root down to the session directory. `.codex/skills` is a layer Codex
 * loads only in a trusted Project; `.agents/skills` is the universal location and is not gated.
 */
export async function collectProjectSkills(
  scan: CodexScan,
  project: DiscoveredProject,
): Promise<void> {
  if (project.reachability !== "present") return;
  const fold = scan.ctx.identity.fold;
  const session = sessionDirOf(scan, project);
  for (const member of project.members) {
    if (member.reachability !== "present") continue;
    const from = fold(session.member) === fold(member.path) ? session.dir : member.path;
    const levels = ancestors(from)
      .filter((dir) => isUnder(fold(dir), fold(member.path)))
      .toReversed();
    for (const dir of levels) {
      await collectFrom(scan, {
        order: 1,
        scope: "project",
        project,
        dir: join(dir, ".codex", "skills"),
        store: false,
        reason: "project skill",
        gated: true,
      });
      await collectFrom(scan, {
        order: 2,
        scope: "project",
        project,
        dir: join(dir, ".agents", "skills"),
        store: true,
        reason: "project skill",
      });
    }
  }
}

/** User scope, discovery order 3–4 and 6: the harness dir, the shared store, the bundled tier. */
export async function collectUserSkills(scan: CodexScan): Promise<void> {
  await collectFrom(scan, {
    order: 3,
    scope: "user",
    project: null,
    dir: scan.paths.skills,
    store: false,
    reason: "user skill",
  });
  await collectFrom(scan, {
    order: 4,
    scope: "user",
    project: null,
    dir: scan.paths.userAgents,
    store: true,
    reason: "user skill",
  });
  await collectFrom(scan, {
    order: 6,
    scope: "system",
    project: null,
    dir: scan.paths.systemSkills,
    store: false,
    bundled: true,
    reason: "bundled skill",
  });
}

/**
 * Skills that carry the same name at two roots coexist in Codex — no `shadows` edge (research 02).
 * Two real directories are `duplicates`: `content` when their folder hashes match, `name` when
 * only the name does. The drift verdict between them is the detectors' (D9/D80).
 */
export function skillDuplicates(scan: CodexScan): void {
  const byName = new Map<string, Skill[]>();
  for (const entity of scan.entities.values()) {
    if (entity.kind !== "skill") continue;
    byName.set(entity.name, [...(byName.get(entity.name) ?? []), entity]);
  }
  for (const [, group] of byName) {
    const sorted = group.toSorted((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const from = sorted[i];
        const to = sorted[j];
        if (from === undefined || to === undefined) continue;
        const fromHash = from.contentHash[0]?.value ?? null;
        const toHash = to.contentHash[0]?.value ?? null;
        const same = fromHash !== null && fromHash === toHash;
        const edge: DuplicatesEdge = {
          id: edgeId("duplicates", from.id, to.id),
          kind: "duplicates",
          from: from.id,
          to: to.id,
          confidence: same ? "certain" : "medium",
          evidence: [
            same
              ? evidence("content-hash", `sha256-folder ${fromHash?.slice(0, 12) ?? ""}`)
              : evidence("name-only", from.name),
          ],
          same: same ? "content" : "name",
        };
        addEdge(scan, edge);
      }
    }
  }
}
