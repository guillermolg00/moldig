/* oxlint-disable no-await-in-loop -- sequential on purpose: the chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * The Codex adapter (research 02 §Codex, tickets 06/07/08/14): `discover` reads `config.toml` and
 * the `threads` index so every trust entry and every session working directory resolves to a
 * Project before git runs; `collect` emits the harness, its breadcrumbs, entities and edges.
 *
 * One Harness for the product family: the CLI and the desktop app share `$CODEX_HOME`, so
 * `surfaces` names both and the desktop's own files carry a `producer` instead of a second row.
 * Read-only throughout: no binary is run, no credential store is opened, no database is written,
 * and no `-wal`/`-shm` sidecar is ever created (D37).
 */
import { basename, join } from "node:path";
import type { ContextFile, DuplicatesEdge, Harness } from "../../index/types.js";
import { warning, type ScanContext } from "../../scan/context.js";
import {
  aggregateSessionCwds,
  type DiscoveredProject,
  type Located,
} from "../../scan/discovery.js";
import { isDirectory, isFile, listDir, statOrNull } from "../../scan/fs.js";
import { ancestors, edgeId, isUnder } from "../../scan/paths.js";
import { modelFamilyOf } from "../../tokens/tokenizer.js";
import type { Adapter, AdapterOutput } from "../adapter.js";
import { collectBreadcrumbs } from "./breadcrumbs.js";
import { collectCache } from "./cache.js";
import {
  collectProjectContextFiles,
  collectUserContextFiles,
  contentHashes,
  memberRelativePath,
} from "./context-files.js";
import { collectMcp } from "./mcp.js";
import { collectMemory } from "./memory.js";
import {
  addEdge,
  evidence,
  HARNESS,
  HARNESS_ID,
  trustOf,
  type CodexScan,
  type ProjectLayer,
  type TrustEntry,
} from "./model.js";
import { codexPaths } from "./paths.js";
import { collectSettingsFiles } from "./settings-files.js";
import { collectProjectSkills, collectUserSkills, skillDuplicates } from "./skills.js";
import {
  docMaxBytes,
  effectiveSettings,
  fallbackDocNames,
  rawSettings,
  rootMarkers,
  trustedFrom,
} from "./state.js";
import { readThreads, stampOf, versionOf, type ThreadRow } from "./threads.js";
import { readToml, stringAt, tablesOf, type TomlFile } from "./toml.js";

/** The `<name>.config.toml` files beside the user config; only the selected one merges (§1.1). */
async function readProfiles(dir: string): Promise<TomlFile[]> {
  const files: TomlFile[] = [];
  for (const entry of (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".config.toml")) continue;
    if (entry.name === "config.toml") continue;
    files.push(await readToml(join(dir, entry.name)));
  }
  return files;
}

/**
 * The `.codex/config.toml` layers a session in this Project loads: every directory from the
 * project root down to the session directory, closest last. `.codex` must be a directory, and a
 * `.codex` that *is* `$CODEX_HOME` is skipped exactly as Codex skips it.
 */
async function projectLayersOf(
  scan: CodexScan,
  project: DiscoveredProject,
  sessionDir: string,
  member: string,
): Promise<ProjectLayer[]> {
  const fold = scan.ctx.identity.fold;
  const markers = rootMarkers(scan.raw);
  const chain = ancestors(sessionDir).filter((dir) => isUnder(fold(dir), fold(member)));
  let root = member;
  for (const dir of chain) {
    const names = new Set((await listDir(dir)).map((entry) => entry.name));
    if (markers.some((marker) => names.has(marker))) {
      root = dir;
      break;
    }
  }
  const levels = ancestors(sessionDir)
    .filter((dir) => isUnder(fold(dir), fold(root)))
    .toReversed();
  const out: ProjectLayer[] = [];
  for (const [depth, dir] of levels.entries()) {
    const codexDir = join(dir, ".codex");
    // A `.codex` that *is* `$CODEX_HOME` is skipped, exactly as Codex skips it.
    if (fold(codexDir) === fold(scan.paths.dir)) continue;
    if (!(await isDirectory(codexDir))) continue;
    // Even without a `config.toml` the directory is a trace of Codex (D147): rules, hooks and
    // skills live there too.
    scan.projectDirs.push(codexDir);
    const file = await readToml(join(codexDir, "config.toml"));
    if (!file.present) continue;
    out.push({ dir, file, depth });
  }
  return out;
}

