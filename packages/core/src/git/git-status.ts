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

/** Tracked and ignored paths of one repository (worktree included when `dir` is a worktree). */
export async function repoGitStatus(dir: string): Promise<RepoGitResult> {
  const tracked = await run(["ls-files", "-z"], dir);
  if (!tracked.ok) return { ok: false, error: tracked.error ?? "git ls-files failed" };
  const ignored = await run(["ls-files", "-z", "--others", "--ignored", "--exclude-standard"], dir);
  if (!ignored.ok) return { ok: false, error: ignored.error ?? "git ls-files --ignored failed" };
  const trackedSet = new Set(splitZ(tracked.stdout).map((entry) => join(dir, entry)));
  const ignoredSet = new Set(splitZ(ignored.stdout).map((entry) => join(dir, entry)));
  return {
    ok: true,
    status: {
      statusOf(absolutePath) {
        if (trackedSet.has(absolutePath)) return "tracked";
        if (ignoredSet.has(absolutePath)) return "ignored";
        for (const entry of ignoredSet) {
          if (entry.endsWith("/") && absolutePath.startsWith(entry)) return "ignored";
        }
        return "untracked";
      },
    },
  };
}
