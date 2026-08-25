/**
 * Transcripts under `~/.claude/projects/<slug>/` (research 01 §6, 06, 07): `scan` only stats
 * them. A transcript's head (the first record's `cwd`, `version` and `timestamp`, first 64 KB)
 * is read on demand — for the newest transcript (the harness version) and for a slug that
 * neither a `projects` key nor a known Project resolves (ticket 06 rule 6). `tool_use` blocks
 * (tool name, `file_path`, timestamp) are streamed only by the read signal, in `audit`. No
 * message content is ever kept.
 */
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { isRecord, listDir, lstatOrNull } from "../../scan/fs.js";
import { SESSION_ID } from "./paths.js";

export interface TranscriptFile {
  path: string;
  slugDir: string;
  slug: string;
  /** From the file name (`<id>.jsonl`). */
  sessionId: string;
  mtimeMs: number;
}

export interface TranscriptHead {
  cwd: string | null;
  version: string | null;
  timestamp: string | null;
}

const HEAD_BYTES = 64 * 1024;

/** The first record's `cwd`, `version` and `timestamp` (first 64 KB only). */
export async function readTranscriptHead(path: string): Promise<TranscriptHead | null> {
  const stats = await lstatOrNull(path);
  if (stats === null || !stats.isFile()) return null;
  let text = "";
  try {
    const handle = await open(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(HEAD_BYTES, stats.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  const head: TranscriptHead = { cwd: null, version: null, timestamp: null };
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(record)) continue;
    if (head.cwd === null && typeof record["cwd"] === "string") head.cwd = record["cwd"];
    if (head.version === null && typeof record["version"] === "string")
      head.version = record["version"];
    if (head.timestamp === null && typeof record["timestamp"] === "string")
      head.timestamp = record["timestamp"];
    if (head.cwd !== null && head.version !== null && head.timestamp !== null) break;
  }
  return head;
}

export interface SlugDir {
  dir: string;
  slug: string;
  transcripts: TranscriptFile[];
  memoryDir: string | null;
  /** Names directly under the slug dir other than transcripts, session dirs and `memory/`. */
  otherEntries: string[];
}

/** Lists every slug directory with its transcripts (stat only: no transcript is opened here). */
export async function readSlugDirs(projectsDir: string): Promise<SlugDir[]> {
  const entries = (await listDir(projectsDir)).filter((entry) => entry.isDirectory());
  const dirs = await Promise.all(
    entries.map(async (entry): Promise<SlugDir> => {
      const dir = join(projectsDir, entry.name);
      const children = await listDir(dir);
      const transcriptFiles = children.filter(
        (child) =>
          child.isFile() &&
          child.name.endsWith(".jsonl") &&
          SESSION_ID.test(basename(child.name, ".jsonl")),
      );
      const stats = await Promise.all(
        transcriptFiles.map(async (child): Promise<TranscriptFile | null> => {
          const path = join(dir, child.name);
          const fileStats = await lstatOrNull(path);
          if (fileStats === null) return null;
          return {
            path,
            slugDir: dir,
            slug: entry.name,
            sessionId: basename(child.name, ".jsonl"),
            mtimeMs: fileStats.mtimeMs,
          };
        }),
      );
      const transcripts = stats
        .filter((file): file is TranscriptFile => file !== null)
        .toSorted((a, b) => a.path.localeCompare(b.path));
      const sessionDirs = new Set(transcripts.map((file) => file.sessionId));
      const memoryDir = children.some((child) => child.isDirectory() && child.name === "memory")
        ? join(dir, "memory")
        : null;
      const otherEntries = children
        .filter((child) => !transcriptFiles.includes(child))
        .filter(
          (child) =>
            !(child.isDirectory() && (child.name === "memory" || sessionDirs.has(child.name))),
        )
        .map((child) => child.name)
        .toSorted();
      return { dir, slug: entry.name, transcripts, memoryDir, otherEntries };
    }),
  );
  return dirs.toSorted((a, b) => a.dir.localeCompare(b.dir));
}

export interface ToolUseOnPath {
  tool: string;
  path: string;
  timestamp: string | null;
}

function toolUsesOf(record: unknown): ToolUseOnPath[] {
  if (!isRecord(record) || record["type"] !== "assistant") return [];
  const message = record["message"];
  if (!isRecord(message) || !Array.isArray(message["content"])) return [];
  const timestamp = typeof record["timestamp"] === "string" ? record["timestamp"] : null;
  const out: ToolUseOnPath[] = [];
  for (const block of message["content"]) {
    if (!isRecord(block) || block["type"] !== "tool_use") continue;
    const name = block["name"];
    const input = block["input"];
    if (typeof name !== "string" || !isRecord(input)) continue;
    const filePath = input["file_path"];
    if (typeof filePath !== "string") continue;
    out.push({ tool: name, path: filePath, timestamp });
  }
  return out;
}

/**
 * Every `tool_use` with a `file_path` in a transcript (sub-agent lines included: they live in
 * the same file with `isSidechain: true`), streamed line by line.
 */
export async function scanToolUses(
  path: string,
  onUse: (use: ToolUseOnPath) => void,
): Promise<void> {
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });
  try {
    for await (const line of lines) {
      if (!line.includes('"tool_use"')) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      for (const use of toolUsesOf(record)) onUse(use);
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** Transcript files of a slug directory: `<id>.jsonl` plus `<id>/subagents/*.jsonl`. */
export async function transcriptFilesOf(slugDir: string): Promise<string[]> {
  const children = await listDir(slugDir);
  const files = children
    .filter(
      (child) =>
        child.isFile() &&
        child.name.endsWith(".jsonl") &&
        SESSION_ID.test(basename(child.name, ".jsonl")),
    )
    .map((child) => join(slugDir, child.name));
  const subagents = await Promise.all(
    files.map(async (file) => {
      const dir = join(slugDir, basename(file, ".jsonl"), "subagents");
      return (await listDir(dir))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => join(dir, entry.name));
    }),
  );
  return [...files, ...subagents.flat()].toSorted();
}
