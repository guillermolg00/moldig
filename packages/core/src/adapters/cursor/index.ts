/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * The Cursor adapter (research 02 §Cursor; tickets 06/07/08): one Harness for the IDE and
 * `cursor-agent`. `discover` resolves the three breadcrumb kinds — the `workspace.json` records of
 * the application-support directory, the path slugs of `~/.cursor/projects` and the leaves of
 * `~/.cursor/worktrees` — so Projects exist before git runs; `collect` emits the harness, its
 * breadcrumbs, entities and edges.
 *
 * Read-only, and narrower than that: no binary is ever run (`version` stays `null`, `presence`
 * comes from what is on disk — D70), no database is ever opened (`state.vscdb`, its backup and the
 * per-workspace copies are sized and listed, never queried — ticket 06 §1, D104) and no credential
 * store is read. Memory is server-side for Cursor: no memory unit, no read signal (research 10 §2.4).
 * On a machine with no trace of Cursor the adapter emits nothing at all — not even a Harness row
 * (D147).
 */
import { join } from "node:path";
import type { Harness } from "../../index/types.js";
import { warning, type ScanContext } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isDirectory, isFile } from "../../scan/fs.js";
import { modelFamilyOf } from "../../tokens/tokenizer.js";
import type { Adapter, AdapterOutput } from "../adapter.js";
import {
  collectBreadcrumbs,
  hasHarnessState,
  readWorkspaceRecords,
  readWorktreeLeaves,
  resolveSlugs,
} from "./breadcrumbs.js";
import { collectCache } from "./cache.js";
import { collectProjectContextFiles, collectUserContextFiles } from "./context-files.js";
import { collectMcp } from "./mcp.js";
import { HARNESS, HARNESS_ID, type CursorScan } from "./model.js";
import { cursorPaths, type CursorPaths } from "./paths.js";
import { effectiveSettings, readSettingsLayer, worktreeMaxCount } from "./settings.js";
import { collectSettingsFiles } from "./settings-files.js";
import { collectProjectSkills, collectUserSkills } from "./skills.js";

function harnessOf(scan: CursorScan, paths: CursorPaths, presence: Harness["presence"]): Harness {
  const model = scan.cliConfig["model"];
  const effectiveModel = typeof model === "string" ? model : null;
  const stray = scan.breadcrumbs
    .filter((crumb) => crumb.project === null && crumb.strayReason !== null)
    .map((crumb) => crumb.id);
  return {
    id: HARNESS_ID,
    harness: HARNESS,
    displayName: "Cursor",
    surfaces: ["ide", "cli"],
    presence,
    // Cursor writes no version to disk (research 10: no app bundle was even found) and moldig
    // never runs a binary.
    version: null,
    effectiveModel,
    modelFamily: modelFamilyOf(effectiveModel),
    contextWindowTokens: null,
    capabilities: {
      // Cursor's Memories are server-side: no file, no read signal, no shadow-memory finding.
      memoryLocation: "server-side",
      memoryReadSignal: "not-applicable",
      contextFileNames: ["AGENTS.md", "CLAUDE.md", ".cursorrules"],
      // Only a worktree count cap is documented, and that is not an age sweep (research 10 §5).
      sweepDocumented: false,
    },
    caps: {
      // Nothing documented: "keep rules under 500 lines" is advice, not a cap (research 05).
      memoryIndexLines: null,
      memoryIndexBytes: null,
      chainMaxBytes: null,
      skillDescriptionChars: null,
      importDepth: null,
    },
    effectiveSettings: scan.harnessSettings,
    breadcrumbSources: [
      { kind: "workspace-record", path: paths.workspaceStorage, readInV1: true },
      { kind: "slug-directory", path: paths.projectsDir, readInV1: true },
      { kind: "worktree-directory", path: paths.worktreesDir, readInV1: true },
      // The `history.recentlyOpenedPathsList` row: a breadcrumb source moldig names and never
      // opens (ticket 06 §1 — the database is off limits, D29 keeps the kind).
      {
        kind: "workspace-record",
        path: join(paths.globalStorage, "state.vscdb"),
        readInV1: false,
      },
    ],
    userScope: {
      paths: paths.userScope,
      stray,
      baseline: { items: [], tokens: 0 },
    },
  };
}

