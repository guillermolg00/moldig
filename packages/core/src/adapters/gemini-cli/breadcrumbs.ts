/* oxlint-disable no-await-in-loop -- sequential on purpose: slug resolution walks a fixed order */
/**
 * Gemini CLI's breadcrumbs (ticket 06 §1, spec §3): the keys of `~/.gemini/projects.json`
 * (`projects-entry`), the keys of `~/.gemini/trustedFolders.json` (`trust-entry`) and the slug
 * directories of `~/.gemini/tmp/` and `~/.gemini/history/` (`slug-directory`). A slug resolves
 * through the `projects.json` value, then `.project_root` (D34), then the legacy `sha256(path)`
 * name, then the base slug of a known Project member, and is a stray otherwise.
 */
import { join } from "node:path";
import type { Breadcrumb } from "../../index/types.js";
import { warning } from "../../scan/context.js";
import type { Discovery, Located } from "../../scan/discovery.js";
import { isDirectory, isFile, listDir, readText, sha256 } from "../../scan/fs.js";
import { isUnder } from "../../scan/paths.js";
import {
  HARNESS,
  type GeminiScan,
  type ProjectsEntry,
  type SlugDir,
  type TrustEntry,
} from "./model.js";
import { LEGACY_SLUG, slugOf } from "./paths.js";
import { parseJsonc } from "./settings.js";

export interface ProjectsFile {
  path: string;
  present: boolean;
  parseError: boolean;
  /** `<abs path>` → slug; a value that is not a string keeps the key with `slug: null`. */
  entries: { key: string; slug: string | null }[];
}

export async function readProjectsFile(path: string): Promise<ProjectsFile> {
  const text = await readText(path);
  if (text === null) return { path, present: false, parseError: false, entries: [] };
  const data = parseJsonc(text);
  if (data === null) return { path, present: true, parseError: true, entries: [] };
  const projects = data["projects"];
  const entries: { key: string; slug: string | null }[] = [];
  if (projects !== null && typeof projects === "object" && !Array.isArray(projects)) {
    for (const [key, value] of Object.entries(projects)) {
      entries.push({ key, slug: typeof value === "string" ? value : null });
    }
  }
  return { path, present: true, parseError: false, entries };
}

export interface TrustFile {
  path: string;
  present: boolean;
  parseError: boolean;
  entries: { key: string; value: string }[];
}

export async function readTrustFile(path: string): Promise<TrustFile> {
  const text = await readText(path);
  if (text === null) return { path, present: false, parseError: false, entries: [] };
  const data = parseJsonc(text);
  if (data === null) return { path, present: true, parseError: true, entries: [] };
  return {
    path,
    present: true,
    parseError: false,
    entries: Object.entries(data)
      .filter(([, value]) => typeof value === "string")
      .map(([key, value]) => ({ key, value: String(value) })),
  };
}

/** `TRUST_FOLDER` and `TRUST_PARENT` trust the folder; `DO_NOT_TRUST` does not; anything else is unknown. */
export function trustedOf(value: string): boolean | null {
  if (value === "TRUST_FOLDER" || value === "TRUST_PARENT") return true;
  if (value === "DO_NOT_TRUST") return false;
  return null;
}

/** `tmp/bin` and `tmp/background-processes` are never slug directories (§10). */
const TMP_RESERVED = new Set(["bin", "background-processes"]);

/**
 * A directory under `tmp/` is a slug directory iff it is a value of `projects.json`, carries
 * `.project_root`, is named with 64 lowercase hex characters, or holds a `chats/` directory.
 * Every directory under `history/` is one.
 */
