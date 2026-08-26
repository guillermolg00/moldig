/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * The Gemini CLI adapter (research 02 Gemini, tickets 06/07/08): resolves the harness's
 * breadcrumbs to Projects in `discover`, then emits the harness, its breadcrumbs, entities and
 * edges in `collect`. Read-only (ADR-0001): no binary is ever run, no credential store is ever
 * opened (D65) and no transcript is ever decoded. D147: when the machine carries no trace of
 * Gemini CLI at all, the adapter emits nothing — not even a Harness row.
 */
import { join } from "node:path";
import type { Harness } from "../../index/types.js";
import { warning, type ScanContext } from "../../scan/context.js";
import type { DiscoveredProject, Located } from "../../scan/discovery.js";
import { isDirectory, isFile } from "../../scan/fs.js";
import { modelFamilyOf } from "../../tokens/tokenizer.js";
import type { Adapter, AdapterOutput } from "../adapter.js";
import {
  collectBreadcrumbs,
  readProjectsFile,
  readSlugDirs,
  readTrustFile,
  resolveSlugs,
  trustedOf,
} from "./breadcrumbs.js";
import { collectCache } from "./cache.js";
import { collectProjectContextFiles, collectUserContextFiles } from "./context-files.js";
import { collectMcp } from "./mcp.js";
import { collectMemory } from "./memory.js";
import {
  HARNESS,
  HARNESS_ID,
  trustOf,
  type GeminiScan,
  type ProjectsEntry,
  type TrustEntry,
} from "./model.js";
import { geminiPaths, type GeminiPaths } from "./paths.js";
import { collectPlugins } from "./plugins.js";
import {
  contextFileNames,
  mergeLayers,
  nested,
  readLayer,
  redactSettings,
  retentionOf,
  type Layer,
} from "./settings.js";
import { collectSettingsFiles } from "./settings-files.js";
import { collectSkills } from "./skills.js";

export { geminiFindings } from "./findings.js";

function warnParse(ctx: ScanContext, layer: Layer, what: string): void {
  if (!layer.parseError) return;
  ctx.warn(warning("parse-error", `${what} is not valid JSON`, HARNESS, layer.path, "partial"));
}

/**
 * The Project's merged layers. D72: an untrusted folder's own `settings.json` is the one thing
 * the harness ignores — the file is still listed, its layer just never lands here.
 */
async function projectFactsOf(scan: GeminiScan, project: DiscoveredProject): Promise<void> {
  const trusted = trustOf(scan, project);
  const layers: Layer[] = [];
  if (project.reachability === "present" && trusted !== false) {
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      const layer = await readLayer(join(member.path, ".gemini", "settings.json"));
      warnParse(scan.ctx, layer, "settings.json");
      if (layer.present) layers.push(layer);
    }
  }
  const merged = mergeLayers([
    scan.systemDefaults,
    scan.userSettings,
    ...layers,
    scan.systemSettings,
  ]);
  scan.projectSettings.set(project.id, merged);
  scan.projectFacts.set(project.id, {
    trusted,
    effectiveSettings: redactSettings(merged),
  });
}

