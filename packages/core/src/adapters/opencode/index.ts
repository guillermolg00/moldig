/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * The OpenCode adapter (research 02 §OpenCode, tickets 06/07/08): resolves the harness's
 * breadcrumbs — the `project` rows of `opencode.db` and the legacy `storage/project/*.json`
 * records — in `discover`, then emits the harness, its entities and edges in `collect`.
 * Read-only: `opencode.db` opens `?immutable=1` (D37), no binary is ever run and no credential
 * store is ever opened (D65).
 */
import { join } from "node:path";
import type { Harness } from "../../index/types.js";
import { warning, type ScanContext } from "../../scan/context.js";
import type { DiscoveredProject, Located } from "../../scan/discovery.js";
import { isDirectory, isFile } from "../../scan/fs.js";
import { modelFamilyOf } from "../../tokens/tokenizer.js";
import type { Adapter, AdapterOutput } from "../adapter.js";
import { collectBreadcrumbs } from "./breadcrumbs.js";
import { collectCache } from "./cache.js";
import {
  collectInstructions,
  collectProjectContextFiles,
  collectUserContextFiles,
} from "./context-files.js";
import { effectiveConfig, findConfigIn, readConfigFile, type ConfigFile } from "./config.js";
import { readDatabase, versionOf } from "./db.js";
import { readLegacyProjects } from "./legacy.js";
import { collectMcp, type McpLayer } from "./mcp.js";
import type { OpenCodeScan } from "./model.js";
import { HARNESS_ID, openCodePaths, type OpenCodePaths } from "./paths.js";
import { collectSettingsFiles } from "./settings-files.js";
import {
  collectProjectSkills,
  collectUserSkills,
  readLocks,
  shadowByName,
  skillDuplicates,
} from "./skills.js";

/** §0: state only the binary writes → installed; configuration alone → config-only. */
async function presenceOf(paths: OpenCodePaths): Promise<Harness["presence"]> {
  const installed =
    (await isFile(paths.database)) ||
    (await isDirectory(paths.storageDir)) ||
    (await isDirectory(paths.cacheDir));
  if (installed) return "installed";
  const configured =
    (await isDirectory(paths.configDir)) ||
    (paths.extraConfig !== null && (await isFile(paths.extraConfig)));
  return configured ? "config-only" : "absent";
}

function harnessOf(scan: OpenCodeScan, presence: Harness["presence"]): Harness {
  const model = scan.harnessSettings["model"];
  const effectiveModel = typeof model === "string" ? model : null;
  const stray = scan.breadcrumbs
    .filter((crumb) => crumb.project === null && crumb.strayReason !== null)
    .map((crumb) => crumb.id);
  return {
    id: HARNESS_ID,
    harness: "opencode",
    displayName: "OpenCode",
    surfaces: ["cli"],
    presence,
    version: scan.version,
    effectiveModel,
    // `<provider>/<model>`: the family comes from the part after the first slash.
    modelFamily: modelFamilyOf(
      effectiveModel === null
        ? null
        : effectiveModel.split("/").slice(1).join("/") || effectiveModel,
    ),
    contextWindowTokens: null,
    capabilities: {
      memoryLocation: "none",
      memoryReadSignal: "not-applicable",
      contextFileNames: ["AGENTS.md", "CLAUDE.md"],
      sweepDocumented: false,
    },
    caps: {
      memoryIndexLines: null,
      memoryIndexBytes: null,
      chainMaxBytes: null,
      skillDescriptionChars: null,
      importDepth: null,
    },
    effectiveSettings: scan.harnessSettings,
    breadcrumbSources: [
      { kind: "project-row", path: scan.database.path, readInV1: true },
      {
        kind: "legacy-project-record",
        path: join(scan.paths.storageDir, "project"),
        readInV1: true,
      },
      { kind: "workspace-record", path: scan.database.path, readInV1: false },
      { kind: "session-cwd", path: scan.database.path, readInV1: false },
    ],
    userScope: { paths: scan.paths.userScope, stray, baseline: { items: [], tokens: 0 } },
  };
}

/** The project layers of one Project: `<member>/opencode.json[c]`, one per present member. */
async function projectLayersOf(project: DiscoveredProject): Promise<ConfigFile[]> {
  const layers: ConfigFile[] = [];
  if (project.reachability !== "present") return layers;
  for (const member of project.members) {
    if (member.reachability !== "present") continue;
    const path = await findConfigIn(member.path);
    if (path === null) continue;
    layers.push(await readConfigFile(path, "project", project));
  }
  return layers;
}

const EMPTY_OUTPUT: AdapterOutput = {
  harness: null,
  breadcrumbs: [],
  entities: [],
  edges: [],
  projectFacts: new Map(),
};

