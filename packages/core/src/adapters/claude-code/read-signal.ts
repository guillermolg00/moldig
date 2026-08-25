/**
 * The exact memory read signal (research 06 + its correction, tickets 07/08 §2): a `Read`
 * tool_use whose `file_path` names a memory file, found in the transcripts of the Project the
 * unit belongs to (every slug directory folding into it, sub-agent transcripts included) or,
 * for a stray unit, in its own slug directory. Computed by `audit` and interactive `clean`
 * over a finished index — never by `scan`. Index files keep `neverRead: null` (the harness
 * injects them without a `Read`).
 */
import { dirname } from "node:path";
import type { Entity, Index, MemoryFile } from "../../index/types.js";
import { pathIdentity } from "../../scan/paths.js";
import { scanToolUses, transcriptFilesOf } from "./transcripts.js";

interface UseStats {
  reads: number;
  readFirst: string | null;
  readLast: string | null;
  writes: number;
  writeLast: string | null;
}

/** Folded path → tool-use stats, over every transcript of the given slug directories. */
async function usesIn(
  slugDirs: readonly string[],
  fold: (path: string) => string,
): Promise<Map<string, UseStats>> {
  const stats = new Map<string, UseStats>();
  const files = (await Promise.all(slugDirs.map((dir) => transcriptFilesOf(dir)))).flat();
  await Promise.all(
    files.map((file) =>
      scanToolUses(file, (use) => {
        const path = fold(use.path);
        const entry = stats.get(path) ?? {
          reads: 0,
          readFirst: null,
          readLast: null,
          writes: 0,
          writeLast: null,
        };
        if (use.tool === "Read") {
          entry.reads += 1;
          if (use.timestamp !== null) {
            if (entry.readFirst === null || use.timestamp < entry.readFirst)
              entry.readFirst = use.timestamp;
            if (entry.readLast === null || use.timestamp > entry.readLast)
              entry.readLast = use.timestamp;
          }
        } else if (use.tool === "Write" || use.tool === "Edit" || use.tool === "MultiEdit") {
          entry.writes += 1;
          if (
            use.timestamp !== null &&
            (entry.writeLast === null || use.timestamp > entry.writeLast)
          ) {
            entry.writeLast = use.timestamp;
          }
        }
        stats.set(path, entry);
      }),
    ),
  );
  return stats;
}

/** The slug directories whose transcripts decide the signal of a unit (`null` = no transcripts to ask). */
function transcriptDirsOf(
  file: MemoryFile,
  slugDirsByProject: ReadonlyMap<string, readonly string[]>,
  slugDirs: ReadonlySet<string>,
  fold: (path: string) => string,
): readonly string[] | null {
  if (file.project !== null) return slugDirsByProject.get(file.project) ?? null;
  // A stray unit under `projects/<slug>/memory`: its own slug directory.
  const own = dirname(file.unit);
  return slugDirs.has(fold(own)) ? [own] : null;
}

/**
 * Returns the index with every Claude Code memory file carrying its read signal: `reads`,
 * `writes`, `neverRead` (facts only) and `readSignal.source: "transcript-tool-use"`. A file
 * whose unit has no transcripts to ask (a user-scope sub-agent memory) stays `not-computed`.
 */
export async function withReadSignal(index: Index): Promise<Index> {
  const fold = pathIdentity(index.scan.platform).fold;
  const slugDirsByProject = new Map<string, string[]>();
  const slugDirs = new Set<string>();
  for (const crumb of index.breadcrumbs) {
    if (crumb.harness !== "claude-code" || crumb.kind !== "slug-directory") continue;
    if (crumb.locator.type !== "dir") continue;
    slugDirs.add(fold(crumb.locator.path));
    if (crumb.project === null) continue;
    slugDirsByProject.set(crumb.project, [
      ...(slugDirsByProject.get(crumb.project) ?? []),
      crumb.locator.path,
    ]);
  }
  const memoryFiles = index.entities.filter(
    (entity): entity is MemoryFile =>
      entity.kind === "memory-file" && entity.harness === "claude-code",
  );
  const groups = new Map<string, readonly string[]>();
  for (const file of memoryFiles) {
    const dirs = transcriptDirsOf(file, slugDirsByProject, slugDirs, fold);
    if (dirs !== null) groups.set(dirs.join("\0"), dirs);
  }
  const usesByGroup = new Map<string, Map<string, UseStats>>();
  await Promise.all(
    [...groups].map(async ([key, dirs]) => {
      usesByGroup.set(key, await usesIn(dirs, fold));
    }),
  );
  const entities: Entity[] = index.entities.map((entity) => {
    if (entity.kind !== "memory-file" || entity.harness !== "claude-code") return entity;
    const dirs = transcriptDirsOf(entity, slugDirsByProject, slugDirs, fold);
    if (dirs === null) return entity;
    const stats = usesByGroup.get(dirs.join("\0"))?.get(fold(entity.path)) ?? null;
    const reads = stats?.reads ?? 0;
    const signalled: MemoryFile = {
      ...entity,
      reads: { count: reads, first: stats?.readFirst ?? null, last: stats?.readLast ?? null },
      writes: { count: stats?.writes ?? 0, last: stats?.writeLast ?? null },
      neverRead: entity.role === "index" ? null : reads === 0,
      readSignal: { source: "transcript-tool-use", exact: true, bashParsed: false },
    };
    return signalled;
  });
  return { ...index, entities };
}
