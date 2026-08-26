/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * Auto-memory units (ticket 08 §2, research 01 §6, 06): `projects/<repo-slug>/memory/` holds
 * the index (`MEMORY.md`, first 200 lines / 25 KB injected in every session) and the topic
 * files (read on demand); `agent-memory/<agent>/` at user, project or local scope is its own
 * unit. Nothing here opens a transcript: the exact never-read signal is `audit`'s step
 * (`read-signal.ts`), never `scan`'s (ticket 07/08) — every file leaves here `not-computed`.
 */
import { basename, join } from "node:path";
import type { ListsEdge, MemoryFile } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isRecord, listDir, readText } from "../../scan/fs.js";
import {
  capPortion,
  findIndexLinks,
  parseFrontmatter,
  stripBlockComments,
} from "../../scan/markdown.js";
import { edgeId, isUnder } from "../../scan/paths.js";
import { addEdge, addEntity, baseEntity, evidence, loadedBy, type ClaudeScan } from "./model.js";

const INDEX_LINES = 200;
const INDEX_BYTES = 25_600;

interface UnitInput {
  dir: string;
  project: DiscoveredProject | null;
  scope: MemoryFile["scope"];
  owner: MemoryFile["owner"];
  /** How the index enters a session, for the loaded-by edge. */
  load: {
    project: string | null;
    mode: "full" | "on-demand" | "never" | "disabled";
    reason: string;
    counts: boolean;
  };
}

/**
 * The index's verdict per D6/D41: a unit behind a gone Project can never be loaded (no session
 * can start there); a unit behind a bare directory or an unresolved slug is loaded, but by
 * sessions that belong to no Project, so it never enters the Headline number; `autoMemoryEnabled:
 * false` in the user or the Project's layers turns the injection off altogether.
 */
function indexVerdict(
  scan: ClaudeScan,
  project: DiscoveredProject | null,
  located: { strayReason: string | null; path: string } | null,
  resolution: string,
): UnitInput["load"] {
  const projectId = project?.id ?? null;
  const settings =
    project === null
      ? scan.harnessSettings
      : (scan.projectFacts.get(project.id)?.effectiveSettings ?? scan.harnessSettings);
  if (
    settings["autoMemoryEnabled"] === false ||
    scan.harnessSettings["autoMemoryEnabled"] === false
  )
    return {
      project: projectId,
      mode: "disabled",
      reason: "autoMemoryEnabled: false",
      counts: false,
    };
  if (project !== null && project.reachability !== "present") {
    return {
      project: projectId,
      mode: "never",
      reason: "directory gone: no session can start there",
      counts: false,
    };
  }
  if (project !== null) {
    return {
      project: projectId,
      mode: "full",
      reason: "auto-memory index: injected at session start, min(200 lines, 25 KB)",
      counts: true,
    };
  }
  return {
    project: null,
    mode: "full",
    reason:
      resolution === "unresolved" || located === null
        ? "loaded only by sessions started in the directory this slug names, which moldig could not resolve"
        : `loaded only by sessions started in ${located.path}, which is not a Project`,
    counts: false,
  };
}

/** Fact frontmatter in the flat and nested shapes, no key required (ticket 08 §2). */
function factFrontmatter(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  const metadata = data["metadata"];
  if (isRecord(metadata)) {
    for (const key of ["type", "modified", "node_type", "originSessionId"]) {
      if (out[key] === undefined && metadata[key] !== undefined) out[key] = metadata[key];
    }
  }
  const type = out["type"];
  if (typeof type === "string" && !["user", "feedback", "project", "reference"].includes(type)) {
    out["type"] = "other";
  }
  return out;
}

export async function collectMemory(
  scan: ClaudeScan,
  projects: DiscoveredProject[],
): Promise<void> {
  const units: UnitInput[] = [];
  for (const { slug, located, resolution } of scan.slugs) {
    if (slug.memoryDir === null) continue;
    const project = located?.project ?? null;
    const stray = located !== null && located.strayReason !== null;
    units.push({
      dir: slug.memoryDir,
      project,
      scope: "user",
      owner: stray && located.strayReason === "bare-directory" ? "global" : "project",
      load: indexVerdict(scan, project, located, resolution),
    });
  }
  const userAgents = join(scan.paths.configDir, "agent-memory");
  for (const entry of await listDir(userAgents)) {
    if (!entry.isDirectory()) continue;
    units.push({
      dir: join(userAgents, entry.name),
      project: null,
      scope: "user",
      owner: `agent:${entry.name}`,
      load: {
        project: null,
        mode: "on-demand",
        reason: `loaded into the ${entry.name} subagent's system prompt when it spawns`,
        counts: false,
      },
    });
  }
  for (const project of projects) {
    if (project.reachability !== "present") continue;
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      for (const [dirName, scope] of [
        ["agent-memory", "project"],
        ["agent-memory-local", "local"],
      ] as const) {
        const base = join(member.path, ".claude", dirName);
        for (const entry of await listDir(base)) {
          if (!entry.isDirectory()) continue;
          units.push({
            dir: join(base, entry.name),
            project,
            scope,
            owner: `agent:${entry.name}`,
            load: {
              project: project.id,
              mode: "on-demand",
              reason: `loaded into the ${entry.name} subagent's system prompt when it spawns`,
              counts: false,
            },
          });
        }
      }
    }
  }

  for (const unit of units) await collectUnit(scan, unit);
}