export function createOpenCodeAdapter(): Adapter {
  let scan: OpenCodeScan | null = null;
  let presence: Harness["presence"] = "absent";

  return {
    id: "opencode",

    async discover(ctx: ScanContext) {
      const paths = openCodePaths(ctx);
      presence = await presenceOf(paths);
      // D61/D110: the inline configuration is never parsed, and the variable is not an override
      // moldig honoured, so it never reaches `scan.env` — the warning is the whole treatment.
      if ((ctx.options.env["OPENCODE_CONFIG_CONTENT"] ?? "") !== "") {
        ctx.warn(
          warning(
            "unsupported-shape",
            "OPENCODE_CONFIG_CONTENT holds inline configuration: not read",
            "opencode",
            null,
            "partial",
          ),
        );
      }
      if (presence === "absent") return;
      const layers: ConfigFile[] = [];
      const userConfig = await findConfigIn(paths.configDir);
      if (userConfig !== null) layers.push(await readConfigFile(userConfig, "user", null));
      if (paths.extraConfig !== null) {
        layers.push(await readConfigFile(paths.extraConfig, "user", null));
      }
      const database = await readDatabase(paths.database, ctx);
      const legacy = await readLegacyProjects(paths.storageDir);
      const rowLocated = new Map<string, Located>();
      for (const row of database.projects) {
        if (rowLocated.has(row.worktree)) continue;
        rowLocated.set(row.worktree, await ctx.discovery.locate(row.worktree, "breadcrumb"));
      }
      const legacyLocated = new Map<string, Located>();
      for (const record of legacy) {
        legacyLocated.set(record.path, await ctx.discovery.locate(record.worktree, "breadcrumb"));
      }
      scan = {
        ctx,
        paths,
        layers,
        harnessSettings: effectiveConfig(layers),
        projectLayers: new Map(),
        database,
        legacy,
        rowLocated,
        legacyLocated,
        version: versionOf(database),
        sessionUnits: new Map(),
        storageUnit: null,
        locks: [],
        ownedSkillDirs: [paths.configDir],
        entities: new Map(),
        edges: new Map(),
        breadcrumbs: [],
        projectFacts: new Map(),
        orders: new Map(),
      };
    },

    async collect(ctx: ScanContext): Promise<AdapterOutput> {
      // An adapter that found no trace of its harness emits nothing at all: no harness row, no
      // verdicts on files it would never read, and therefore no effect on any other adapter's
      // output. D77's "verdicts for every harness, absent included" applies once OpenCode has
      // left something on disk.
      if (scan === null || presence === "absent") return EMPTY_OUTPUT;
      const state = scan;
      const projects = ctx.discovery.projects();
      for (const project of projects) {
        const layers = await projectLayersOf(project);
        state.projectLayers.set(project.id, layers);
        if (project.reachability !== "present") continue;
        state.projectFacts.set(project.id, {
          // OpenCode has no trust model on disk (§2.3).
          trusted: null,
          effectiveSettings: effectiveConfig(layers),
        });
        for (const member of project.members) {
          if (member.reachability === "present")
            state.ownedSkillDirs.push(join(member.path, ".opencode"));
        }
      }

      // Chain order: the rules files first, then `instructions[]`, then the skill descriptions.
      await collectUserContextFiles(state);
      for (const layer of state.layers) {
        if (layer.present && !layer.parseError) await collectInstructions(state, layer, null);
      }
      for (const project of projects) {
        await collectProjectContextFiles(state, project);
        for (const layer of state.projectLayers.get(project.id) ?? []) {
          if (layer.present && !layer.parseError) await collectInstructions(state, layer, project);
        }
      }
      await readLocks(state);
      await collectUserSkills(state);
      for (const project of projects) await collectProjectSkills(state, project);
      skillDuplicates(state);
      shadowByName(state);

      const mcpLayers: McpLayer[] = state.layers.map((layer, index) => ({
        layer,
        project: null,
        // The user file is rank 1; `$OPENCODE_CONFIG`, read after it, rank 2.
        rank: index === 0 ? 1 : 2,
      }));
      for (const project of projects) {
        for (const layer of state.projectLayers.get(project.id) ?? []) {
          mcpLayers.push({ layer, project, rank: 3 });
        }
      }
      await collectMcp(state, mcpLayers);
      await collectSettingsFiles(state, projects);
      await collectCache(state);
      collectBreadcrumbs(state);

      return {
        harness: harnessOf(state, presence),
        breadcrumbs: state.breadcrumbs,
        entities: [...state.entities.values()],
        edges: [...state.edges.values()],
        projectFacts: state.projectFacts,
      };
    },
  };
}
