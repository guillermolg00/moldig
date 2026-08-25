/**
 * Fixture trees for tests: copies a case from `fixtures/<harness>/<case>/` into a fresh
 * temp directory and materialises what git cannot hold (`fixtures/README.md`, ticket 15).
 *
 * After `mkdtemp` + `realpath` the steps run in this order: renames (`_git` → `.git`),
 * token rewriting in directory/file names and in text-file contents, SQLite `REPLACE`,
 * empty `dirs`, `symlinks`, `ages`. Ages go last so nothing that writes into the tree bumps
 * an mtime the case fixed; `symlinks`, `ages`, `dirs` and `sqlite` paths name the post-rename
 * tree and are themselves token-rewritten. Tokens: `<HOME>` / `<ROOT>` become the absolute
 * temp paths, `__HOME__` / `__ROOT__` the harness's slug of those paths (each case README
 * states the rule). Placeholders are rewritten textually and never validated.
 *
 * Node built-ins only: this module ships as `@moldig/core/testing` and must not pull a
 * terminal dependency into core (ADR-0003).
 */
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface FixtureOptions {
  /** The platform the scan is told it runs on; defaults to the host's. */
  platform?: NodeJS.Platform;
  /** Case-relative working directory, e.g. `'root/project-a'`; default: the temp root dir. */
  cwd?: string;
  /** Environment overrides handed to the scan; never `process.env`. */
  env?: Record<string, string>;
  /** Base for `ages`; default `new Date()`. */
  now?: Date;
}

export interface FixtureTree {
  /** The temp directory holding `home/` and `root/`. */
  readonly dir: string;
  /** `<dir>/home` — the user's home as the harness sees it. */
  readonly home: string;
  /** `<dir>/root` — the projects side. */
  readonly root: string;
  /** `[root]`. */
  readonly roots: readonly string[];
  readonly cwd: string;
  readonly platform: NodeJS.Platform;
  /** Only `options.env`, never `process.env`. */
  readonly env: Record<string, string>;
  /** The harness directory of the case (`claude-code`, `codex`, …, `shared`). */
  readonly harness: string;
  /** Absolute path of a case-relative path (post-rename names), tokens rewritten. */
  path(caseRelative: string): string;
  /** The harness's slug of an absolute path (identity where the harness has no slug rule). */
  slug(absolutePath: string): string;
  cleanup(): Promise<void>;
}

interface SlugRule {
  slug(absolutePath: string): string;
  /** Whether the harness's slug directories encode path segments (so `__HOME__`/`__ROOT__` occur). */
  namesEncodePath: boolean;
}

const identity: SlugRule = { slug: (absolutePath) => absolutePath, namesEncodePath: false };

/** One slug rule per harness directory under `fixtures/`, as each case README documents it. */
const SLUG_RULES: Readonly<Record<string, SlugRule>> = {
  // `~/.claude/projects/<slug>`: every character outside [A-Za-z0-9] becomes `-`, case kept.
  "claude-code": { slug: (p) => p.replace(/[^A-Za-z0-9]/g, "-"), namesEncodePath: true },
  // `~/.cursor/projects/<slug>`: runs of [^A-Za-z0-9] collapse to one `-`, leading `-` stripped.
  cursor: {
    slug: (p) => p.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-/, ""),
    namesEncodePath: true,
  },
  // `~/.gemini/tmp/<slug>`: lower-cased basename, non-[a-z0-9] → `-` (collision suffixes are
  // recorded in projects.json, not derivable from the path).
  "gemini-cli": {
    slug: (p) =>
      basename(p)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "-"),
    namesEncodePath: false,
  },
  // No path-derived slug directories (their READMEs): tokens unused, slug = the path itself.
  codex: identity,
  copilot: identity,
  opencode: identity,
  shared: identity,
};

interface Rename {
  from: string;
  to: string;
}
interface Symlink {
  path: string;
  target: string;
  kind: "dir" | "file";
}
interface Age {
  path: string;
  ageDays: number;
}
interface SqliteRewrite {
  path: string;
  rewrite: { table: string; column: string }[];
}
interface FixtureManifest {
  renames: Rename[];
  symlinks: Symlink[];
  ages: Age[];
  dirs: string[];
  sqlite: SqliteRewrite[];
}

interface Tokens {
  home: string;
  root: string;
  homeSlug: string;
  rootSlug: string;
}

