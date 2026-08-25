/**
 * Path identity: case folding (darwin / win32 compare case-insensitively, ticket 06), the id
 * shapes of ticket 07 (`<kind>:<folded path>[#keyPath/…]`, `edge:<kind>:<from>:<to>[:<tool>]`),
 * containment tests and the mount-root rule behind "unreachable".
 */
import { dirname, isAbsolute, parse, relative, resolve, sep } from "node:path";
import { statWithDeadline } from "./fs.js";

export interface PathIdentity {
  readonly caseFold: boolean;
  readonly fold: (path: string) => string;
  readonly same: (a: string, b: string) => boolean;
}

export function pathIdentity(platform: NodeJS.Platform): PathIdentity {
  const caseFold = platform === "darwin" || platform === "win32";
  const fold = (path: string): string => (caseFold ? path.toLowerCase() : path);
  return { caseFold, fold, same: (a, b) => fold(a) === fold(b) };
}

export function entityId(kind: string, folded: string, keyPath?: readonly string[]): string {
  return keyPath === undefined || keyPath.length === 0
    ? `${kind}:${folded}`
    : `${kind}:${folded}#${keyPath.join("/")}`;
}

export function edgeId(kind: string, from: string, to: string | null, tool?: string): string {
  const base = `edge:${kind}:${from}:${to ?? "null"}`;
  return tool === undefined ? base : `${base}:${tool}`;
}

/** `true` when `path` is `dir` itself or lies below it (both already resolved and folded alike). */
export function isUnder(path: string, dir: string): boolean {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Relative path with forward slashes, `""` when equal; `null` when `path` is not below `dir`. */
export function relativeUnder(path: string, dir: string): string | null {
  const rel = relative(dir, path);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

export function ancestors(path: string): string[] {
  const out: string[] = [];
  let current = resolve(path);
  for (;;) {
    out.push(current);
    const parent = dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

/** Ticket 06 rule 8: the directories under which a missing path means an unmounted volume. */
const POSIX_MOUNT_ROOTS = ["/Volumes", "/mnt", "/media", "/run/media"];

function isMountRoot(path: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    const parsed = parse(path);
    // A drive root (`C:\`) or a UNC share root (`\\server\share`).
    return parsed.root === path || /^\\\\[^\\]+\\[^\\]+\\?$/.test(path);
  }
  return POSIX_MOUNT_ROOTS.includes(path);
}

/** `true` when `path` lies below one of the mount roots of the platform. */
function underMountRoot(path: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") return /^(?:[A-Za-z]:\\|\\\\)/.test(path);
  return POSIX_MOUNT_ROOTS.some((root) => path.startsWith(root + "/"));
}

export type Presence =
  | { kind: "present"; realpath: string }
  | { kind: "orphan" }
  | { kind: "unreachable"; reason: "mount-root" | "stat-timeout" };

/**
 * Whether a recorded absolute path exists, is gone, or sits on a volume that is not mounted:
 * a missing path whose nearest existing ancestor is a mount root — or whose mount root itself
 * is absent, the plainest form of "not mounted" — is unreachable, not orphan (ticket 06 §5).
 * `stat` runs under a deadline; past it the target is unreachable (`stat-timeout`).
 */
export async function presenceOf(
  path: string,
  platform: NodeJS.Platform,
  deadlineMs: number,
  realpathOf: (path: string) => Promise<string>,
): Promise<Presence> {
  const own = await statWithDeadline(path, deadlineMs);
  if (own === "timeout") return { kind: "unreachable", reason: "stat-timeout" };
  if (own !== null) return { kind: "present", realpath: await realpathOf(path) };
  const chain = ancestors(path).slice(1);
  const results = await Promise.all(
    chain.map(async (ancestor) => ({
      ancestor,
      stats: await statWithDeadline(ancestor, deadlineMs),
    })),
  );
  for (const { ancestor, stats } of results) {
    if (stats === "timeout") return { kind: "unreachable", reason: "stat-timeout" };
    if (stats === null) continue;
    if (isMountRoot(ancestor, platform)) return { kind: "unreachable", reason: "mount-root" };
    if (underMountRoot(path, platform) && !underMountRoot(ancestor + sep + "x", platform)) {
      // The mount root itself is missing on this platform: the volume cannot be mounted here.
      return { kind: "unreachable", reason: "mount-root" };
    }
    return { kind: "orphan" };
  }
  return { kind: "orphan" };
}

/** `~`-shortened display form of a path under the home directory. */
export function tildify(path: string, home: string): string {
  const rel = relativeUnder(path, home);
  return rel === null ? path : rel === "" ? "~" : `~/${rel}`;
}
