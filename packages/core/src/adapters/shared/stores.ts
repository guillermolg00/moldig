/* oxlint-disable no-await-in-loop -- sequential on purpose: one store, one skill, one link dir at a time keeps disk IO bounded and the emission order stable */
/**
 * The canonical skill stores of the Vercel `skills` CLI (research 04; ticket 06 §12–13):
 * `~/.agents/skills/<name>/` at user scope and `<member>/.agents/skills/<name>/` in every present
 * member of every present Project. One Skill per **real** directory (ADR-0007) with the store's
 * own Placement — `harness: null`, because several harnesses reach it — plus a Placement for every
 * symlink into it from a Vercel agent moldig has no adapter for (07 point 7: scanned for symlinks
 * only, never an entity of their own, and never a `loaded-by` edge).
 *
 * A matched lock entry fills `Origin` and an `originates-from` edge; a `.git` inside the directory
 * is the `git-clone` installer instead (14 §2, D42). Content hashes and the drift verdict follow
 * D44: only a 40-hex `git-tree-sha1` the lock records is ever compared.
 */
import { readlink } from "node:fs/promises";
import { join } from "node:path";
import type { GitStatus, OriginatesFromEdge, Placement, Skill } from "../../index/types.js";
import {
  countLines,
  isDirectory,
  isFile,
  listDir,
  lstatOrNull,
  readText,
  realpathOrSelf,
  treeStats,
} from "../../scan/fs.js";
import { parseFrontmatter } from "../../scan/markdown.js";
import { edgeId } from "../../scan/paths.js";
import { gitTreeSha1, sha256Folder } from "./hashes.js";
import { gitCloneOrigin, lockLocator, originOf, type LockEntry } from "./locks.js";
import {
  addEdge,
  addEntity,
  baseEntity,
  evidence,
  type SharedScan,
  type StoreDir,
} from "./model.js";

/** The known sidecar files ticket 07 lists, in a fixed order. */
const SIDECARS = [join(".claude-plugin", "plugin.json"), join("agents", "openai.yaml")];

/**
 * Vercel's agent table (research 02 [118]) minus the six harnesses moldig v1 adapts: directories
 * that hold nothing but symlinks into a canonical store. Their presence is a Placement and never
 * an entity — no app, no configuration, no loading rule moldig could quote.
 */
interface LinkAgent {
  id: string;
  /** Home-relative directory, forward slashes. */
  userDir: string;
  /** Member-relative directory; `null` when the agent's project dir *is* the canonical store. */
  projectDir: string | null;
}

const LINK_AGENTS: readonly LinkAgent[] = [
  { id: "windsurf", userDir: ".codeium/windsurf/skills", projectDir: ".windsurf/skills" },
  { id: "cline", userDir: ".cline/skills", projectDir: ".cline/skills" },
  { id: "kiro", userDir: ".kiro/skills", projectDir: ".kiro/skills" },
  { id: "factory", userDir: ".factory/skills", projectDir: ".factory/skills" },
  { id: "continue", userDir: ".continue/skills", projectDir: ".continue/skills" },
  { id: "roo", userDir: ".roo/skills", projectDir: ".roo/skills" },
  { id: "qwen-code", userDir: ".qwen/skills", projectDir: ".qwen/skills" },
  { id: "goose", userDir: ".config/goose/skills", projectDir: ".goose/skills" },
  { id: "trae", userDir: ".trae/skills", projectDir: null },
  { id: "kilo", userDir: ".kilocode/skills", projectDir: ".kilocode/skills" },
  { id: "augment", userDir: ".augment/rules", projectDir: null },
  { id: "amp", userDir: ".config/agents/skills", projectDir: null },
  { id: "junie", userDir: ".junie/skills", projectDir: ".junie/skills" },
  { id: "openhands", userDir: ".openhands/skills", projectDir: ".openhands/skills" },
  { id: "antigravity", userDir: ".gemini/antigravity/skills", projectDir: null },
];

function sharedOf(gitStatus: GitStatus | null, inProject: boolean): boolean | null {
  if (gitStatus === null || gitStatus === "outside-repo") return null;
  return gitStatus === "tracked" && inProject;
}

function placementOf(
  scan: SharedScan,
  input: {
    path: string;
    harness: string | null;
    scope: "user" | "project";
    isSymlink: boolean;
    linkTarget: string | null;
    dangling: boolean;
  },
): Placement {
  const project = scan.ctx.discovery.projectOf(input.path);
  const gitStatus = project === null ? "outside-repo" : scan.ctx.gitStatusOf(input.path);
  return {
    path: input.path,
    harness: input.harness,
    // These agents ship no surface moldig models; the canonical directory belongs to no harness.
    surface: null,
    scope: input.scope,
    project: project?.id ?? null,
    gitStatus,
    shared: sharedOf(gitStatus, input.scope === "project"),
    isSymlink: input.isSymlink,
    linkTarget: input.linkTarget,
    dangling: input.dangling,
  };
}

