/**
 * Git-tracked status per repository (ticket 07: one `git ls-files` + one ignored listing per
 * present repository, run only by `scan`; discovery never spawns git). Every failure is
 * reported to the caller instead of thrown, so a repository the binary rejects — a `.git`
 * holding only `HEAD`, as the fixtures do — degrades to `gitStatus: null`.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { GitStatus } from "../index/types.js";

interface Command {
  ok: boolean;
  stdout: string;
  error: string | null;
}

function run(args: string[], cwd: string | undefined): Promise<Command> {
  return new Promise((resolveRun) => {
    execFile(
      "git",
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 20_000 },
      (error, stdout, stderr) => {
        if (error) {
          resolveRun({ ok: false, stdout: "", error: stderr.trim() || error.message });
        } else {
          resolveRun({ ok: true, stdout, error: null });
        }
      },
    );
  });
}

/** `git --version`'s number, or `null` when the binary is missing or fails. */
export async function gitVersion(): Promise<string | null> {
  const result = await run(["--version"], undefined);
  if (!result.ok) return null;
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(result.stdout);
  return match?.[1] ?? result.stdout.trim();
}

export interface RepoGitStatus {
  /** Absolute path → status for tracked and ignored files; untracked is the default below. */
  statusOf(absolutePath: string): GitStatus;
}

export type RepoGitResult = { ok: true; status: RepoGitStatus } | { ok: false; error: string };

function splitZ(stdout: string): string[] {
  return stdout.split("\0").filter((entry) => entry !== "");
}

/**
 * Tracked and ignored paths of one repository (worktree included when `dir` is a worktree).
 *
 * The two listings are independent, so they run at once. `--directory` on the ignored listing is
 * what makes a scan of a real home affordable (ticket 28): without it git walks into every
 * ignored tree and names each file inside — measured on one machine, 26 repositories, 1.3 M
 * entries and 114 MB of output in 64 s, two of them past the 64 MB buffer. With it git stops at
 * the top of an ignored tree and names the directory: 360 entries, no failures, 3.7 s. `statusOf`
 * already answers `ignored` for anything under a `dir/` entry, which is how the two listings give
 * the same answer for a file; a directory inside a collapsed tree now answers `ignored` too,
 * which is what git itself says of it and what §2.11 describes.
 */
export async function repoGitStatus(dir: string): Promise<RepoGitResult> {
  const [tracked, ignored] = await Promise.all([
    run(["ls-files", "-z"], dir),
    run(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], dir),
  ]);
  if (!tracked.ok) return { ok: false, error: tracked.error ?? "git ls-files failed" };
  if (!ignored.ok) return { ok: false, error: ignored.error ?? "git ls-files --ignored failed" };
  const trackedSet = new Set(splitZ(tracked.stdout).map((entry) => join(dir, entry)));
  const ignoredSet = new Set(splitZ(ignored.stdout).map((entry) => join(dir, entry)));
  // The prefix rule only ever consults the directory entries, and it runs once per queried path:
  // walking the whole listing for each of them is what makes a large repository quadratic.
  const ignoredDirs = [...ignoredSet].filter((entry) => entry.endsWith("/"));
  return {
    ok: true,
    status: {
      statusOf(absolutePath) {
        if (trackedSet.has(absolutePath)) return "tracked";
        if (ignoredSet.has(absolutePath)) return "ignored";
        for (const entry of ignoredDirs) {
          if (absolutePath.startsWith(entry)) return "ignored";
        }
        return "untracked";
      },
    },
  };
}
