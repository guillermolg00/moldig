/**
 * How a test names a path inside a fixture tree — the one place that composes them.
 *
 * A test used to write `` `${tree.home}/.claude/settings.json` ``, which on Windows produces the
 * mixed `C:\…\home/.claude/settings.json` while the entity's real path (and therefore its id) is
 * `C:\…\home\.claude\settings.json`: every `entity()` lookup then misses and the whole file fails.
 * `treePaths(tree)` composes with `pathEngine`, the same rule the scanner uses — the win32 engine
 * when the tree's own path is spelled `C:\…`, the host's otherwise — so one spelling works on
 * macOS, Linux and Windows, and a `platform: "win32"` tree keeps win32 rules on a POSIX host.
 *
 * `id()` mirrors what the scanner gives an entity: `entityId` over `pathIdentity(platform).fold`,
 * with the platform read from the tree. A case pinned to `darwin` folds case only, so the ids keep
 * whatever separator the host wrote — which is why the path handed to `id()` must be composed the
 * same way, never by hand.
 *
 * ```ts
 * const { home, root, slugDir, rootSlug, id } = treePaths(() => tree);
 * entity("settings-file", home(".claude/settings.json"));
 * entity("memory-file", slugDir(`${rootSlug()}-project-a`, "memory/MEMORY.md"));
 * ```
 *
 * The tree may be passed lazily (`() => tree`) so the helpers can be destructured at module scope
 * while `loadFixture` still runs in `beforeAll`. Node built-ins only (ADR-0003).
 */
import { entityId, pathEngine, pathIdentity, type ScanPlatform } from "../scan/paths.js";

/**
 * The per-path cache directory of every harness that derives one from a path, relative to `home`.
 * Same directories the adapters build in their `paths.ts`; a harness without one has no entry.
 */
const SLUG_DIRS: Readonly<Record<string, string>> = {
  "claude-code": ".claude/projects",
  cursor: ".cursor/projects",
  "gemini-cli": ".gemini/tmp",
};

/**
 * What `treePaths` reads from a tree: a `FixtureTree` satisfies it, and so does the synthetic
 * `{ dir, home, root }` a test builds in a temp directory of its own.
 */
export interface PathTree {
  readonly dir: string;
  readonly home: string;
  readonly root: string;
  /** The platform the scan is pinned to — it decides how `id` folds. */
  readonly platform: ScanPlatform;
  /** The harness directory of the case — it decides where `slugDir` points. */
  readonly harness: string;
  /** The harness's slug of an absolute path. */
  slug(absolutePath: string): string;
}

/**
 * Every member is a property holding a closure, never a method: a test destructures them
 * (`const { home, root, id } = treePaths(…)`) and a method would carry a `this` to lose.
 */
export interface TreePaths {
  /** `<dir>/<relative…>` — the temp directory holding `home/` and `root/`. */
  readonly dir: (...relative: string[]) => string;
  /** `<home>/<relative…>`. */
  readonly home: (...relative: string[]) => string;
  /** `<root>/<relative…>`. */
  readonly root: (...relative: string[]) => string;
  /**
   * `<home>/<the harness's slug directory>/<relative…>` — `~/.claude/projects`,
   * `~/.cursor/projects` or `~/.gemini/tmp`. Throws for a harness that has none.
   */
  readonly slugDir: (...relative: string[]) => string;
  /** The harness's slug of the tree's home directory (`__HOME__` in a case). */
  readonly homeSlug: () => string;
  /** The harness's slug of the tree's root directory (`__ROOT__` in a case). */
  readonly rootSlug: () => string;
  /**
   * The id the scan gives the entity at `path`: `<kind>:<folded path>[#keyPath]`, folded with the
   * rules of the platform the tree pins. `path` may carry a `#keyPath`, which never folds.
   */
  readonly id: (kind: string, path: string) => string;
}

/** Joins with the rules the base path's own spelling implies, never the host's blindly. */
function compose(base: string, relative: readonly string[]): string {
  return relative.length === 0 ? base : pathEngine(base).join(base, ...relative);
}

export function treePaths(tree: PathTree | (() => PathTree)): TreePaths {
  const of = typeof tree === "function" ? tree : (): PathTree => tree;
  const slugRoot = (): string => {
    const { harness } = of();
    const relative = SLUG_DIRS[harness];
    if (relative === undefined) {
      throw new Error(
        `treePaths: the ${harness} cases have no path-derived slug directory ` +
          `(one of ${Object.keys(SLUG_DIRS).join(", ")} does)`,
      );
    }
    return compose(of().home, [relative]);
  };
  return {
    dir: (...relative) => compose(of().dir, relative),
    home: (...relative) => compose(of().home, relative),
    root: (...relative) => compose(of().root, relative),
    slugDir: (...relative) => compose(slugRoot(), relative),
    homeSlug: () => of().slug(of().home),
    rootSlug: () => of().slug(of().root),
    id: (kind, path) => {
      const { fold } = pathIdentity(of().platform);
      const hash = path.indexOf("#");
      if (hash === -1) return entityId(kind, fold(path));
      return entityId(kind, fold(path.slice(0, hash)), [path.slice(hash + 1)]);
    },
  };
}