async function harnessOf(scan: GeminiScan, presence: Harness["presence"]): Promise<Harness> {
  const model = nested(scan.harnessSettings, "model", "name");
  const effectiveModel = typeof model === "string" ? model : null;
  const stray = scan.breadcrumbs
    .filter((crumb) => crumb.project === null && crumb.strayReason !== null)
    .map((crumb) => crumb.id);
  return {
    id: HARNESS_ID,
    harness: HARNESS,
    displayName: "Gemini CLI",
    surfaces: ["cli"],
    presence,
    // Gemini writes no version to disk and binaries are never run (07 point 8).
    version: null,
    effectiveModel,
    modelFamily: modelFamilyOf(effectiveModel),
    contextWindowTokens: null,
    capabilities: {
      memoryLocation: "file",
      // Gemini chats are never analysed (research 06 rule 5), so the read signal is unchecked.
      memoryReadSignal: "unchecked",
      contextFileNames: contextFileNames(scan.harnessSettings).names,
      // CLI ≥ 0.10 documents the session sweep (research 10 §1.1); the version is not on disk.
      sweepDocumented: true,
    },
    caps: {
      memoryIndexLines: null,
      memoryIndexBytes: null,
      chainMaxBytes: null,
      skillDescriptionChars: null,
      importDepth: 5,
    },
    effectiveSettings: redactSettings(scan.harnessSettings),
    breadcrumbSources: [
      { kind: "projects-entry", path: scan.projectsFile.path, readInV1: true },
      { kind: "trust-entry", path: scan.trustFile.path, readInV1: true },
      { kind: "slug-directory", path: scan.paths.tmpDir, readInV1: true },
      { kind: "slug-directory", path: scan.paths.historyDir, readInV1: true },
    ],
    userScope: {
      paths: scan.paths.userScope,
      stray,
      baseline: { items: [], tokens: 0 },
    },
  };
}

/**
 * D147: a machine with no `~/.gemini` and no system settings file has never run Gemini CLI. The
 * adapter then emits nothing at all — no Harness row, no `loaded-by` verdict on a shared
 * `AGENTS.md`, no warnings — so a machine with two harnesses never reads as a machine with six.
 */
async function leftATrace(paths: GeminiPaths): Promise<boolean> {
  if (await isDirectory(paths.geminiDir)) return true;
  const [defaults, settings] = await Promise.all([
    isFile(paths.systemDefaults),
    isFile(paths.systemSettings),
  ]);
  return defaults || settings;
}

const NOTHING: AdapterOutput = {
  harness: null,
  breadcrumbs: [],
  entities: [],
  edges: [],
  projectFacts: new Map(),
};

