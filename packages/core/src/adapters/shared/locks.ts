/**
 * The skill locks of the stores several harnesses share (research 04; ticket 06 §13): the global
 * `~/.agents/.skill-lock.json` (`version: 3`), the `$XDG_STATE_HOME/skills/.skill-lock.json`
 * variant D75 reads in addition, and each Project's committed `skills-lock.json` (`version: 1`).
 *
 * Entries are read **by field name, not by `version`**: `skillFolderHash` is the v3 hash,
 * `computedHash` the v1 one. A `version` outside the one its file name documents still yields its
 * entries — with an `unsupported-shape` warning, never a guess (the shape a captured lock in
 * `fixtures/opencode/db-and-config` really has: `version: 1` with v3 entry keys).
 */
import { basename, dirname, join } from "node:path";
import type { Locator, Origin } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isRecord, readText } from "../../scan/fs.js";

export interface LockEntry {
  /** The key inside `skills` — the skill's directory name in the store. */
  name: string;
  /** The lock file the entry lives in. */
  file: string;
  /** `<store>/<name>` — where the entry says the skill's real directory is. */
  storeDir: string;
  source: string;
  sourceType: Origin["sourceType"];
  sourceUrl: string | null;
  ref: string | null;
  skillPath: string | null;
  recordedHash: Origin["recordedHash"];
  installedAt: string | null;
  updatedAt: string | null;
}

export interface SkillLock {
  path: string;
  present: boolean;
  parseError: boolean;
  version: number | null;
  /** The version this file name documents: 3 for `.skill-lock.json`, 1 for `skills-lock.json`. */
  documentedVersion: 1 | 3;
  /** D75: read because `XDG_STATE_HOME` is set — it wins for a name present in both locks. */
  fromEnv: boolean;
  /** `~/.agents/skills` or `<member>/.agents/skills`. */
  store: string;
  scope: "user" | "project";
  project: DiscoveredProject | null;
  topLevelKeys: string[];
  entries: LockEntry[];
}

/** The lock `sourceType` values index v0's enum names; `git`/`gitlab` fold onto `git` (§13). */
const SOURCE_TYPES: readonly Origin["sourceType"][] = [
  "github",
  "git",
  "well-known",
  "mintlify",
  "huggingface",
  "npm",
  "local",
  "node_modules",
  "marketplace",
];

function sourceTypeOf(value: unknown): Origin["sourceType"] {
  if (value === "gitlab") return "git";
  return SOURCE_TYPES.find((known) => known === value) ?? "unknown";
}

/** 40 hex = git's tree sha1 (recomputable in pure JS), 64 hex = Vercel's folder sha256, else unknown. */
export function hashOf(value: unknown): Origin["recordedHash"] {
  if (typeof value !== "string" || value === "") return null;
  const algo = /^[0-9a-f]{40}$/i.test(value)
    ? "git-tree-sha1"
    : /^[0-9a-f]{64}$/i.test(value)
      ? "sha256-folder"
      : "unknown";
  return { algo, value };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * The store a lock file governs: `~/.agents/skills` beside the global lock (which already lives
 * inside `.agents/`), `<member>/.agents/skills` beside a Project's committed `skills-lock.json`.
 */
export function storeOf(lockFile: string): string {
  const dir = dirname(lockFile);
  return basename(lockFile) === ".skill-lock.json"
    ? join(dir, "skills")
    : join(dir, ".agents", "skills");
}

export interface ReadLockInput {
  path: string;
  store: string;
  scope: "user" | "project";
  project: DiscoveredProject | null;
  fromEnv?: boolean;
}

export async function readSkillLock(input: ReadLockInput): Promise<SkillLock> {
  const documentedVersion = basename(input.path) === ".skill-lock.json" ? 3 : 1;
  const empty: SkillLock = {
    path: input.path,
    present: false,
    parseError: false,
    version: null,
    documentedVersion,
    fromEnv: input.fromEnv ?? false,
    store: input.store,
    scope: input.scope,
    project: input.project,
    topLevelKeys: [],
    entries: [],
  };
  const raw = await readText(input.path);
  if (raw === null) return empty;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...empty, present: true, parseError: true };
  }
  if (!isRecord(parsed)) return { ...empty, present: true, parseError: true };
  const version = typeof parsed["version"] === "number" ? parsed["version"] : null;
  const skills = parsed["skills"];
  const entries: LockEntry[] = [];
  if (isRecord(skills)) {
    for (const [name, entry] of Object.entries(skills)) {
      if (!isRecord(entry)) continue;
      entries.push({
        name,
        file: input.path,
        storeDir: join(input.store, name),
        source: text(entry["source"]) ?? "",
        sourceType: sourceTypeOf(entry["sourceType"]),
        sourceUrl: text(entry["sourceUrl"]),
        ref: text(entry["ref"]),
        skillPath: text(entry["skillPath"]),
        recordedHash: hashOf(entry["skillFolderHash"] ?? entry["computedHash"]),
        installedAt: text(entry["installedAt"]),
        updatedAt: text(entry["updatedAt"]),
      });
    }
  }
  return {
    ...empty,
    present: true,
    version,
    topLevelKeys: Object.keys(parsed),
    entries: entries.toSorted((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The entry locator the `originates-from` edge and `Origin.lock` both point at. */
export function lockLocator(entry: LockEntry): Locator {
  return { type: "entry", file: entry.file, format: "json", keyPath: ["skills", entry.name] };
}

export function originOf(entry: LockEntry): Origin {
  return {
    installer: "vercel-skills",
    sourceType: entry.sourceType,
    source: entry.source,
    sourceUrl: entry.sourceUrl,
    ref: entry.ref,
    skillPath: entry.skillPath,
    recordedHash: entry.recordedHash,
    installedAt: entry.installedAt,
    updatedAt: entry.updatedAt,
    lock: lockLocator(entry),
  };
}

/**
 * Ticket 14 §2: a `.git` directory inside a skill directory is an installer of its own (D42 added
 * `git-clone` to the enum). The remote URL is the source, the branch in `.git/HEAD` the ref, both
 * sanitised of userinfo; `git -C <dir> pull` is what the Update flow would show and never runs.
 */
export async function gitCloneOrigin(dir: string): Promise<Origin> {
  const gitDir = join(dir, ".git");
  const config = (await readText(join(gitDir, "config"))) ?? "";
  const head = (await readText(join(gitDir, "HEAD"))) ?? "";
  const remote = /\[remote "origin"\][^[]*?\burl\s*=\s*(\S+)/.exec(config)?.[1] ?? null;
  const url = remote === null ? null : remote.replace(/\/\/[^/@]+@/, "//");
  const ref = /^ref:\s*refs\/heads\/(\S+)/m.exec(head)?.[1] ?? null;
  return {
    installer: "git-clone",
    sourceType: "git",
    source: url ?? dir,
    sourceUrl: url,
    ref,
    skillPath: null,
    recordedHash: null,
    installedAt: null,
    updatedAt: null,
    lock: { type: "file", path: join(gitDir, "config") },
  };
}