/** Context files with identical content: `duplicates` edges (never git's own copy in a worktree). */
function contextDuplicates(scan: CodexScan): void {
  const byHash = new Map<string, ContextFile[]>();
  for (const entity of scan.entities.values()) {
    if (entity.kind !== "context-file") continue;
    const hash = contentHashes.get(entity);
    if (hash === undefined) continue;
    byHash.set(hash, [...(byHash.get(hash) ?? []), entity]);
  }
  for (const [hash, group] of byHash) {
    const sorted = group.toSorted((a, b) => a.id.localeCompare(b.id));
    for (let i = 0; i < sorted.length; i += 1) {
      for (let j = i + 1; j < sorted.length; j += 1) {
        const from = sorted[i];
        const to = sorted[j];
        if (from === undefined || to === undefined) continue;
        if (
          from.project !== null &&
          from.project === to.project &&
          memberRelativePath(scan, from) === memberRelativePath(scan, to)
        )
          continue;
        const edge: DuplicatesEdge = {
          id: edgeId("duplicates", from.id, to.id),
          kind: "duplicates",
          from: from.id,
          to: to.id,
          confidence: "certain",
          evidence: [evidence("content-hash", `sha256 ${hash.slice(0, 12)}`)],
          same: "content",
        };
        addEdge(scan, edge);
      }
    }
  }
}

/**
 * D70: state only the binary writes → `installed`; configuration alone → `config-only`.
 *
 * D147 adds the third branch's consequence: `absent` means moldig found **no trace at all** of
 * Codex, and an adapter in that state emits nothing — no `Harness` row, no verdicts on shared
 * files such as `AGENTS.md`, no warnings. A machine with two harnesses installed must not read
 * as a machine with six, and an `AGENTS.md` must not carry a verdict for a harness no session
 * can start. Anything Codex left behind — `$CODEX_HOME` with a byte in it, a `.codex/` layer in
 * a Project — is `config-only` and is shown.
 */
async function presenceOf(scan: CodexScan): Promise<Harness["presence"]> {
  const { paths } = scan;
  const written = [
    paths.sessions,
    join(paths.dir, "history.jsonl"),
    join(paths.dir, "installation_id"),
    join(paths.dir, "version.json"),
  ];
  for (const path of written) if ((await statOrNull(path)) !== null) return "installed";
  for (const entry of await listDir(paths.sqliteHome)) {
    if (entry.isFile() && /^[A-Za-z0-9_]+_\d+\.sqlite$/.test(entry.name)) return "installed";
  }
  if ((await listDir(paths.dir)).length > 0) return "config-only";
  if (scan.projectDirs.length > 0) return "config-only";
  return "absent";
}