export function createGeminiCliAdapter(): Adapter {
  let scan: GeminiScan | null = null;
  let discovered = false;

  return {
    id: HARNESS,

    async discover(ctx) {
      discovered = true;
      scan = null;
      const paths = geminiPaths(ctx);
      if (!(await leftATrace(paths))) return;
      const [systemDefaults, userSettings, systemSettings] = await Promise.all([
        readLayer(paths.systemDefaults),
        readLayer(join(paths.geminiDir, "settings.json")),
        readLayer(paths.systemSettings),
      ]);
      warnParse(ctx, systemDefaults, "system-defaults.json");
      warnParse(ctx, userSettings, "settings.json");
      warnParse(ctx, systemSettings, "settings.json");
      const harnessSettings = mergeLayers([systemDefaults, userSettings, systemSettings]);
      if (contextFileNames(harnessSettings).unsupported) {
        ctx.warn(
          warning(
            "unsupported-shape",
            "context.fileName is neither a string nor an array of strings",
            HARNESS,
            userSettings.path,
            "degraded",
          ),
        );
      }

      const projectsFile = await readProjectsFile(join(paths.geminiDir, "projects.json"));
      if (projectsFile.parseError) {
        ctx.warn(
          warning(
            "parse-error",
            "projects.json is not valid JSON: its breadcrumbs are skipped",
            HARNESS,
            projectsFile.path,
            "partial",
          ),
        );
      }
      const trustFile = await readTrustFile(join(paths.geminiDir, "trustedFolders.json"));
      if (trustFile.parseError) {
        ctx.warn(
          warning(
            "parse-error",
            "trustedFolders.json is not valid JSON: its breadcrumbs are skipped",
            HARNESS,
            trustFile.path,
            "partial",
          ),
        );
      }

      const projectEntries: ProjectsEntry[] = [];
      const keyLocated = new Map<string, Located>();
      const keyBySlug = new Map<string, string>();
      for (const entry of projectsFile.entries) {
        const located = await ctx.discovery.locate(entry.key, "breadcrumb");
        // Ticket 06 rule 7: a key naming a Project outside every Root leaves the scan with it.
        if (located.outsideRoots) continue;
        keyLocated.set(entry.key, located);
        if (entry.slug !== null && !keyBySlug.has(entry.slug)) keyBySlug.set(entry.slug, entry.key);
        projectEntries.push({ key: entry.key, slug: entry.slug, located });
        if (entry.slug === null) {
          ctx.warn(
            warning(
              "unsupported-shape",
              `projects.json entry ${entry.key} does not name a slug`,
              HARNESS,
              projectsFile.path,
              "degraded",
            ),
          );
        }
      }
      const trustEntries: TrustEntry[] = [];
      for (const entry of trustFile.entries) {
        const located = await ctx.discovery.locate(entry.key, "breadcrumb");
        if (located.outsideRoots) continue;
        const trusted = trustedOf(entry.value);
        if (trusted === null) {
          ctx.warn(
            warning(
              "unsupported-shape",
              `trustedFolders.json entry ${entry.key} has an unknown value`,
              HARNESS,
              trustFile.path,
              "degraded",
            ),
          );
        }
        trustEntries.push({ key: entry.key, value: entry.value, trusted, located });
      }

      const dirs = await readSlugDirs(paths.tmpDir, paths.historyDir, new Set(keyBySlug.keys()));
      const candidatePaths = [
        ...projectEntries.map((entry) => entry.key),
        ...trustEntries.map((entry) => entry.key),
        ...ctx.discovery.projects().flatMap((project) => project.members.map((m) => m.path)),
      ];
      const slugs = await resolveSlugs(dirs, {
        discovery: ctx.discovery,
        keyBySlug,
        keyLocated,
        candidatePaths,
        warn: (path, message) =>
          ctx.warn(warning("unsupported-shape", message, HARNESS, path, "degraded")),
      });

      scan = {
        ctx,
        paths,
        systemDefaults,
        userSettings,
        systemSettings,
        harnessSettings,
        projectSettings: new Map(),
        retention: retentionOf(harnessSettings),
        projectsFile: {
          path: projectsFile.path,
          present: projectsFile.present,
          entries: projectEntries,
        },
        trustFile: { path: trustFile.path, present: trustFile.present, entries: trustEntries },
        slugs,
        extensions: [],
        mcp: [],
        skills: [],
        entities: new Map(),
        edges: new Map(),
        breadcrumbs: [],
        projectFacts: new Map(),
        orders: new Map(),
      };
    },

    async collect(ctx): Promise<AdapterOutput> {
      if (!discovered) throw new Error("discover() must run before collect()");
      // D147: nothing on disk, nothing in the index.
      if (scan === null) return { ...NOTHING, projectFacts: new Map() };
      const projects = ctx.discovery.projects();
      for (const project of projects) await projectFactsOf(scan, project);

      // Chain order per Project: context files (imports inline), the memory index, then the skill
      // and command names; the baseline follows the same sequence at user scope.
      await collectUserContextFiles(scan);
      await collectPlugins(scan, projects);
      for (const project of projects) await collectProjectContextFiles(scan, project);
      await collectMemory(scan);
      await collectSkills(scan, projects);
      await collectMcp(scan, projects);
      await collectSettingsFiles(scan, projects);
      await collectCache(scan);
      collectBreadcrumbs(scan);

      // D70/D147: the harness writes `installation_id` and a scratch directory per Project it has
      // run in; configuration alone is `config-only`. `absent` is unreachable — an adapter with no
      // trace of its harness returned above.
      const installed =
        (await isFile(join(scan.paths.geminiDir, "installation_id"))) ||
        scan.slugs.some((slug) => slug.store === "tmp");
      const presence: Harness["presence"] = installed ? "installed" : "config-only";
      return {
        harness: await harnessOf(scan, presence),
        breadcrumbs: scan.breadcrumbs,
        entities: [...scan.entities.values()],
        edges: [...scan.edges.values()],
        projectFacts: scan.projectFacts,
      };
    },
  };
}
