/**
 * The trash executor: the `trash` package (10.x), the OS trash, never a copy across devices
 * (08 §3). It ships native helpers, so it is the CLI's one runtime dependency and is not
 * bundled (D88).
 *
 * Existence is checked with `lstat` before the call — the package ignores what is not there —
 * and every path is checked again afterwards: a rejected promise means unknown partial state,
 * so what is gone moved and what is still in place did not (08 §3).
 */
import { lstat } from "node:fs/promises";
import type { TrashResult } from "@moldig/core";

/** What actually moves the paths; injected so the logic above it is testable without a trash. */
export type Mover = (paths: string[]) => Promise<void>;

async function present(paths: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const path of paths) {
    // oxlint-disable-next-line no-await-in-loop -- a handful of members per unit
    const stat = await lstat(path).catch(() => null);
    if (stat !== null) found.push(path);
  }
  return found;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function move(paths: string[]): Promise<void> {
  // `TRASH_FALLBACK` makes the helper copy across devices on EXDEV; moldig never copies (08 §3).
  delete process.env["TRASH_FALLBACK"];
  const { default: trash } = await import("trash");
  await trash(paths, { glob: false });
}

/** Every path of a target in one call; the package chunks per platform on its own. */
export function createTrash(mover: Mover = move): (paths: string[]) => Promise<TrashResult> {
  return async (paths) => {
    const before = await present(paths);
    if (before.length === 0) return { moved: [], left: [], error: null };
    let error: string | null = null;
    try {
      await mover(before);
    } catch (failure) {
      error = messageOf(failure);
    }
    const left = await present(before);
    const moved = before.filter((path) => !left.includes(path));
    return {
      moved,
      left,
      error: left.length === 0 ? null : (error ?? "the trash left files behind"),
    };
  };
}