/**
 * D70: `installed` when Cursor wrote state of its own (workspace storage, a database, project
 * slugs, worktrees); `config-only` when only configuration exists; `absent` when nothing does —
 * and D147 makes `absent` the answer that emits nothing at all. No binary is run and no PATH is
 * searched. The trace this looks for is a Project **member's** own `.cursor` / `.cursorrules`: a
 * `.cursor/rules` nested inside a monorepo package is not read in v1 (research 02 Open 6) and is
 * not a trace either, which is what keeps the `shared/root-tree` case free of a Cursor row.
 */
async function presenceOf(scan: CursorScan, paths: CursorPaths): Promise<Harness["presence"]> {
  if (await hasHarnessState(paths)) return "installed";
  if (await isDirectory(paths.configDir)) return "config-only";
  for (const project of scan.ctx.discovery.projects()) {
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      if (await isDirectory(join(member.path, ".cursor"))) return "config-only";
      if (await isFile(join(member.path, ".cursorrules"))) return "config-only";
    }
  }
  return "absent";
}

/**
 * Ticket 07 §7: Cursor keeps workspace trust in `state.vscdb` (never opened) and models no
 * project-layer settings, so every Project it touched carries the same empty facts — the row is
 * what says "Cursor knows this Project".
 */
function projectFactsOf(scan: CursorScan, projects: readonly DiscoveredProject[]): void {
  for (const project of projects) {
    const touched =
      scan.breadcrumbs.some((crumb) => crumb.project === project.id) ||
      [...scan.entities.values()].some((entity) => entity.project === project.id);
    if (!touched) continue;
    scan.projectFacts.set(project.id, { trusted: null, effectiveSettings: {} });
  }
}

export function createCursorAdapter(): Adapter {
  let scan: CursorScan | null = null;

  return {
    id: HARNESS,

    async discover(ctx: ScanContext): Promise<void> {
      const paths = cursorPaths(ctx);
      const cliConfig = await readSettingsLayer(join(paths.configDir, "cli-config.json"));
      if (cliConfig.parseError) {
        ctx.warn(
          warning(
            "parse-error",
            "cli-config.json is not valid JSON",
            HARNESS,
            cliConfig.path,
            "partial",
          ),
        );
      }
      const ideSettings = await readSettingsLayer(join(paths.userDir, "settings.json"), true);
      if (ideSettings.parseError) {
        ctx.warn(
          warning(
            "parse-error",
            "User/settings.json is not valid JSONC",
            HARNESS,
            ideSettings.path,
            "partial",
          ),
        );
      }
      const records = await readWorkspaceRecords(ctx, paths);
      scan = {
        ctx,
        paths,
        records,
        slugs: await resolveSlugs(ctx, paths, records),
        worktrees: await readWorktreeLeaves(ctx, paths),
        cliConfig: cliConfig.data,
        ideSettings: ideSettings.data,
        harnessSettings: effectiveSettings(cliConfig.data, ideSettings.data),
        retention: worktreeMaxCount(ideSettings.data),
        entities: new Map(),
        edges: new Map(),
        breadcrumbs: [],
        projectFacts: new Map(),
        orders: new Map(),
      };
    },

    async collect(ctx: ScanContext): Promise<AdapterOutput> {
      if (scan === null) throw new Error("discover() must run before collect()");
      const projects = ctx.discovery.projects();
      const presence = await presenceOf(scan, scan.paths);
      if (presence === "absent") {
        // D147 (amends D77): a machine with two harnesses must not read as a machine with six.
        // With no trace of Cursor anywhere there is no Harness row, and `AGENTS.md` carries no
        // verdict for a harness no session can start. `presence: "absent"` stays unreachable.
        return {
          harness: null,
          breadcrumbs: [],
          entities: [],
          edges: [],
          projectFacts: new Map(),
        };
      }
      // Chain order per Project: the rules, the legacy file and the root context files, then the
      // skill, command and agent descriptions; the baseline follows the same sequence at user scope.
      await collectUserContextFiles(scan);
      for (const project of projects) await collectProjectContextFiles(scan, project);
      await collectUserSkills(scan);
      for (const project of projects) await collectProjectSkills(scan, project);
      await collectMcp(scan, projects);
      await collectSettingsFiles(scan, projects);
      // The cache units come before the breadcrumbs: a breadcrumb's `state[]` names them.
      await collectCache(scan);
      collectBreadcrumbs(scan);
      projectFactsOf(scan, projects);
      return {
        harness: harnessOf(scan, scan.paths, presence),
        breadcrumbs: scan.breadcrumbs,
        entities: [...scan.entities.values()],
        edges: [...scan.edges.values()],
        projectFacts: scan.projectFacts,
      };
    },
  };
}
