/**
 * Path identity: case folding (darwin / win32 compare case-insensitively, ticket 06), the id
 * shapes of ticket 07 (`<kind>:<folded path>[#keyPath/…]`, `edge:<kind>:<from>:<to>[:<tool>]`),
 * containment tests and the mount-root rule behind "unreachable".
 */
import nodePath, { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { statWithDeadline } from "./fs.js";

/** The three platforms moldig scans (ticket 07 `scan.platform`; D125 — nothing else is accepted). */
export type ScanPlatform = "darwin" | "linux" | "win32";

export const SCAN_PLATFORMS: readonly ScanPlatform[] = ["darwin", "linux", "win32"];

export function isScanPlatform(value: string): value is ScanPlatform {
  return (SCAN_PLATFORMS as readonly string[]).includes(value);
}

/**
 * D125: a platform outside `darwin | linux | win32` is never silently recorded as darwin.
 * `scan` throws; the CLI turns the throw into a usage error.
 */
export function assertScanPlatform(value: string): ScanPlatform {
  if (isScanPlatform(value)) return value;
  throw new Error(
    `unsupported platform "${value}": moldig scans ${SCAN_PLATFORMS.join(", ")} only`,
  );
}

export interface PathIdentity {
  readonly caseFold: boolean;
  readonly fold: (path: string) => string;
  readonly same: (a: string, b: string) => boolean;
}

/**
 * Identity of a path: darwin and win32 compare case-insensitively (ticket 06 §2), and win32
 * also compares `\` and `/` alike (D141) so one directory has one id whatever separator the
 * harness recorded. `path` fields keep the on-disk form; only ids and comparisons fold.
 */
export function pathIdentity(platform: NodeJS.Platform): PathIdentity {
  const caseFold = platform === "darwin" || platform === "win32";
  const separators = platform === "win32";
  const fold = (path: string): string => {
    const cased = caseFold ? path.toLowerCase() : path;
    return separators ? cased.replaceAll("\\", "/") : cased;
  };
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

/** A win32 absolute path (`D:\proj`, `\\server\share\x`) — recognisable from any host. */
const WIN32_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;

export function isWin32Path(path: string): boolean {
  return WIN32_ABSOLUTE.test(path);
}

/**
 * The path rules a path's own spelling implies: `win32` for `C:\…` and `\\server\share\…`,
 * the host's otherwise. Joining a win32 home with the host's rules would build `C:\Users\x/.codex`
 * on a POSIX host, which is the shape a fixture run with `platform: "win32"` must not produce.
 */
export function pathEngine(path: string): typeof win32 {
  return WIN32_ABSOLUTE.test(path) ? win32 : nodePath;
}

/**
 * Ancestors read with the *target* platform's rules, so a win32 path keeps its drive root
 * (`D:\proj` → `D:\`) when the scan runs on a POSIX host with `platform: "win32"` (D35).
 */
export function ancestorsOn(path: string, platform: ScanPlatform): string[] {
  if (platform !== "win32" || !WIN32_ABSOLUTE.test(path)) return ancestors(path);
  const out: string[] = [];
  let current = win32.resolve(path);
  for (;;) {
    out.push(current);
    const parent = win32.dirname(current);
    if (parent === current) return out;
    current = parent;
  }
}

/** Ticket 06 rule 8: the directories under which a missing path means an unmounted volume. */
const POSIX_MOUNT_ROOTS = ["/Volumes", "/mnt", "/media", "/run/media"];

function isMountRoot(path: string, platform: ScanPlatform): boolean {
  if (platform === "win32") {
    // A drive root (`C:\`) or a UNC share root (`\\server\share`), read with win32 rules
    // whatever the host runs.
    return win32.parse(path).root === path || /^\\\\[^\\]+\\[^\\]+\\?$/.test(path);
  }
  return POSIX_MOUNT_ROOTS.includes(path);
}

/** `true` when `path` lies below one of the mount roots of the platform. */
function underMountRoot(path: string, platform: ScanPlatform): boolean {
  if (platform === "win32") return WIN32_ABSOLUTE.test(path);
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
 * A win32 path on a drive letter that does not exist has no existing ancestor at all: the drive
 * root is a mount root, so it too is unreachable (D35). `stat` runs under a deadline; past it
 * the target is unreachable (`stat-timeout`).
 */
export async function presenceOf(
  path: string,
  platform: ScanPlatform,
  deadlineMs: number,
  realpathOf: (path: string) => Promise<string>,
): Promise<Presence> {
  const own = await statWithDeadline(path, deadlineMs);
  if (own === "timeout") return { kind: "unreachable", reason: "stat-timeout" };
  if (own !== null) return { kind: "present", realpath: await realpathOf(path) };
  const separator = platform === "win32" ? win32.sep : sep;
  const chain = ancestorsOn(path, platform).slice(1);
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
    if (underMountRoot(path, platform) && !underMountRoot(ancestor + separator + "x", platform)) {
      // The mount root itself is missing on this platform: the volume cannot be mounted here.
      return { kind: "unreachable", reason: "mount-root" };
    }
    return { kind: "orphan" };
  }
  // Nothing on the chain exists — an absent drive letter or UNC share (D35).
  return underMountRoot(path, platform)
    ? { kind: "unreachable", reason: "mount-root" }
    : { kind: "orphan" };
}

/** `~`-shortened display form of a path under the home directory. */
export function tildify(path: string, home: string): string {
  const rel = relativeUnder(path, home);
  return rel === null ? path : rel === "" ? "~" : `~/${rel}`;
}