/** The link text verbatim (07 Placement): never resolved, never normalised. */
async function linkTargetOf(path: string, isSymlink: boolean): Promise<string | null> {
  return isSymlink ? readlink(path).catch(() => null) : null;
}

/**
 * Ticket 06 §13: the entry that speaks for a store directory is the one whose store directory *is*
 * it; failing that, the entry of the same name in a lock of the same scope. D75 puts the
 * `XDG_STATE_HOME` lock first, so it wins for a name present in both.
 */
function lockEntryFor(
  scan: SharedScan,
  store: StoreDir,
  real: string,
  name: string,
): LockEntry | null {
  const same = scan.ctx.identity.same;
  const locks = scan.locks.filter((lock) =>
    store.scope === "user"
      ? lock.scope === "user"
      : lock.project !== null && lock.project.id === store.project?.id,
  );
  for (const lock of locks) {
    const exact = lock.entries.find((entry) => same(entry.storeDir, real));
    if (exact !== undefined) return exact;
  }
  for (const lock of locks) {
    const named = lock.entries.find((entry) => entry.name === name);
    if (named !== undefined) return named;
  }
  return null;
}

/** D44: a lock's 40-hex value is the only hash moldig can reproduce, and win32 hides the mode bits. */
async function hashesOf(
  scan: SharedScan,
  dir: string,
  entry: LockEntry | null,
): Promise<{ hashes: Skill["contentHash"]; gitTree: string | null }> {
  const wantsGitTree =
    entry?.recordedHash?.algo === "git-tree-sha1" && scan.ctx.options.platform !== "win32";
  const gitTree = wantsGitTree ? await gitTreeSha1(dir) : null;
  const folder = await sha256Folder(dir);
  const hashes: Skill["contentHash"] = [];
  if (gitTree !== null) hashes.push({ algo: "git-tree-sha1", value: gitTree });
  if (folder !== null) hashes.push({ algo: "sha256-folder", value: folder });
  return { hashes, gitTree };
}

function driftOf(entry: LockEntry | null, gitTree: string | null): Skill["drift"] {
  const recorded = entry?.recordedHash ?? null;
  if (recorded === null || recorded.algo !== "git-tree-sha1" || gitTree === null) return "unknown";
  return recorded.value.toLowerCase() === gitTree ? "none" : "local-modified";
}

function attachOrigin(scan: SharedScan, entity: Skill, entry: LockEntry): void {
  entity.origin = originOf(entry);
  const to = scan.ctx.id("settings-file", entry.file);
  const edge: OriginatesFromEdge = {
    id: edgeId("originates-from", entity.id, to),
    kind: "originates-from",
    from: entity.id,
    to,
    confidence: "certain",
    evidence: [evidence("lock-entry", `skills.${entry.name}`, lockLocator(entry))],
  };
  addEdge(scan, edge);
}

