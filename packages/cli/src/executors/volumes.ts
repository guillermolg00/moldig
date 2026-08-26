/**
 * `deviceOf` — the one probe `plan()` takes: which device a path sits on and whether that
 * volume has a trash (08 §3.2). Fail closed: a volume moldig cannot classify is `unknown`,
 * which refuses the row (D89).
 *
 * The home volume answers without touching a mount table at all, which is every path on the
 * reference machine; only a path on another device costs a lookup.
 */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import type { Device } from "@moldig/core";

const NETWORK_TYPES = new Set([
  "smbfs",
  "smb",
  "smb3",
  "nfs",
  "nfs4",
  "cifs",
  "afpfs",
  "webdav",
  "davfs",
  "sshfs",
  "9p",
  "afs",
  "ceph",
  "glusterfs",
  "fuse",
]);

/** Mounts the `trash` package drops from its table and would copy across devices from (Linux). */
const DROPPED_PREFIXES = ["/run/", "/snap/", "/var/snap/", "/sys/", "/proc/", "/dev/"];

interface Mount {
  point: string;
  type: string;
  readOnly: boolean;
}

function kindOf(mount: Mount | null, path: string): Device["kind"] {
  if (mount === null) return "unknown";
  if (mount.readOnly) return "read-only";
  const type = mount.type.startsWith("fuse.") ? "fuse" : mount.type;
  if (NETWORK_TYPES.has(type)) return "network";
  if (DROPPED_PREFIXES.some((prefix) => path.startsWith(prefix))) return "dropped-mount";
  return "local";
}

function longestMount(mounts: readonly Mount[], path: string): Mount | null {
  let best: Mount | null = null;
  for (const mount of mounts) {
    const point = mount.point.endsWith("/") ? mount.point : `${mount.point}/`;
    if (path !== mount.point && !path.startsWith(point)) continue;
    if (best === null || mount.point.length > best.point.length) best = mount;
  }
  return best;
}

/** `/proc/self/mountinfo`: … <mount point> <options> … - <fstype> <source> <super options>. */
function linuxMounts(): Mount[] {
  const text = readFileSync("/proc/self/mountinfo", "utf8");
  const mounts: Mount[] = [];
  for (const line of text.split("\n")) {
    const [head, tail] = line.split(" - ");
    if (head === undefined || tail === undefined) continue;
    const fields = head.split(" ");
    const point = fields[4];
    const options = fields[5] ?? "";
    const type = tail.split(" ")[0];
    if (point === undefined || type === undefined) continue;
    mounts.push({
      point: point.replaceAll("\\040", " "),
      type,
      readOnly: options.split(",").includes("ro"),
    });
  }
  return mounts;
}

/** `/sbin/mount` on darwin: `<source> on <point> (<type>, <options>)`. No shell, argv only. */
function darwinMounts(): Mount[] {
  const text = execFileSync("/sbin/mount", [], { encoding: "utf8", timeout: 5000 });
  const mounts: Mount[] = [];
  for (const line of text.split("\n")) {
    const match = /^.* on (.+) \(([^,)]+)(?:, (.*))?\)$/u.exec(line);
    const point = match?.[1];
    const type = match?.[2];
    if (point === undefined || type === undefined) continue;
    const options = (match?.[3] ?? "").split(", ");
    mounts.push({ point, type, readOnly: options.includes("read-only") });
  }
  return mounts;
}

function devOf(path: string): number | null {
  try {
    return lstatSync(path).dev;
  } catch {
    return null;
  }
}

function mountsFor(platform: NodeJS.Platform): Mount[] {
  try {
    if (platform === "linux") return linuxMounts();
    if (platform === "darwin") return darwinMounts();
  } catch {
    return [];
  }
  return [];
}

export interface DeviceProbeOptions {
  home: string;
  platform: NodeJS.Platform;
}

/**
 * The probe `plan()` calls. The home device is read once; a path on it is `local` (the OS
 * trash takes it). A path on another device is looked up in the mount table, and a UNC path
 * on Windows is `network` on sight.
 */
export function createDeviceProbe({
  home,
  platform,
}: DeviceProbeOptions): (path: string) => Device {
  let mounts: Mount[] | null = null;
  let homeDev: number | null = null;
  return (path) => {
    // A UNC path is a share whether or not it answers: `\\server\share\…` (research 10 §4.1).
    if (platform === "win32" && path.startsWith("\\\\"))
      return { dev: devOf(path) ?? -1, kind: "network" };
    homeDev ??= devOf(home);
    const dev = devOf(path);
    if (dev === null) return { dev: -1, kind: "unknown" };
    if (platform === "win32") return { dev, kind: dev === homeDev ? "local" : "unknown" };
    if (dev === homeDev) return { dev, kind: "local" };
    mounts ??= mountsFor(platform);
    return { dev, kind: kindOf(longestMount(mounts, path), path) };
  };
}
