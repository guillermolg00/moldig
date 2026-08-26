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
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ScanPlatform } from "../scan/paths.js";

export interface FixtureOptions {
  /** The platform the scan is told it runs on; defaults to the host's (D125: one of three). */
  platform?: ScanPlatform;
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
  readonly platform: ScanPlatform;
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
  /** The `file://` form of the two paths: percent-encoded, `/C:/…` on win32 (D100). */
  homeUri: string;
  rootUri: string;
}

/** The host platform, when moldig scans it at all (D125). */
function hostPlatform(): ScanPlatform {
  const platform = process.platform;
  if (platform === "darwin" || platform === "linux" || platform === "win32") return platform;
  throw new Error(
    `loadFixture: this host runs "${platform}"; pass options.platform (darwin, linux or win32)`,
  );
}

const UNAGED_OFFSET_MS = 60_000;
const DAY_MS = 86_400_000;

/**
 * The single timestamp every entry the case does not age carries: a minute before the injected
 * clock. A minute, not an hour, because a `recent-activity` live guard asks whether the unit
 * changed inside the harness's activity window, and a case that exercises a live unit must keep
 * doing so. Snapshots name this value `<COPY-TIME>`; it is a function of `now` alone, so a
 * snapshot taken today still matches next month.
 */
export function fixtureCopyTime(now: Date): Date {
  return new Date(now.getTime() - UNAGED_OFFSET_MS);
}

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

const FIXTURES_SEARCH_DEPTH = 8;

/**
 * The upward search for the repo's `fixtures/` directory. Exported so the "not a checkout"
 * message of D101 is testable from a directory that has none above it.
 */
