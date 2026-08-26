/**
 * The executors `@moldig/core` runs the actions engine through (D88, D103): the OS trash, a
 * backup copier, an atomic write, a shell-free spawn, and the two fetchers the Update preview
 * needs. Assembling them is all this file does — every rule lives in core.
 */
import type { Executors, UpdateFetchers } from "@moldig/core";
import { backup, readText, statPath, writeAtomic } from "./files.js";
import { spawnDelegate } from "./spawn.js";
import { createTrash, type Mover } from "./trash.js";

export { createDeviceProbe } from "./volumes.js";
export type { DeviceProbeOptions } from "./volumes.js";
export { createTrash } from "./trash.js";
export type { Mover } from "./trash.js";
export { backup, ensureDirFor, readText, statPath, writeAtomic } from "./files.js";
export { spawnDelegate } from "./spawn.js";

export interface ExecutorOptions {
  /** Deterministic clock for the tests; defaults to the real one. */
  now?: () => Date;
  /** What moves paths to the trash; defaults to the `trash` package. */
  mover?: Mover;
}

export function createExecutors(options: ExecutorOptions = {}): Executors {
  return {
    trash: createTrash(options.mover),
    backup,
    writeFile: writeAtomic,
    spawn: spawnDelegate,
    readFile: readText,
    stat: statPath,
    now: options.now ?? ((): Date => new Date()),
  };
}

/**
 * The only network moldig ever touches, and only when an Update preview asks for it (14 §2).
 * Any failure answers `null`, which the preview degrades to "upstream unreachable".
 */
export function createFetchers(): UpdateFetchers {
  return {
    fetchText: async (url, { timeoutMs }) => {
      try {
        const response = await fetch(url, {
          signal: AbortSignal.timeout(timeoutMs),
          headers: { accept: "*/*", "user-agent": "moldig" },
        });
        return { status: response.status, text: await response.text() };
      } catch {
        return null;
      }
    },
  };
}