async function collectUnit(scan: ClaudeScan, unit: UnitInput): Promise<void> {
  const fold = scan.ctx.identity.fold;
  const entries = (await listDir(unit.dir))
    .filter((entry) => entry.isFile())
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const files: MemoryFile[] = [];
  for (const entry of entries) {
    const path = join(unit.dir, entry.name);
    const text = await readText(path);
    if (text === null) continue;
    const role: MemoryFile["role"] =
      entry.name === "MEMORY.md" ? "index" : entry.name.endsWith(".md") ? "fact" : "other";
    const frontmatter = parseFrontmatter(text);
    const stripped = stripBlockComments(frontmatter.body);
    const portion = role === "index" ? capPortion(stripped, INDEX_LINES, INDEX_BYTES) : null;
    const base = baseEntity(scan, {
      kind: "memory-file",
      path,
      scope: unit.scope,
      project: unit.project,
      ownership: "harness",
      locator: { type: "file", path },
      format: entry.name.endsWith(".md") ? "md" : "other",
      label: entry.name,
      sensitive: false,
      protection: "none",
      removal: { method: "trash" },
      metrics: await scan.ctx.fileMetrics(path, text),
    });
    const entity: MemoryFile = {
      ...base,
      kind: "memory-file",
      role,
      unit: unit.dir,
      owner: unit.owner,
      frontmatter: role === "fact" ? factFrontmatter(frontmatter.data) : frontmatter.data,
      loadedPortion:
        portion === null
          ? null
          : {
              lines: portion.lines,
              bytes: portion.bytes,
              tokens: scan.ctx.tokenizer.count(portion.text).o200k,
              confidence: "certain",
            },
      reads: null,
      writes: null,
      neverRead: null,
      readSignal: { source: "not-computed", exact: false, bashParsed: false },
    };
    files.push(addEntity(scan, entity));
    if (role === "index" && portion !== null) {
      // A verdict of `never` or `disabled` means the harness sends nothing: the portion is still
      // measured (the row shows what it would cost) but the edge carries zero.
      const sent = unit.load.mode === "full" || unit.load.mode === "on-demand";
      loadedBy(scan, {
        from: entity.id,
        project: unit.load.project,
        mode: unit.load.mode,
        reason: unit.load.reason,
        placement: null,
        effectiveName: null,
        ordered: unit.load.counts,
        charsLoaded: sent ? portion.text.length : 0,
        importsResolved: null,
        tokensLoaded: sent ? (entity.loadedPortion?.tokens ?? null) : 0,
        disableModelInvocation: null,
        countsTowardHeadline: unit.load.counts,
        evidence: [
          evidence("loading-rule", "index injected at session start, min(200 lines, 25 KB)"),
        ],
      });
    } else {
      loadedBy(scan, {
        from: entity.id,
        project: unit.load.project,
        mode: "on-demand",
        reason: "topic file: read on demand, never at session start",
        placement: null,
        effectiveName: null,
        ordered: false,
        charsLoaded: stripped.length,
        importsResolved: null,
        tokensLoaded: entity.metrics.tokens?.o200k ?? null,
        disableModelInvocation: null,
        countsTowardHeadline: false,
        evidence: [evidence("loading-rule", "topic files are never loaded at startup")],
      });
    }
  }
  const index = files.find((file) => file.role === "index");
  if (index === undefined) return;
  const indexText = await readText(index.path);
  if (indexText === null) return;
  for (const link of findIndexLinks(indexText)) {
    const target = files.find(
      (file) => file.role !== "index" && basename(file.path) === basename(link.target),
    );
    if (target === undefined || !isUnder(fold(target.path), fold(unit.dir))) continue;
    const edge: ListsEdge = {
      id: edgeId("lists", index.id, target.id),
      kind: "lists",
      from: index.id,
      to: target.id,
      confidence: "certain",
      evidence: [evidence("index-line", `line ${link.line}: ${link.target}`)],
    };
    addEdge(scan, edge);
  }
}