export async function readSlugDirs(
  tmpDir: string,
  historyDir: string,
  knownSlugs: ReadonlySet<string>,
): Promise<{ dir: string; slug: string; store: "tmp" | "history" }[]> {
  const out: { dir: string; slug: string; store: "tmp" | "history" }[] = [];
  for (const entry of (await listDir(tmpDir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory() || TMP_RESERVED.has(entry.name)) continue;
    const dir = join(tmpDir, entry.name);
    const qualifies =
      knownSlugs.has(entry.name) ||
      LEGACY_SLUG.test(entry.name) ||
      (await isFile(join(dir, ".project_root"))) ||
      (await isDirectory(join(dir, "chats")));
    if (qualifies) out.push({ dir, slug: entry.name, store: "tmp" });
  }
  for (const entry of (await listDir(historyDir)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (!entry.isDirectory()) continue;
    out.push({ dir: join(historyDir, entry.name), slug: entry.name, store: "history" });
  }
  return out;
}

/** `.project_root` holds the absolute path of the folder the scratch directory belongs to (D34). */
async function projectRootOf(dir: string): Promise<{ path: string | null; unsupported: boolean }> {
  const text = await readText(join(dir, ".project_root"));
  if (text === null) return { path: null, unsupported: false };
  const value = text.trim();
  if (value === "") return { path: null, unsupported: false };
  const absolute =
    value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  return absolute ? { path: value, unsupported: false } : { path: null, unsupported: true };
}

export interface SlugResolutionInput {
  discovery: Discovery;
  /** `projects.json` slug → its key. */
  keyBySlug: ReadonlyMap<string, string>;
  keyLocated: ReadonlyMap<string, Located>;
  /** Every absolute path this scan has seen, for the legacy `sha256(path)` step. */
  candidatePaths: readonly string[];
  warn: (path: string, message: string) => void;
}

/** §3 slug resolution: the first hit wins (a → b → c → d → unresolved). */
export async function resolveSlugs(
  dirs: readonly { dir: string; slug: string; store: "tmp" | "history" }[],
  input: SlugResolutionInput,
): Promise<SlugDir[]> {
  const out: SlugDir[] = [];
  for (const entry of dirs) {
    const key = input.keyBySlug.get(entry.slug);
    if (key !== undefined) {
      out.push({
        ...entry,
        located: input.keyLocated.get(key) ?? null,
        resolution: "slug-by-key",
      });
      continue;
    }
    const root = await projectRootOf(entry.dir);
    if (root.unsupported) {
      input.warn(join(entry.dir, ".project_root"), ".project_root is not an absolute path");
    }
    if (root.path !== null) {
      out.push({
        ...entry,
        located: await input.discovery.locate(root.path, "breadcrumb"),
        resolution: "slug-by-key",
      });
      continue;
    }
    if (LEGACY_SLUG.test(entry.slug)) {
      const legacy = input.candidatePaths.find((path) => sha256(path) === entry.slug);
      if (legacy !== undefined) {
        out.push({
          ...entry,
          located: await input.discovery.locate(legacy, "breadcrumb"),
          resolution: "slug-by-existence",
        });
        continue;
      }
    }
    const members = input.discovery
      .projects()
      .flatMap((project) => project.members.map((member) => member.path))
      .filter((path) => slugOf(path) === entry.slug);
    if (members.length === 1 && members[0] !== undefined) {
      out.push({
        ...entry,
        located: await input.discovery.locate(members[0], "breadcrumb"),
        resolution: "slug-by-existence",
      });
      continue;
    }
    out.push({ ...entry, located: null, resolution: "unresolved" });
  }
  // Ticket 06 rule 7: a slug naming a Project outside every Root leaves the scan with it.
  return out.filter(({ located }) => located?.outsideRoots !== true);
}

function crumb(
  scan: GeminiScan,
  locatorText: string,
  kind: Breadcrumb["kind"],
  raw: string,
  recordedForm: Breadcrumb["recordedForm"],
  located: Located | null,
  resolution: Breadcrumb["resolution"],
  locator: Breadcrumb["locator"],
  refs: Breadcrumb["refs"],
  state: string[],
): Breadcrumb {
  return {
    id: `breadcrumb:${HARNESS}:${scan.ctx.identity.fold(locatorText)}`,
    harness: HARNESS,
    kind,
    raw,
    recordedForm,
    path: located?.path ?? null,
    resolution,
    project: located?.project?.id ?? null,
    strayReason: located?.strayReason ?? (resolution === "unresolved" ? "unresolved-slug" : null),
    relativePathInProject: located?.relativePath ?? null,
    reachability: located?.reachability ?? "orphan",
    locator,
    occurrences: { count: 1, first: null, last: null },
    refs,
    state,
  };
}

/** Harness-owned entity ids whose path lies under `dir` (the slug's state, ticket 06 §1). */
function stateUnder(scan: GeminiScan, dir: string): string[] {
  const fold = scan.ctx.identity.fold;
  return [...scan.entities.values()]
    .filter((entity) => entity.ownership === "harness" && isUnder(fold(entity.path), fold(dir)))
    .map((entity) => entity.id)
    .toSorted();
}

export function collectBreadcrumbs(scan: GeminiScan): void {
  for (const entry of scan.projectsFile.entries) {
    const refs: Breadcrumb["refs"] = {};
    if (entry.slug !== null) refs.projectId = entry.slug;
    scan.breadcrumbs.push(
      crumb(
        scan,
        `${scan.projectsFile.path}#projects/${entry.key}`,
        "projects-entry",
        entry.key,
        "path",
        entry.located,
        "direct",
        {
          type: "entry",
          file: scan.projectsFile.path,
          format: "json",
          keyPath: ["projects", entry.key],
        },
        refs,
        [],
      ),
    );
  }
  for (const entry of scan.trustFile.entries) {
    scan.breadcrumbs.push(
      crumb(
        scan,
        `${scan.trustFile.path}#${entry.key}`,
        "trust-entry",
        entry.key,
        "path",
        entry.located,
        "direct",
        { type: "entry", file: scan.trustFile.path, format: "json", keyPath: [entry.key] },
        {},
        [],
      ),
    );
  }
  for (const slug of scan.slugs) {
    scan.breadcrumbs.push(
      crumb(
        scan,
        slug.dir,
        "slug-directory",
        slug.slug,
        "slug",
        slug.located,
        slug.resolution,
        { type: "dir", path: slug.dir },
        {},
        stateUnder(scan, slug.dir),
      ),
    );
  }
  scan.breadcrumbs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** A `projects.json` value that is not a string degrades the entry but keeps the breadcrumb. */
export function warnProjectsShape(scan: GeminiScan, entries: readonly ProjectsEntry[]): void {
  for (const entry of entries) {
    if (entry.slug !== null) continue;
    scan.ctx.warn(
      warning(
        "unsupported-shape",
        `projects.json entry ${entry.key} does not name a slug`,
        HARNESS,
        scan.projectsFile.path,
        "degraded",
      ),
    );
  }
}

/** A `trustedFolders.json` value outside the documented enumeration. */
export function warnTrustShape(scan: GeminiScan, entries: readonly TrustEntry[]): void {
  for (const entry of entries) {
    if (entry.trusted !== null) continue;
    scan.ctx.warn(
      warning(
        "unsupported-shape",
        `trustedFolders.json entry ${entry.key} has an unknown value`,
        HARNESS,
        scan.trustFile.path,
        "degraded",
      ),
    );
  }
}