async function storeSkill(scan: SharedScan, store: StoreDir, name: string): Promise<void> {
  const linkPath = join(store.dir, name);
  const stats = await lstatOrNull(linkPath);
  if (stats === null) return;
  const isSymlink = stats.isSymbolicLink();
  const linkTarget = await linkTargetOf(linkPath, isSymlink);
  const real = await realpathOrSelf(linkPath);
  const dangling = !(await isFile(join(real, "SKILL.md")));
  // 07 "Dangling link": a link that points at nothing is still one Skill, keyed on the link path.
  const path = dangling ? linkPath : real;
  const known = scan.skills.get(scan.ctx.identity.fold(path));
  if (known !== undefined) {
    // One store linking into another: one Skill, a second Placement (ADR-0007).
    if (!known.placements.some((item) => scan.ctx.identity.same(item.path, linkPath))) {
      known.placements.push(
        placementOf(scan, {
          path: linkPath,
          harness: null,
          scope: store.scope,
          isSymlink,
          linkTarget,
          dangling,
        }),
      );
    }
    return;
  }
  const text = dangling ? null : await readText(join(real, "SKILL.md"));
  const frontmatter = parseFrontmatter(text ?? "");
  const frontmatterName =
    typeof frontmatter.data["name"] === "string" ? frontmatter.data["name"] : null;
  const tree = dangling
    ? { files: 0, bytes: 0, newestMs: null, oldestMs: null }
    : await treeStats(real);
  const entry = lockEntryFor(scan, store, real, name);
  const { hashes, gitTree } = dangling
    ? { hashes: [], gitTree: null }
    : await hashesOf(scan, real, entry);
  const sidecars: string[] = [];
  for (const sidecar of SIDECARS) {
    if (!dangling && (await isFile(join(real, sidecar)))) sidecars.push(sidecar);
  }
  const project = scan.ctx.discovery.projectOf(path) ?? store.project;
  const base = baseEntity(scan, {
    kind: "skill",
    path,
    scope: store.scope,
    project,
    ownership: "human",
    locator: { type: "dir", path },
    format: "dir",
    label: frontmatterName ?? name,
    sensitive: false,
    protection: "none",
    // Ticket 14 §1: Delete trashes the directory and backup-edits the lock; `npx skills remove`
    // is never delegated to.
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
    kind: "skill",
    form: "skill-dir",
    name: frontmatterName ?? name,
    dirName: name,
    frontmatterName,
    // D43: the real directory sits in a skills store.
    layout: "canonical",
    placements: [
      placementOf(scan, {
        path: linkPath,
        harness: null,
        scope: store.scope,
        isSymlink,
        linkTarget,
        dangling,
      }),
    ],
    frontmatter: frontmatter.data,
    sidecars,
    contentHash: hashes,
    origin: null,
    drift: driftOf(entry, gitTree),
  };
  const added = addEntity(scan, entity);
  if (entry !== null) attachOrigin(scan, added, entry);
  else if (!dangling && (await isDirectory(join(real, ".git"))))
    added.origin = await gitCloneOrigin(real);
  scan.skills.set(scan.ctx.identity.fold(path), added);
  if (!dangling) scan.skills.set(scan.ctx.identity.fold(real), added);
}

async function collectStore(scan: SharedScan, store: StoreDir): Promise<void> {
  for (const entry of (await listDir(store.dir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    await storeSkill(scan, store, entry.name);
  }
}

/** Symlinks into a store from an agent moldig has no adapter for: Placements, never entities. */
async function collectLinkDir(
  scan: SharedScan,
  dir: string,
  harness: string,
  scope: "user" | "project",
): Promise<void> {
  for (const entry of (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isSymbolicLink()) continue;
    const linkPath = join(dir, entry.name);
    const real = await realpathOrSelf(linkPath);
    const skill = scan.skills.get(scan.ctx.identity.fold(real));
    if (skill === undefined) continue;
    if (skill.placements.some((item) => scan.ctx.identity.same(item.path, linkPath))) continue;
    skill.placements.push(
      placementOf(scan, {
        path: linkPath,
        harness,
        scope,
        isSymlink: true,
        linkTarget: await linkTargetOf(linkPath, true),
        dangling: false,
      }),
    );
  }
}

export async function collectStores(scan: SharedScan): Promise<void> {
  for (const store of scan.stores) await collectStore(scan, store);
  for (const agent of LINK_AGENTS) {
    await collectLinkDir(scan, join(scan.home, ...agent.userDir.split("/")), agent.id, "user");
    if (agent.projectDir === null) continue;
    for (const project of scan.ctx.discovery.projects()) {
      if (project.reachability !== "present") continue;
      for (const member of project.members) {
        if (member.reachability !== "present") continue;
        await collectLinkDir(
          scan,
          join(member.path, ...agent.projectDir.split("/")),
          agent.id,
          "project",
        );
      }
    }
  }
  const fold = scan.ctx.identity.fold;
  for (const skill of scan.skills.values()) {
    skill.placements.sort((a, b) => (fold(a.path) < fold(b.path) ? -1 : 1));
  }
}

/** `<X>/.agents/skills` of the user's home and of every present member of every present Project. */
export function storeDirsOf(scan: SharedScan): StoreDir[] {
  const out: StoreDir[] = [
    { dir: join(scan.home, ".agents", "skills"), scope: "user", project: null },
  ];
  for (const project of scan.ctx.discovery.projects()) {
    if (project.reachability !== "present") continue;
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      out.push({ dir: join(member.path, ".agents", "skills"), scope: "project", project });
    }
  }
  return out;
}

/** The lock files of a scope, in the order §13 reads them. */
export function lockFilesOf(home: string, xdgStateHome: string | undefined): string[] {
  const out: string[] = [];
  if (xdgStateHome !== undefined) out.push(join(xdgStateHome, "skills", ".skill-lock.json"));
  out.push(join(home, ".agents", ".skill-lock.json"));
  return out;
}
