/**
 * The descent every adapter's context-file pass makes over a Project member: the directories a
 * harness would look in for its own context file, in the order it would read them.
 *
 * Six adapters carried a private copy of this walk with the same depth, the same pruned names
 * and the same rule that a skill's payload is never entered — three of them sequential. One copy
 * runs the levels of a directory concurrently, and `listDir`'s per-scan memo means the second
 * adapter to ask about a tree re-reads none of it (ticket 28).
 */
import { join } from "node:path";
import { listDir } from "./fs.js";

/** Ticket 06: a Project's own directories only; six levels is deeper than any real chain. */
export const NESTED_DEPTH = 6;

/** Build outputs and dependency trees: never a Project's own context, always expensive to walk. */
const PRUNED: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "__pycache__",
  "coverage",
]);

/**
 * Directories below `dir` (never `dir` itself), depth-first and sorted by name, so the result is
 * the order a harness reads the levels in. Symlinks are not followed, dot-directories and the
 * pruned names are skipped, and a directory holding a `SKILL.md` is a skill's payload: its
 * contents belong to the skill, never to the Project (edge case 9).
 */
export async function nestedProjectDirs(dir: string, depth = 0): Promise<string[]> {
  if (depth >= NESTED_DEPTH) return [];
  const children = (await listDir(dir))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .filter((entry) => !PRUNED.has(entry.name) && !entry.name.startsWith("."))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const found = await Promise.all(
    children.map(async (entry) => {
      const child = join(dir, entry.name);
      if ((await listDir(child)).some((item) => item.name === "SKILL.md")) return [];
      const below = await nestedProjectDirs(child, depth + 1);
      below.unshift(child);
      return below;
    }),
  );
  return found.flat();
}
