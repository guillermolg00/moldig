/**
 * The fake executors the tests drive a whole run through (08 §9). Nothing here reaches the real
 * trash, the real data directory or a real process: a trashed path is renamed into a directory
 * inside the test's own temp tree, a delegate is recorded and answered with a scripted exit
 * code, and every write lands under the temp data directory the fixture's `XDG_DATA_HOME`
 * points at.
 *
 * Never published (`files: ["dist"]`); it exists so `run.test.ts` and `tui.test.ts` share one
 * honest fake instead of two half-fakes.
 */
import { mkdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import type { Executors, SpawnResult, TrashResult } from "@moldig/core";
import { backup, readText, statPath, writeAtomic } from "./files.js";

export interface FakeExecutorOptions {
  /** Where a trashed path is renamed to; inside the test's temp tree, never an OS trash. */
  readonly trashDir: string;
  /** The clock every timestamp in the manifest comes from. */
  readonly now?: Date;
  /** Paths the fake trash refuses to move, so a failed row is testable (08 §3). */
  readonly failing?: readonly string[];
  /**
   * `false` records the call and leaves the tree in place, so several tests can share one
   * fixture; `true` really renames into `trashDir`, which is what proves a run moved a unit.
   */
  readonly move?: boolean;
  /** The exit code every delegate answers with; a non-zero one fails its row (D92). */
  readonly exitCode?: number;
  readonly stderr?: string;
}

export interface FakeExecutors {
  readonly executors: Executors;
  /** One entry per `trash()` call, in order. */
  readonly trashed: string[][];
  readonly spawned: { argv: string[]; cwd: string | null }[];
  readonly backedUp: { path: string; to: string }[];
  readonly written: string[];
}

export function createFakeExecutors(options: FakeExecutorOptions): FakeExecutors {
  const trashed: string[][] = [];
  const spawned: { argv: string[]; cwd: string | null }[] = [];
  const backedUp: { path: string; to: string }[] = [];
  const written: string[] = [];
  const failing = new Set(options.failing ?? []);
  let call = 0;

  const trash = async (paths: string[]): Promise<TrashResult> => {
    trashed.push([...paths]);
    call += 1;
    const bin = join(options.trashDir, String(call));
    if (options.move !== false) await mkdir(bin, { recursive: true });
    const moved: string[] = [];
    const left: string[] = [];
    for (const [index, path] of paths.entries()) {
      if (failing.has(path)) {
        left.push(path);
        continue;
      }
      if (options.move !== false) {
        // oxlint-disable-next-line no-await-in-loop -- a handful of members per unit
        await rename(path, join(bin, `${index}-${basename(path)}`));
      }
      moved.push(path);
    }
    return {
      moved,
      left,
      error: left.length === 0 ? null : "EPERM: operation not permitted",
    };
  };

  const spawn = (command: { argv: string[]; cwd: string | null }): Promise<SpawnResult> => {
    spawned.push({ argv: [...command.argv], cwd: command.cwd });
    return Promise.resolve({ exitCode: options.exitCode ?? 0, stderr: options.stderr ?? "" });
  };

  const executors: Executors = {
    trash,
    spawn,
    backup: async (path, to) => {
      backedUp.push({ path, to });
      await backup(path, to);
    },
    writeFile: async (path, text) => {
      written.push(path);
      await writeAtomic(path, text);
    },
    readFile: readText,
    stat: statPath,
    now: () => options.now ?? new Date(),
  };
  return { executors, trashed, spawned, backedUp, written };
}