function harnessOf(scan: CodexScan, presence: Harness["presence"]): Harness {
  const { paths } = scan;
  const model = scan.settings["model"];
  const effectiveModel = typeof model === "string" ? model : null;
  const stray = scan.breadcrumbs
    .filter((crumb) => crumb.project === null && crumb.strayReason !== null)
    .map((crumb) => crumb.id);
  const userPaths = [...paths.scopePaths];
  if (paths.sqliteVia === "config") {
    userPaths.push({ path: paths.sqliteHome, role: "state", source: "default", envVar: null });
  }
  if (paths.logVia === "config") {
    userPaths.push({ path: paths.logDir, role: "data", source: "default", envVar: null });
  }
  return {
    id: HARNESS_ID,
    harness: HARNESS,
    displayName: "Codex",
    // One Harness per product family: the CLI and the desktop app share `~/.codex` (07 point 8).
    surfaces: ["cli", "desktop"],
    presence,
    version: scan.version,
    effectiveModel,
    modelFamily: modelFamilyOf(effectiveModel),
    // No shipped model catalogue for Codex: `pctOfContext` stays null with it (D86).
    contextWindowTokens: null,
    capabilities: {
      memoryLocation: "file",
      // Nothing on disk records that Codex read a memory file (research 06 rule 5).
      memoryReadSignal: "unchecked",
      contextFileNames: ["AGENTS.override.md", "AGENTS.md", ...fallbackDocNames(scan.raw)],
      // Codex documents no age-based deletion of its own state (ticket 08 §1).
      sweepDocumented: false,
    },
    caps: {
      memoryIndexLines: null,
      memoryIndexBytes: null,
      chainMaxBytes: docMaxBytes(scan.raw),
      // Codex's skill listing cap is a total for the whole list, not a per-description limit.
      skillDescriptionChars: null,
      // Codex has no `@import` syntax.
      importDepth: null,
    },
    effectiveSettings: scan.settings,
    breadcrumbSources: [
      { kind: "trust-entry", path: scan.config.path, readInV1: true },
      { kind: "session-cwd", path: scan.threadsFile, readInV1: true },
      { kind: "session-cwd", path: paths.sessions, readInV1: false },
      { kind: "workspace-record", path: paths.globalState, readInV1: false },
      { kind: "session-cwd", path: join(paths.dir, "sqlite", "codex-dev.db"), readInV1: false },
    ],
    userScope: { paths: userPaths, stray, baseline: { items: [], tokens: 0 } },
  };
}