const DAY_MS = 86_400_000;

/** Files never rewritten textually: databases and their sidecars, compressed transcripts. */
const BINARY_NAME =
  /\.(?:sqlite3?|db|vscdb)(?:-wal|-shm|-journal|\.backup)?$|\.(?:zst|gz|zip|tar|png|jpe?g|gif|pb|bin)$/i;

/** Formats whose strings escape `\` — matters only when the temp path carries backslashes (win32). */
const ESCAPED_FORMAT = /\.(?:json|jsonl|jsonc|toml)(?:\.|$)/i;

let fixturesDirPromise: Promise<string> | undefined;

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Runs `run` over `items` one after the other (order is part of the contract). */
function sequentially<T>(items: readonly T[], run: (item: T) => Promise<void>): Promise<void> {
  return items.reduce<Promise<void>>(
    (chain, item) => chain.then(() => run(item)),
    Promise.resolve(),
  );
}

async function findFixturesDirFrom(dir: string, depth: number): Promise<string> {
  const candidate = join(dir, "fixtures");
  if (await exists(join(candidate, "README.md"))) return candidate;
  const parent = dirname(dir);
  if (parent === dir || depth >= 8) {
    throw new Error("fixtures/ directory not found above " + fileURLToPath(import.meta.url));
  }
  return findFixturesDirFrom(parent, depth + 1);
}

/**
 * The repo's `fixtures/` directory: walks up from this module (src/ or dist/). The cases are
 * not shipped in the package's `files`, so `@moldig/core/testing` works inside this
 * monorepo checkout only. A failed lookup is not cached (the tree may appear later).
 */
function findFixturesDir(): Promise<string> {
  fixturesDirPromise ??= findFixturesDirFrom(dirname(fileURLToPath(import.meta.url)), 0).catch(
    (error: unknown) => {
      fixturesDirPromise = undefined;
      throw error;
    },
  );
  return fixturesDirPromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRename(value: unknown): value is Rename {
  return isRecord(value) && typeof value["from"] === "string" && typeof value["to"] === "string";
}

function isSymlink(value: unknown): value is Symlink {
  return (
    isRecord(value) &&
    typeof value["path"] === "string" &&
    typeof value["target"] === "string" &&
    (value["kind"] === "dir" || value["kind"] === "file")
  );
}

function isAge(value: unknown): value is Age {
  return (
    isRecord(value) && typeof value["path"] === "string" && typeof value["ageDays"] === "number"
  );
}

function isSqliteRewrite(value: unknown): value is SqliteRewrite {
  return (
    isRecord(value) &&
    typeof value["path"] === "string" &&
    Array.isArray(value["rewrite"]) &&
    value["rewrite"].every(
      (entry) =>
        isRecord(entry) &&
        typeof entry["table"] === "string" &&
        typeof entry["column"] === "string",
    )
  );
}

function listOf<T>(value: unknown, guard: (item: unknown) => item is T, what: string): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(guard)) {
    throw new Error(`fixture.json: "${what}" has an unexpected shape`);
  }
  return value;
}

function parseManifest(text: string): FixtureManifest {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new Error("fixture.json: expected an object");
  const dirs = raw["dirs"];
  if (dirs !== undefined && !isStringArray(dirs)) {
    throw new Error('fixture.json: "dirs" has an unexpected shape');
  }
  return {
    renames: listOf(raw["renames"], isRename, "renames"),
    symlinks: listOf(raw["symlinks"], isSymlink, "symlinks"),
    ages: listOf(raw["ages"], isAge, "ages"),
    dirs: dirs ?? [],
    sqlite: listOf(raw["sqlite"], isSqliteRewrite, "sqlite"),
  };
}

async function readManifest(source: string): Promise<FixtureManifest> {
  const file = join(source, "fixture.json");
  if (!(await exists(file))) return { renames: [], symlinks: [], ages: [], dirs: [], sqlite: [] };
  return parseManifest(await readFile(file, "utf8"));
}

function rewriteName(name: string, tokens: Tokens): string {
  return name
    .replaceAll("<HOME>", tokens.home)
    .replaceAll("<ROOT>", tokens.root)
    .replaceAll("__HOME__", tokens.homeSlug)
    .replaceAll("__ROOT__", tokens.rootSlug);
}