export async function findFixturesDirFrom(dir: string, depth = 0): Promise<string> {
  const candidate = join(dir, "fixtures");
  if (await exists(join(candidate, "README.md"))) return candidate;
  const parent = dirname(dir);
  if (parent === dir || depth >= FIXTURES_SEARCH_DEPTH) {
    // D101: the helper is monorepo-internal on purpose — say so instead of failing on a path.
    throw new Error(
      `@moldig/core/testing: no fixtures/ directory (with its README.md) in the ${FIXTURES_SEARCH_DEPTH} ` +
        `directories above ${fileURLToPath(import.meta.url)}. The fixture cases are not shipped in ` +
        "the published package (they are not in its `files`), so loadFixture works inside a " +
        "checkout of the moldig monorepo only.",
    );
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

/**
 * D100: a placeholder inside a `file://` URI becomes the URI form of the path — percent-encoded,
 * and `/C:/Temp/…` on win32, so `file://<ROOT>/project-a` stays a URI a harness could have
 * written on either platform. Runs before the plain rewrite, whose backslash escaping would
 * otherwise mangle it.
 */
function rewriteFileUris(text: string, tokens: Tokens): string {
  return text
    .replaceAll("file://<HOME>", "file://" + tokens.homeUri)
    .replaceAll("file://<ROOT>", "file://" + tokens.rootUri);
}

/** Exported for the test that pins D100: `file://` first, then the escaped plain rewrite. */
export function rewriteContent(text: string, tokens: Tokens, escapeBackslashes: boolean): string {
  const escaped: Tokens = escapeBackslashes
    ? {
        ...tokens,
        home: tokens.home.replaceAll("\\", "\\\\"),
        root: tokens.root.replaceAll("\\", "\\\\"),
        homeSlug: tokens.homeSlug.replaceAll("\\", "\\\\"),
        rootSlug: tokens.rootSlug.replaceAll("\\", "\\\\"),
      }
    : tokens;
  return rewriteName(rewriteFileUris(text, tokens), escaped);
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

/** The four token substitutions, nested so one `REPLACE` chain covers every token. */
function replaceChain(column: string): string {
  return (
    `REPLACE(REPLACE(REPLACE(REPLACE(${column}, '<HOME>', ?), '<ROOT>', ?), ` +
    `'__HOME__', ?), '__ROOT__', ?)`
  );
}

/** The tokens a `sqlite[].rewrite` substitutes; exported for the test that pins D100's branch. */
export type FixtureTokens = Tokens;

/**
 * D100: the `UPDATE` behind `sqlite[].rewrite`, branched on `json_valid()`. A column may hold a
 * bare path *or* a JSON document (OpenCode stores both), so the JSON branch substitutes the
 * JSON-escaped spelling of the temp path — a Windows path never lands inside a JSON column with
 * unescaped backslashes, the same rule `ESCAPED_FORMAT` gives text files. `file://` values are
 * rewritten first, to the URI form of the path, and carry no backslashes either way.
 *
 * Anonymous parameters bind in the order they appear in the SQL, which is why the chain is built
 * and bound in one place.
 */
export function sqliteRewriteStatement(
  table: string,
  column: string,
  tokens: FixtureTokens,
): { sql: string; params: string[] } {
  const col = quoteIdentifier(column);
  const uriChain = `REPLACE(REPLACE(${col}, 'file://<HOME>', ?), 'file://<ROOT>', ?)`;
  const uris = ["file://" + tokens.homeUri, "file://" + tokens.rootUri];
  const plain = [tokens.home, tokens.root, tokens.homeSlug, tokens.rootSlug];
  const jsonEscaped = plain.map((value) => value.replaceAll("\\", "\\\\"));
  return {
    sql:
      `UPDATE ${quoteIdentifier(table)} SET ${col} = CASE WHEN json_valid(${uriChain}) ` +
      `THEN ${replaceChain(uriChain)} ELSE ${replaceChain(uriChain)} END ` +
      `WHERE typeof(${col}) = 'text'`,
    params: [...uris, ...uris, ...jsonEscaped, ...uris, ...plain],
  };
}

/**
 * Runs `sqliteRewriteStatement` over the named columns; WAL/SHM sidecars the case committed
 * survive. The contract names `<HOME>` / `<ROOT>` for `sqlite[].rewrite`; the slug tokens are
 * replaced too so a slug spelled inside a database row follows the same rule as text files.
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
      const { sql, params } = sqliteRewriteStatement(table, column, tokens);
      db.prepare(sql).run(...params);
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
/**
 * The tree's absolute path is padded to the same length on every machine and every platform.
 * A fixture file carries `<HOME>` / `<ROOT>` placeholders that are rewritten with real paths, so
 * its size — and every byte count, slug and rendered line derived from it — would otherwise
 * depend on how long the host's temp directory happens to be: 83 characters on macOS, 31 on a
 * Linux runner, which is why a snapshot taken on one failed on the other. Padding costs nothing
 * and makes the whole suite platform-independent.
 *
 * A host whose temp directory is already longer than the target keeps its own length; the
 * snapshots then differ, and the error a mismatch produces says so.
 */
/**
 * Every regular file and directory below `dir`, deepest last; symlinks are never followed nor
 * touched. Directories are in the walk because a directory's mtime is a timestamp a unit can
 * report: left at the moment the copy ran, it is the one value in the tree that still depends on
 * the wall clock, and a snapshot that hides it behind a window around "now" goes red on its own
 * once the window drifts past the day the snapshot was taken.
 */
async function entriesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    // eslint-disable-next-line no-await-in-loop -- a bounded walk over a fixture tree
    if (entry.isDirectory()) found.push(...(await entriesUnder(path)), path);
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

const TREE_PATH_LENGTH = 96;

async function fixedLengthTempDir(): Promise<string> {
  const base = await realpath(await mkdtemp(join(tmpdir(), "moldig-fixture-")));
  const padding = Math.max(1, TREE_PATH_LENGTH - base.length - 1);
  const dir = join(base, "t".repeat(padding));
  await mkdir(dir, { recursive: true });
  return dir;
}

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
  const platform = options.platform ?? hostPlatform();
  const dir = await fixedLengthTempDir();
  const home = join(dir, "home");
  const root = join(dir, "root");
  const tokens: Tokens = {
    home,
    root,
    homeSlug: rule.slug(home),
    rootSlug: rule.slug(root),
    // `pathname` is the percent-encoded, forward-slashed form: `/tmp/…` here, `/C:/…` on win32.
    homeUri: pathToFileURL(home).pathname,
    rootUri: pathToFileURL(root).pathname,
  };
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
    // Every file the case does not age gets one fixed timestamp, a minute before `now`, so no
    // metric depends on when the suite happened to run: with the copy's own clock, whether an
    // aged member was the newest of its unit flipped depending on the time of day, which is how
    // a snapshot taken before noon failed on a runner after it. Aged files are set afterwards
    // so their own timestamps win.
    // A minute, not an hour: a `recent-activity` live guard asks whether the unit changed inside
    // the harness's activity window, and a case that exercises a live unit must keep doing so.
    const unaged = fixtureCopyTime(now);
    await sequentially([...(await entriesUnder(dir)), dir], (path) => utimes(path, unaged, unaged));
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
    platform,
    env: { ...options.env },
    harness,
    path: casePath,
    slug: (absolutePath) => rule.slug(absolutePath),
    // `dir` is the padded child of the directory `mkdtemp` made; removing the parent takes both.
    cleanup: () => rm(dirname(dir), { recursive: true, force: true }),
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
