/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * The Claude Code adapter (research 01, tickets 06/07/08): resolves the harness's breadcrumbs
 * to Projects in `discover`, then emits the harness, its breadcrumbs, entities and edges in
 * `collect`. Read-only; never runs the harness; never opens credentials.
 */
import { join } from "node:path";
import type { ContextFile, DuplicatesEdge, Harness } from "../../index/types.js";
import { warning, type ScanContext } from "../../scan/context.js";
import type { DiscoveredProject, Located } from "../../scan/discovery.js";
import { isDirectory, isFile } from "../../scan/fs.js";
import { edgeId, isUnder, relativeUnder } from "../../scan/paths.js";
import { modelFamilyOf } from "../../tokens/tokenizer.js";
import type { Adapter, AdapterOutput } from "../adapter.js";
import { collectBreadcrumbs } from "./breadcrumbs.js";
import { collectCache } from "./cache.js";
import {
  collectProjectContextFiles,
  collectUserContextFiles,
  contentHashes,
} from "./context-files.js";
import { collectMemory } from "./memory.js";
import { collectMcp } from "./mcp.js";
import {
  addEdge,
  evidence,
  HARNESS_ID,
  projectsOf,
  type ClaudeScan,
  type SlugResolution,
} from "./model.js";
import { claudePaths, slugOf, type ClaudePaths } from "./paths.js";
import { collectSettingsFiles } from "./settings-files.js";
import { collectProjectSkills, collectUserSkills } from "./skills.js";
import {
  cleanupPeriodDays,
  effectiveSettings,
  readClaudeJson,
  readSettingsLayer,
  readUserSettings,
} from "./state.js";
import { readSlugDirs, readTranscriptHead, type SlugDir } from "./transcripts.js";

/**
 * Ticket 06 rule 6: slug → `projects` key → slug of a known Project member → the `cwd` of the
 * slug's own transcripts (heads read newest first, only for slugs the first two steps miss)
 * → stray "unresolved slug". Slugs naming a Project outside every Root are dropped (rule 7).
 */
async function resolveSlugs(
  ctx: ScanContext,
  slugs: SlugDir[],
  keyLocated: Map<string, Located>,
): Promise<SlugResolution[]> {
  const keysBySlug = new Map<string, string>();
  for (const key of keyLocated.keys()) keysBySlug.set(slugOf(key), key);
  const out: SlugResolution[] = [];
  for (const slug of slugs) {
    const key = keysBySlug.get(slug.slug);
    if (key !== undefined) {
      out.push({ slug, located: keyLocated.get(key) ?? null, resolution: "slug-by-key" });
      continue;
    }
    const known = ctx.discovery
      .projects()
      .flatMap((project) => project.members.map((member) => member.path))
      .find((path) => slugOf(path) === slug.slug);
    if (known !== undefined) {
      out.push({
        slug,
        located: await ctx.discovery.locate(known, "breadcrumb"),
        resolution: "slug-by-existence",
      });
      continue;
    }
    let located: Located | null = null;
    for (const file of slug.transcripts.toSorted((a, b) => b.mtimeMs - a.mtimeMs)) {
      const head = await readTranscriptHead(file.path);
      if (head === null || head.cwd === null || slugOf(head.cwd) !== slug.slug) continue;
      located = await ctx.discovery.locate(head.cwd, "breadcrumb");
      break;
    }
    out.push({
      slug,
      located,
      resolution: located === null ? "unresolved" : "slug-by-transcript-cwd",
    });
  }
  return out.filter(({ located }) => located?.outsideRoots !== true);
}

/** The newest transcript's `version` (research 01: the only place Claude Code writes it). */
async function versionOf(slugs: SlugDir[]): Promise<string | null> {
  const newest = slugs
    .flatMap((slug) => slug.transcripts)
    .toSorted((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path))[0];
  if (newest === undefined) return null;
  return (await readTranscriptHead(newest.path))?.version ?? null;
}

async function harnessOf(
  scan: ClaudeScan,
  paths: ClaudePaths,
  presence: Harness["presence"],
): Promise<Harness> {
  const model = scan.harnessSettings["model"];
  const effectiveModel = typeof model === "string" ? model : null;
  const stray = scan.breadcrumbs
    .filter((crumb) => crumb.project === null && crumb.strayReason !== null)
    .map((crumb) => crumb.id);
  return {
    id: HARNESS_ID,
    harness: "claude-code",
    displayName: "Claude Code",
    surfaces: ["cli"],
    presence,
    version: scan.version,
    effectiveModel,
    modelFamily: modelFamilyOf(effectiveModel),
    contextWindowTokens: null,
    capabilities: {
      memoryLocation: "file",
      memoryReadSignal: "exact",
      contextFileNames: ["CLAUDE.md", "CLAUDE.local.md"],
      sweepDocumented: true,
    },
    caps: {
      memoryIndexLines: 200,
      memoryIndexBytes: 25_600,
      chainMaxBytes: null,
      skillDescriptionChars: 1536,
      importDepth: 4,
    },
    effectiveSettings: scan.harnessSettings,
    breadcrumbSources: [
      { kind: "projects-entry", path: paths.claudeJson, readInV1: true },
      { kind: "slug-directory", path: paths.projectsDir, readInV1: true },
    ],
    userScope: {
      paths: [
        {
          path: paths.configDir,
          role: "data",
          source: paths.envVar === null ? "default" : "env",
          envVar: paths.envVar,
        },
        {
          path: paths.claudeJson,
          role: "state",
          source: paths.envVar === null ? "default" : "env",
          envVar: paths.envVar,
        },
      ],
      stray,
      baseline: { items: [], tokens: 0 },
    },
  };
}

