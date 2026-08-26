/* oxlint-disable no-await-in-loop -- sequential on purpose: bounded disk IO and a stable order */
/**
 * The two record stores discovery reads before git runs: the Copilot CLI's
 * `session-state/<uuid>/workspace.yaml` (the session's `cwd` and `git_root`, never its
 * `summary`, `repository` or `branch`) and VS Code's `workspaceStorage/<id>/workspace.json`
 * (the folder URI of a window). `events.jsonl`, `session.db` and `state.vscdb` are never
 * opened: everything here comes from two small text files.
 */
import { join } from "node:path";
import { warning, type ScanContext } from "../../scan/context.js";
import { listDir, readJsonObject, readText } from "../../scan/fs.js";
import { HARNESS, type SessionRecord, type WorkspaceRecord } from "./model.js";
import { parseFlatYaml } from "./parse.js";

/** The only keys of a `workspace.yaml` that reach moldig (06 §1; research 09 §1). */
const SESSION_KEYS = ["id", "cwd", "git_root", "created_at", "updated_at"] as const;

function stringOr(value: string | undefined): string | null {
  return value === undefined || value === "" ? null : value;
}

export async function readSessions(dir: string, ctx: ScanContext): Promise<SessionRecord[]> {
  const entries = (await listDir(dir))
    .filter((entry) => entry.isDirectory())
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const out: SessionRecord[] = [];
  for (const entry of entries) {
    const sessionDir = join(dir, entry.name);
    const file = join(sessionDir, "workspace.yaml");
    const text = await readText(file);
    if (text === null) {
      ctx.warn(
        warning(
          "parse-error",
          "workspace.yaml is missing: the session's directory is listed with no Project",
          HARNESS,
          file,
          "partial",
        ),
      );
      out.push({
        id: entry.name,
        dir: sessionDir,
        file,
        cwd: null,
        gitRoot: null,
        createdAt: null,
        updatedAt: null,
        located: null,
      });
      continue;
    }
    const parsed = parseFlatYaml(text, SESSION_KEYS);
    if (parsed.unsupported) {
      ctx.warn(
        warning(
          "unsupported-shape",
          "workspace.yaml is richer than the flat key/value shape moldig reads: the extra lines are skipped",
          HARNESS,
          file,
          "skipped",
        ),
      );
    }
    if (parsed.empty) {
      ctx.warn(
        warning(
          "parse-error",
          "workspace.yaml holds no key/value line: the session's directory is listed with no Project",
          HARNESS,
          file,
          "partial",
        ),
      );
    }
    out.push({
      id: stringOr(parsed.data["id"]) ?? entry.name,
      dir: sessionDir,
      file,
      cwd: stringOr(parsed.data["cwd"]),
      gitRoot: stringOr(parsed.data["git_root"]),
      createdAt: stringOr(parsed.data["created_at"]),
      updatedAt: stringOr(parsed.data["updated_at"]),
      located: null,
    });
  }
  return out;
}

/** `file://…` → an absolute path; a non-`file:` scheme is a folder moldig cannot reach (D31). */
function folderOf(raw: string): { path: string | null; remote: boolean } {
  const scheme = /^([A-Za-z][\w+.-]*):\/\//.exec(raw);
  if (scheme === null) return { path: raw, remote: false };
  if (scheme[1]?.toLowerCase() !== "file") return { path: null, remote: true };
  try {
    return { path: decodeURIComponent(raw.slice("file://".length)) || null, remote: false };
  } catch {
    return { path: null, remote: false };
  }
}

export async function readWorkspaces(dir: string, ctx: ScanContext): Promise<WorkspaceRecord[]> {
  const entries = (await listDir(dir))
    .filter((entry) => entry.isDirectory())
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const out: WorkspaceRecord[] = [];
  for (const entry of entries) {
    const storageDir = join(dir, entry.name);
    const file = join(storageDir, "workspace.json");
    const data = await readJsonObject(file);
    const record: WorkspaceRecord = {
      storageId: entry.name,
      dir: storageDir,
      file,
      raw: null,
      located: null,
      unresolved: true,
      remote: false,
    };
    if (data === null) {
      // A storage directory without a readable `workspace.json` names no folder (D31): a Stray
      // breadcrumb, and the directory itself is still a cache unit.
      out.push(record);
      continue;
    }
    const folder = data["folder"];
    if (typeof folder !== "string") {
      if (!("workspace" in data)) {
        ctx.warn(
          warning(
            "unsupported-shape",
            "workspace.json names neither a folder nor a workspace: the record points at nothing",
            HARNESS,
            file,
            "skipped",
          ),
        );
      }
      // A multi-root `{"workspace": …}` record: its `folders[]` are out of v1 (D31).
      out.push({
        ...record,
        raw: typeof data["workspace"] === "string" ? data["workspace"] : null,
      });
      continue;
    }
    const resolved = folderOf(folder);
    out.push({
      ...record,
      raw: folder,
      unresolved: resolved.path === null,
      remote: resolved.remote,
    });
  }
  return out;
}

/** The absolute path a workspace record names, when it names one at all. */
export function workspacePathOf(record: WorkspaceRecord): string | null {
  if (record.raw === null || record.unresolved) return null;
  return folderOf(record.raw).path;
}