function rewriteContent(text: string, tokens: Tokens, escapeBackslashes: boolean): string {
  const escaped: Tokens = escapeBackslashes
    ? {
        home: tokens.home.replaceAll("\\", "\\\\"),
        root: tokens.root.replaceAll("\\", "\\\\"),
        homeSlug: tokens.homeSlug.replaceAll("\\", "\\\\"),
        rootSlug: tokens.rootSlug.replaceAll("\\", "\\\\"),
      }
    : tokens;
  return rewriteName(text, escaped);
}

function hasToken(text: string): boolean {
  return (
    text.includes("<HOME>") ||
    text.includes("<ROOT>") ||
    text.includes("__HOME__") ||
    text.includes("__ROOT__")
  );
}

function caseJoin(dir: string, caseRelative: string): string {
  return join(dir, ...caseRelative.split("/"));
}

/** Renames every entry whose name carries a token, children before parents. */
async function rewriteNames(dir: string, tokens: Tokens): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const current = join(dir, entry.name);
      if (entry.isDirectory()) await rewriteNames(current, tokens);
      if (hasToken(entry.name)) await rename(current, join(dir, rewriteName(entry.name, tokens)));
    }),
  );
}

/** Rewrites tokens inside every text file under `dir`; binaries (by name or NUL byte) are skipped. */
async function rewriteContents(dir: string, tokens: Tokens): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const current = join(dir, entry.name);
      if (entry.isDirectory()) {
        await rewriteContents(current, tokens);
        return;
      }
      if (!entry.isFile() || BINARY_NAME.test(entry.name)) return;
      const bytes = await readFile(current);
      if (bytes.length === 0 || bytes.includes(0)) return;
      const text = bytes.toString("utf8");
      if (!hasToken(text)) return;
      await writeFile(current, rewriteContent(text, tokens, ESCAPED_FORMAT.test(entry.name)));
    }),
  );
}

function quoteIdentifier(name: string): string {
  return '"' + name.replaceAll('"', '""') + '"';
}

/**
 * Substring `REPLACE` on the named columns; WAL/SHM sidecars the case committed survive. The
 * contract names `<HOME>` / `<ROOT>` for `sqlite[].rewrite`; the slug tokens are replaced too
 * so a slug spelled inside a database row (none today) follows the same rule as text files.
 */
async function rewriteSqlite(
  file: string,
  rewrites: { table: string; column: string }[],
  tokens: Tokens,
): Promise<void> {
  const sidecars = await Promise.all(
    ["-wal", "-shm"].map(async (suffix) => {
      const path = file + suffix;
      return (await exists(path)) ? { path, bytes: await readFile(path) } : null;
    }),
  );
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    for (const { table, column } of rewrites) {
      const col = quoteIdentifier(column);
      db.prepare(
        `UPDATE ${quoteIdentifier(table)} SET ${col} = ` +
          `REPLACE(REPLACE(REPLACE(REPLACE(${col}, '<HOME>', ?), '<ROOT>', ?), '__HOME__', ?), '__ROOT__', ?) ` +
          `WHERE typeof(${col}) = 'text'`,
      ).run(tokens.home, tokens.root, tokens.homeSlug, tokens.rootSlug);
    }
  } finally {
    db.close();
  }
  await Promise.all(
    sidecars.map(async (sidecar) => {
      if (sidecar !== null && !(await exists(sidecar.path))) {
        await writeFile(sidecar.path, sidecar.bytes);
      }
    }),
  );
}

async function copySubtree(from: string, to: string): Promise<void> {
  if (await exists(from)) await cp(from, to, { recursive: true });
  else await mkdir(to, { recursive: true });
}

async function createSymlink(
  linkPath: string,
  target: string,
  kind: "dir" | "file",
): Promise<void> {
  await mkdir(dirname(linkPath), { recursive: true });
  if (process.platform === "win32" && kind === "dir") {
    await symlink(resolve(dirname(linkPath), target), linkPath, "junction");
  } else {
    await symlink(target, linkPath, kind);
  }
}

/**
 * Copies `fixtures/<harness>/<case>` into a temp directory and applies its `fixture.json`.
 * The caller owns the tree and must `cleanup()` it.
 */