export function createCodexAdapter(): Adapter {
  let scan: CodexScan | null = null;

  return {
    id: HARNESS,

    async discover(ctx: ScanContext) {
      const base = codexPaths(ctx);
      const config = await readToml(base.config);
      const profiles = await readProfiles(base.dir);
      const selected = stringAt(config.data, "profile");
      const profile =
        selected === null
          ? null
          : (profiles.find((file) => basename(file.path) === `${selected}.config.toml`) ?? null);
      const layers = profile === null ? [config] : [config, profile];
      const raw = rawSettings(layers);
      const paths = codexPaths(ctx, raw);
      const threadsFile = paths.join(paths.sqliteHome, "state_5.sqlite");

      // Trust entries: every `[projects."<path>"]` table of the layers read.
      const trust: TrustEntry[] = [];
      const seen = new Set<string>();
      for (const file of layers) {
        for (const [key, table] of tablesOf(file.data, "projects")) {
          if (seen.has(ctx.identity.fold(key))) continue;
          seen.add(ctx.identity.fold(key));
          const located = await ctx.discovery.locate(key, "breadcrumb");
          // Ticket 06 rule 7: a key naming a Project outside every Root leaves the scan with it.
          if (located.outsideRoots) continue;
          const level = typeof table["trust_level"] === "string" ? table["trust_level"] : null;
          trust.push({
            key,
            trustLevel: level,
            trusted: trustedFrom(level),
            file: file.path,
            located,
          });
        }
      }

      // Thread working directories, aggregated one per distinct path (D30).
      const threads =
        (await statOrNull(threadsFile)) === null
          ? { rows: [], projectRoots: [], readable: false }
          : await readThreads(threadsFile, ctx);
      const aggregated = aggregateSessionCwds<ThreadRow>(
        threads.rows.map((row) => ({
          path: row.cwd,
          first: stampOf(row.createdMs),
          last: stampOf(row.updatedMs ?? row.createdMs),
          source: row,
        })),
        ctx.identity.fold,
      );
      const cwds: { crumb: (typeof aggregated)[number]; located: Located }[] = [];
      for (const crumb of aggregated) {
        const located = await ctx.discovery.locate(crumb.path, "breadcrumb");
        if (!located.outsideRoots) cwds.push({ crumb, located });
      }
      const projectRoots: { path: string; located: Located }[] = [];
      for (const path of threads.projectRoots) {
        const located = await ctx.discovery.locate(path, "breadcrumb");
        if (!located.outsideRoots) projectRoots.push({ path, located });
      }

      scan = {
        ctx,
        paths,
        config,
        profile,
        profileFiles: profiles,
        raw,
        settings: effectiveSettings(layers),
        trust,
        threads: threads.rows,
        threadsFile,
        // A file that is simply not there is not an unreadable database: no warning either way.
        threadsReadable: threads.readable,
        cwds,
        projectRoots,
        version: versionOf(threads.rows),
        projectLayers: new Map(),
        projectDirs: [],
        rolloutUnits: new Map(),
        userDocBytes: 0,
        entities: new Map(),
        edges: new Map(),
        breadcrumbs: [],
        projectFacts: new Map(),
        orders: new Map(),
      };
    },

    async collect(ctx: ScanContext): Promise<AdapterOutput> {
      if (scan === null) throw new Error("discover() must run before collect()");
      const current = scan;
      const projects = ctx.discovery.projects();

      // The project layers first: trust and `project_doc_max_bytes` decide the chain and the
      // MCP verdicts that follow.
      for (const project of projects) {
        if (project.reachability !== "present") continue;
        const fold = ctx.identity.fold;
        const layers: ProjectLayer[] = [];
        for (const member of project.members) {
          if (member.reachability !== "present") continue;
          const sessionDir = isUnder(fold(ctx.options.cwd), fold(member.path))
            ? ctx.options.cwd
            : member.path;
          layers.push(...(await projectLayersOf(current, project, sessionDir, member.path)));
        }
        current.projectLayers.set(project.id, layers);
        // A Project Codex has never heard of gets no `perHarness.codex` row at all: facts are
        // filed only when a trust entry or a `.codex/` layer says something about it.
        const trusted = trustOf(current, project);
        if (trusted === null && layers.length === 0) continue;
        current.projectFacts.set(project.id, {
          trusted,
          effectiveSettings: effectiveSettings(layers.map((layer) => layer.file)),
        });
      }

      // D147: nothing of Codex on this machine — no Harness row, no verdicts, no warnings.
      const presence = await presenceOf(current);
      if (presence === "absent") {
        return {
          harness: null,
          breadcrumbs: [],
          entities: [],
          edges: [],
          projectFacts: new Map(),
        };
      }

      if (current.config.parseError) {
        ctx.warn(
          warning(
            "parse-error",
            "config.toml is not valid TOML: its trust entries and MCP servers are skipped",
            HARNESS,
            current.config.path,
            "partial",
          ),
        );
      }

      // Chain order per Project: the instruction files, then the memory unit, then the skill
      // descriptions; the baseline follows the same sequence at user scope.
      await collectUserContextFiles(current);
      for (const project of projects) await collectProjectContextFiles(current, project);
      await collectMemory(current);
      // Discovery order: the project generations reach a skill before the user ones (§1.5).
      for (const project of projects) await collectProjectSkills(current, project);
      await collectUserSkills(current);
      await collectMcp(current, projects);
      await collectSettingsFiles(current, projects);
      await collectCache(current);
      contextDuplicates(current);
      skillDuplicates(current);
      collectBreadcrumbs(current);

      return {
        harness: harnessOf(current, presence),
        breadcrumbs: current.breadcrumbs,
        entities: [...current.entities.values()],
        edges: [...current.edges.values()],
        projectFacts: current.projectFacts,
      };
    },
  };
}

/** Whether `$CODEX_HOME` holds anything at all — used by the presence check and by tests. */
export async function codexHomeExists(paths: { dir: string }): Promise<boolean> {
  return (await isDirectory(paths.dir)) || (await isFile(paths.dir));
}
