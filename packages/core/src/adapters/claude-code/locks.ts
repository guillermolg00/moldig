/**
 * The skill locks the Claude adapter reads to fill `Skill.origin` (research 01 §1, ticket 14 §2):
 * the global `~/.agents/.skill-lock.json` (`version: 3`, or `$XDG_STATE_HOME/skills/.skill-lock.json`
 * per D75) and a Project's committed `skills-lock.json` (`version: 1`). Only the entry's own fields
 * are read — never a hash moldig recomputes here: the folder hash and the drift verdict belong to
 * the shared-stores ticket, so `drift` stays `"unknown"` (D44) until it lands.
 */
import { basename, dirname, join } from "node:path";
import type { Locator, Origin, Skill } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isRecord, readText } from "../../scan/fs.js";

export interface LockEntry {
  name: string;
  /** The lock file the entry lives in. */
  file: string;
  /** `<store>/<name>` — where the entry says the skill's real directory is. */
  storeDir: string;
  source: string;
  sourceType: Origin["sourceType"];
  sourceUrl: string | null;
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
  /** `~/.agents/skills` or `<project>/.agents/skills`. */
  store: string;
  scope: "user" | "project";
  project: DiscoveredProject | null;
  entries: LockEntry[];
}

/** The lock's `sourceType` values that index v0's enum already names; anything else is unknown. */
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
  return SOURCE_TYPES.find((known) => known === value) ?? "unknown";
}

/** 40 hex = git's tree sha1 (recomputable in pure JS), 64 hex = Vercel's folder sha256, else unknown. */
function hashOf(value: unknown): Origin["recordedHash"] {
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

export async function readSkillLock(
  path: string,
  store: string,
  scope: "user" | "project",
  project: DiscoveredProject | null,
): Promise<SkillLock> {
  const empty: SkillLock = {
    path,
    present: false,
    parseError: false,
    version: null,
    store,
    scope,
    project,
    entries: [],
  };
  const raw = await readText(path);
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
        file: path,
        storeDir: join(store, name),
        source: text(entry["source"]) ?? "",
        sourceType: sourceTypeOf(entry["sourceType"]),
        sourceUrl: text(entry["sourceUrl"]),
        skillPath: text(entry["skillPath"]),
        // v3 records `skillFolderHash`, v1 the `computedHash` it can reproduce.
        recordedHash: hashOf(entry["skillFolderHash"] ?? entry["computedHash"]),
        installedAt: text(entry["installedAt"]),
        updatedAt: text(entry["updatedAt"]),
      });
    }
  }
  return { ...empty, present: true, version, entries };
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
    ref: null,
    skillPath: entry.skillPath,
    recordedHash: entry.recordedHash,
    installedAt: entry.installedAt,
    updatedAt: entry.updatedAt,
    lock: lockLocator(entry),
  };
}

/**
 * Ticket 14 §2: a `.git` inside the skill directory is an installer of its own (D42 added it to
 * the enum). `git -C <dir> pull` is what the Update flow would show; moldig never runs it.
 */
export function gitCloneOrigin(dir: string): Origin {
  return {
    installer: "git-clone",
    sourceType: "git",
    source: dir,
    sourceUrl: null,
    ref: null,
    skillPath: null,
    recordedHash: null,
    installedAt: null,
    updatedAt: null,
    lock: { type: "dir", path: join(dir, ".git") },
  };
}

/**
 * D43: `canonical` = the real directory sits in a skills store; `plugin` = inside a plugin install
 * directory; `synced` = inside a harness's own skills directory **and** recorded by a lock;
 * `copy` = anything else. `bundled` needs no files on disk and is never emitted for Claude Code.
 */
export function layoutOf(input: {
  realPath: string;
  inStore: boolean;
  inPlugin: boolean;
  lockRecorded: boolean;
}): Skill["layout"] {
  if (input.inPlugin) return "plugin";
  if (input.inStore) return "canonical";
  return input.lockRecorded ? "synced" : "copy";
}

/**
 * The store a lock file governs: `~/.agents/skills` beside the global lock (which lives inside
 * `.agents/` already), `<project>/.agents/skills` beside a Project's committed `skills-lock.json`.
 */
export function storeOf(lockFile: string): string {
  const dir = dirname(lockFile);
  return basename(lockFile) === ".skill-lock.json"
    ? join(dir, "skills")
    : join(dir, ".agents", "skills");
}