export async function loadFixture(
  caseName: string,
  options: FixtureOptions = {},
): Promise<FixtureTree> {
  const segments = caseName.split("/");
  const [harness, caseDir] = segments;
  if (segments.length !== 2 || !harness || !caseDir) {
    throw new Error(`fixture case must be "<harness>/<case>", got "${caseName}"`);
  }
  const source = join(await findFixturesDir(), harness, caseDir);
  if (!(await exists(source))) throw new Error(`fixture case not found: ${source}`);

  const rule = SLUG_RULES[harness] ?? identity;
  const dir = await realpath(await mkdtemp(join(tmpdir(), "moldig-fixture-")));
  const home = join(dir, "home");
  const root = join(dir, "root");
  const tokens: Tokens = { home, root, homeSlug: rule.slug(home), rootSlug: rule.slug(root) };
  const casePath = (caseRelative: string): string =>
    join(dir, ...caseRelative.split("/").map((segment) => rewriteName(segment, tokens)));
  const now = options.now ?? new Date();

  try {
    await copySubtree(join(source, "home"), home);
    await copySubtree(join(source, "root"), root);
    const manifest = await readManifest(source);

    await sequentially(manifest.renames, ({ from, to }) =>
      rename(caseJoin(dir, from), caseJoin(dir, to)),
    );
    await rewriteNames(dir, tokens);
    await rewriteContents(dir, tokens);
    await Promise.all(
      manifest.sqlite.map(({ path, rewrite }) => rewriteSqlite(casePath(path), rewrite, tokens)),
    );
    await Promise.all(manifest.dirs.map((path) => mkdir(casePath(path), { recursive: true })));
    await Promise.all(
      manifest.symlinks.map((link) =>
        createSymlink(casePath(link.path), rewriteName(link.target, tokens), link.kind),
      ),
    );
    await Promise.all(
      manifest.ages.map(({ path, ageDays }) => {
        const when = new Date(now.getTime() - ageDays * DAY_MS);
        return utimes(casePath(path), when, when);
      }),
    );
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }

  return {
    dir,
    home,
    root,
    roots: [root],
    cwd: options.cwd === undefined ? root : casePath(options.cwd),
    platform: options.platform ?? process.platform,
    env: { ...options.env },
    harness,
    path: casePath,
    slug: (absolutePath) => rule.slug(absolutePath),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

function forwardSlashes(text: string): string {
  return text.replaceAll("\\", "/");
}

/** Replacement pairs, longest pattern first; folded (lower-cased) forms cover ids that fold case. */
function snapshotPatterns(tree: FixtureTree): [string, string][] {
  const rule = SLUG_RULES[tree.harness] ?? identity;
  const pairs = new Map<string, string>();
  const add = (from: string, to: string): void => {
    if (from.length > 0 && !pairs.has(from)) pairs.set(from, to);
  };
  const home = forwardSlashes(tree.home);
  const root = forwardSlashes(tree.root);
  add(home, "<HOME>");
  add(root, "<ROOT>");
  add(home.toLowerCase(), "<HOME>");
  add(root.toLowerCase(), "<ROOT>");
  if (rule.namesEncodePath) {
    const homeSlug = tree.slug(tree.home);
    const rootSlug = tree.slug(tree.root);
    add(homeSlug, "__HOME__");
    add(rootSlug, "__ROOT__");
    add(homeSlug.toLowerCase(), "__HOME__");
    add(rootSlug.toLowerCase(), "__ROOT__");
  }
  return [...pairs.entries()].toSorted((a, b) => b[0].length - a[0].length);
}

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value instanceof Date) return new Date(value.getTime());
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[fn(key)] = mapStrings(item, fn);
    return out;
  }
  return value;
}

/**
 * Deep-clones `value`; in every string (object keys included) replaces the tree's home and root
 * paths and, for harnesses whose slug directories encode paths, their slugs — longest first — with
 * `<HOME>` / `<ROOT>` / `__HOME__` / `__ROOT__`, and converts backslashes to forward slashes.
 * For snapshot tests.
 */
export function normaliseSnapshot<T>(value: T, tree: FixtureTree): T;
export function normaliseSnapshot(value: unknown, tree: FixtureTree): unknown {
  const patterns = snapshotPatterns(tree);
  return mapStrings(value, (text) => {
    let out = forwardSlashes(text);
    for (const [from, to] of patterns) out = out.replaceAll(from, to);
    return out;
  });
}