/** The path of a context file relative to the Project member (repository or worktree) holding it. */
function memberRelativePath(scan: ClaudeScan, entity: ContextFile): string | null {
  const fold = scan.ctx.identity.fold;
  const project = projectsOf(scan).find((item) => item.id === entity.project);
  if (project === undefined) return null;
  const member = project.members.find((item) => isUnder(fold(entity.path), fold(item.path)));
  return member === undefined ? null : relativeUnder(entity.path, member.path);
}

/**
 * Context files with identical content: `duplicates` edges. The same tracked file checked out
 * in two members of one Project (a linked worktree's `CLAUDE.md`) is git's copy, not a
 * distinct one (ticket 07 Identity; CONTEXT.md Duplicate): never paired.
 */
function contextDuplicates(scan: ClaudeScan): void {
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

async function projectFactsOf(scan: ClaudeScan, project: DiscoveredProject): Promise<void> {
  const entry = scan.claudeJson.projects.find((item) => {
    const located = scan.keyLocated.get(item.key);
    return located?.project?.id === project.id && located.relativePath === null;
  });
  const layers =
    project.reachability === "present"
      ? await Promise.all([
          readSettingsLayer(join(project.path, ".claude", "settings.json")),
          readSettingsLayer(join(project.path, ".claude", "settings.local.json")),
        ])
      : [];
  for (const layer of layers) {
    if (layer.parseError) {
      scan.ctx.warn(
        warning(
          "parse-error",
          "settings file is not valid JSON",
          "claude-code",
          layer.path,
          "partial",
        ),
      );
    }
  }
  scan.projectFacts.set(project.id, {
    trusted: entry?.trusted ?? null,
    effectiveSettings: effectiveSettings(layers),
  });
}

export function createClaudeCodeAdapter(): Adapter {
  let scan: ClaudeScan | null = null;

  return {
    id: "claude-code",

    async discover(ctx) {
      const paths = claudePaths(ctx);
      const claudeJson = await readClaudeJson(paths.claudeJson);
      if (claudeJson.parseError) {
        ctx.warn(
          warning(
            "parse-error",
            ".claude.json is not valid JSON: its breadcrumbs and MCP servers are skipped",
            "claude-code",
            paths.claudeJson,
            "partial",
          ),
        );
      }
      const userSettings = await readUserSettings(paths.configDir);
      if (userSettings.user.parseError) {
        ctx.warn(
          warning(
            "parse-error",
            "settings.json is not valid JSON",
            "claude-code",
            userSettings.user.path,
            "partial",
          ),
        );
      }
      const harnessSettings = effectiveSettings([userSettings.user]);
      const keyLocated = new Map<string, Located>();
      for (const entry of claudeJson.projects) {
        const located = await ctx.discovery.locate(entry.key, "breadcrumb");
        if (!located.outsideRoots) keyLocated.set(entry.key, located);
      }
      // Ticket 06 rule 7: keys naming a Project outside every Root leave the scan with it.
      const projects = claudeJson.projects.filter((entry) => keyLocated.has(entry.key));
      const slugDirs = await readSlugDirs(paths.projectsDir);
      scan = {
        ctx,
        paths,
        claudeJson: { ...claudeJson, projects },
        userSettings,
        harnessSettings,
        retention: cleanupPeriodDays(harnessSettings),
        slugs: await resolveSlugs(ctx, slugDirs, keyLocated),
        keyLocated,
        version: await versionOf(slugDirs),
        entities: new Map(),
        edges: new Map(),
        breadcrumbs: [],
        projectFacts: new Map(),
        orders: new Map(),
      };
    },

    async collect(ctx): Promise<AdapterOutput> {
      if (scan === null) throw new Error("discover() must run before collect()");
      const projects = ctx.discovery.projects();
      for (const project of projects) await projectFactsOf(scan, project);

      // Chain order per Project: context files (imports inline), the memory index, then the
      // skill and agent descriptions; the baseline follows the same sequence at user scope.
      await collectUserContextFiles(scan);
      for (const project of projects) await collectProjectContextFiles(scan, project);
      await collectMemory(scan, projects);
      await collectUserSkills(scan);
      for (const project of projects) await collectProjectSkills(scan, project);
      await collectMcp(scan, projects);
      await collectSettingsFiles(scan, projects);
      await collectCache(scan, projects);
      contextDuplicates(scan);
      collectBreadcrumbs(scan);

      const hasVersion = scan.version !== null;
      const configured =
        (await isDirectory(scan.paths.configDir)) || (await isFile(scan.paths.claudeJson));
      const presence: Harness["presence"] = hasVersion
        ? "installed"
        : configured
          ? "config-only"
          : "absent";
      return {
        harness: await harnessOf(scan, scan.paths, presence),
        breadcrumbs: scan.breadcrumbs,
        entities: [...scan.entities.values()],
        edges: [...scan.edges.values()],
        projectFacts: scan.projectFacts,
      };
    },
  };
}
