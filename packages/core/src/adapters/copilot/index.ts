/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * The Copilot adapter (research 02 §Copilot; tickets 06/07/08): one Harness with two surfaces —
 * the Copilot CLI under `$COPILOT_HOME` (else `~/.copilot`) and VS Code under its user
 * directory. `discover` resolves the harness's three breadcrumb sources (trusted folders,
 * session working directories, VS Code workspace records) so Projects exist before git runs;
 * `collect` emits the harness, its breadcrumbs, entities and edges.
 *
 * Read-only, and deliberately incurious: databases (`session-store.db`, `state.vscdb`) are
 * stat'ed and never opened, credential stores (`mcp-oauth-config/`, `mcp-secrets/`) are never
 * read at all, transcripts (`events.jsonl`), checkpoints and plans inside a session are members
 * of its unit and never context files, and no binary is ever run. Memory is server-side, so
 * there is no memory unit and no read signal to compute.
 */
import { join } from "node:path";
import type { Harness } from "../../index/types.js";
import { warning, type ScanContext } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isDirectory, isFile, listDir } from "../../scan/fs.js";
import { modelFamilyOf } from "../../tokens/tokenizer.js";
import type { Adapter, AdapterOutput } from "../adapter.js";
import { collectBreadcrumbs } from "./breadcrumbs.js";
import { collectCache } from "./cache.js";
import {
  copilotKeysOf,
  mergeCopilotKeys,
  qualifiesAsCopilot,
  readCopilotConfig,
  readJsoncLayer,
} from "./config.js";
import { collectMemberContextFiles, collectUserContextFiles } from "./context-files.js";
import { collectMcp } from "./mcp.js";
import { HARNESS, HARNESS_ID, type CopilotScan, type MemberScope } from "./model.js";
import { copilotPaths, type CopilotPaths } from "./paths.js";
import { readSessions, readWorkspaces, workspacePathOf } from "./records.js";
import { collectSettingsFiles } from "./settings-files.js";
import { collectMemberSkills, collectUserSkills } from "./skills.js";

/** D70: the harness wrote state of its own → installed; only configuration → config-only. */
async function presenceOf(
  paths: CopilotPaths,
  members: readonly string[],
): Promise<Harness["presence"]> {
  const wrote = await Promise.all([
    listDir(paths.sessionState).then((entries) => entries.length > 0),
    listDir(paths.logs).then((entries) => entries.length > 0),
    isFile(paths.sessionStore),
    isFile(join(paths.cliHome, "command-history-state.json")),
    isDirectory(join(paths.globalStorage, "github.copilot-chat")),
  ]);
  if (wrote.includes(true)) return "installed";
  const configured = await Promise.all([
    isDirectory(paths.cliHome),
    isFile(join(paths.vscodeUser, "mcp.json")),
  ]);
  return configured.includes(true) || members.length > 0 ? "config-only" : "absent";
}

function harnessOf(scan: CopilotScan, presence: Harness["presence"]): Harness {
  const { paths } = scan;
  const stray = scan.breadcrumbs
    .filter((crumb) => crumb.project === null && crumb.strayReason !== null)
    .map((crumb) => crumb.id);
  return {
    id: HARNESS_ID,
    harness: HARNESS,
    displayName: "Copilot",
    surfaces: ["cli", "vscode"],
    presence,
    // Neither surface writes its version anywhere on disk, and no binary is ever run.
    version: null,
    effectiveModel: scan.config.model,
    modelFamily: modelFamilyOf(scan.config.model),
    contextWindowTokens: null,
    capabilities: {
      // Copilot Memory is repository-scoped and lives on github.com (research 10 §2.4).
      memoryLocation: "server-side",
      memoryReadSignal: "not-applicable",
      contextFileNames: ["copilot-instructions.md", "AGENTS.md", "CLAUDE.md", "GEMINI.md"],
      // The log prune of 1.0.55 publishes no number, so no sweep is documented (ticket 08).
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
      { kind: "trust-entry", path: scan.config.path, readInV1: true },
      { kind: "session-cwd", path: paths.sessionState, readInV1: true },
      { kind: "workspace-record", path: paths.workspaceStorage, readInV1: true },
      // D29: the recents and the trust model of VS Code's global state take the nearest kinds;
      // 06 §1 does not read `state.vscdb`, and `storage.json`'s path maps are not read either.
      {
        kind: "workspace-record",
        path: join(paths.globalStorage, "state.vscdb"),
        readInV1: false,
      },
      { kind: "trust-entry", path: join(paths.globalStorage, "state.vscdb"), readInV1: false },
      {
        kind: "workspace-record",
        path: join(paths.globalStorage, "storage.json"),
        readInV1: false,
      },
    ],
    userScope: { paths: paths.userScope, stray, baseline: { items: [], tokens: 0 } },
  };
}

/** The present members of a Project whose `.github/` or `.vscode/mcp.json` qualifies (06 §7). */
async function membersOf(
  scan: CopilotScan,
  projects: readonly DiscoveredProject[],
): Promise<MemberScope[]> {
  const out: MemberScope[] = [];
  for (const project of projects) {
    if (project.reachability !== "present") continue;
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      if (!(await qualifiesAsCopilot(member.path))) continue;
      const workspace = await readJsoncLayer(join(member.path, ".vscode", "settings.json"));
      if (workspace.parseError) {
        scan.ctx.warn(
          warning(
            "parse-error",
            ".vscode/settings.json is not valid JSONC",
            HARNESS,
            workspace.path,
            "partial",
          ),
        );
      }
      out.push({
        project,
        path: member.path,
        // The workspace layer wins per key over the user layer (VS Code's own rule).
        settings: mergeCopilotKeys([scan.vscodeUserSettings, workspace]),
        workspaceSettings: mergeCopilotKeys([workspace]),
      });
    }
  }
  return out;
}

/**
 * Trust and the project settings layer, for every Project this harness has an opinion about:
 * one named by a breadcrumb, or one whose member qualifies as Copilot's. `trusted` is `true`
 * for a Project a `trusted_folders[]` entry names, `false` for every other when `config.json`
 * was parsed, and `null` when it was absent or unparsable.
 */
async function collectProjectFacts(
  scan: CopilotScan,
  projects: readonly DiscoveredProject[],
  members: readonly MemberScope[],
): Promise<void> {
  const fold = scan.ctx.identity.fold;
  const trusted = new Set(scan.trust.map((entry) => fold(entry.located?.path ?? entry.raw)));
  const known = new Set<string>();
  for (const entry of scan.trust) if (entry.located?.project) known.add(entry.located.project.id);
  for (const session of scan.sessions) {
    if (session.located?.project) known.add(session.located.project.id);
  }
  for (const record of scan.workspaces) {
    if (record.located?.project) known.add(record.located.project.id);
  }
  for (const member of members) known.add(member.project.id);
  for (const project of projects) {
    if (!known.has(project.id)) continue;
    const paths = [project.path, ...project.members.map((member) => member.path)];
    const layers = members
      .filter((member) => member.project.id === project.id)
      .map((member) => member.workspaceSettings);
    const effectiveSettings: Record<string, unknown> = {};
    for (const layer of layers) {
      for (const [key, value] of Object.entries(layer)) effectiveSettings[key] = value;
    }
    scan.projectFacts.set(project.id, {
      trusted:
        scan.config.present && !scan.config.parseError
          ? paths.some((path) => trusted.has(fold(path)))
          : null,
      effectiveSettings,
    });
  }
}

export function createCopilotAdapter(): Adapter {
  let scan: CopilotScan | null = null;

  return {
    id: HARNESS,

    async discover(ctx: ScanContext) {
      const paths = copilotPaths(ctx);
      const config = await readCopilotConfig(join(paths.cliHome, "config.json"));
      if (config.parseError) {
        ctx.warn(
          warning(
            "parse-error",
            "config.json is not valid JSON: its trusted folders and model are skipped",
            HARNESS,
            config.path,
            "partial",
          ),
        );
      }
      const vscodeUserSettings = await readJsoncLayer(join(paths.vscodeUser, "settings.json"));
      if (vscodeUserSettings.parseError) {
        ctx.warn(
          warning(
            "parse-error",
            "settings.json is not valid JSONC",
            HARNESS,
            vscodeUserSettings.path,
            "partial",
          ),
        );
      }

      const trust = [];
      for (const raw of config.trustedFolders) {
        const located = await ctx.discovery.locate(raw, "breadcrumb");
        // Ticket 06 rule 7: a Project outside every Root leaves the scan with it.
        if (located.outsideRoots) continue;
        trust.push({ raw, located });
      }

      const sessions = [];
      for (const record of await readSessions(paths.sessionState, ctx)) {
        if (record.cwd === null) {
          sessions.push(record);
          continue;
        }
        // The git root is located first so the repository is registered before the cwd folds
        // into it; `git_root` is otherwise only corroboration (research 09 §2).
        if (record.gitRoot !== null) await ctx.discovery.locate(record.gitRoot, "breadcrumb");
        const located = await ctx.discovery.locate(record.cwd, "breadcrumb");
        if (located.outsideRoots) continue;
        sessions.push({ ...record, located });
      }

      const workspaces = [];
      for (const record of await readWorkspaces(paths.workspaceStorage, ctx)) {
        const path = workspacePathOf(record);
        if (path === null) {
          workspaces.push(record);
          continue;
        }
        const located = await ctx.discovery.locate(path, "breadcrumb");
        if (located.outsideRoots) continue;
        workspaces.push({ ...record, located });
      }

      scan = {
        ctx,
        paths,
        config,
        vscodeUserSettings,
        harnessSettings: { ...config.settings, ...copilotKeysOf(vscodeUserSettings) },
        trust,
        sessions,
        workspaces,
        qualified: new Set(),
        mcpEntries: new Map(),
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
      const members = await membersOf(scan, projects);
      for (const member of members) scan.qualified.add(ctx.identity.fold(member.path));
      const presence = await presenceOf(
        scan.paths,
        members.map((member) => member.path),
      );
      // A harness that left nothing on this machine contributes nothing at all — no row, no
      // baseline, and above all no Placement claiming that a store several harnesses share is
      // read by a Copilot that is not installed. `scan.env` still records `COPILOT_HOME` when
      // it was set, so what moldig honoured is on the record either way.
      if (presence === "absent") {
        return {
          harness: null,
          breadcrumbs: [],
          entities: [],
          edges: [],
          projectFacts: new Map(),
        };
      }
      await collectProjectFacts(scan, projects, members);

      // Chain order: the user-scope instructions first (the baseline every session pays), then
      // each Project's own instructions, its AGENTS.md chain and its skill descriptions.
      await collectUserContextFiles(scan);
      for (const member of members) await collectMemberContextFiles(scan, member);
      await collectUserSkills(scan);
      for (const member of members) await collectMemberSkills(scan, member);
      await collectMcp(scan, members);
      await collectSettingsFiles(scan, members);
      await collectCache(scan);
      collectBreadcrumbs(scan);

      // D33 lists VS Code Insiders beside VS Code; it is scanned only when it is there, so a
      // path moldig never reads is never presented as one it did.
      const insiders = await isDirectory(scan.paths.vscodeInsidersUser);
      const userScopePaths = scan.paths.userScope.filter(
        (item) => insiders || !item.path.includes("Code - Insiders"),
      );
      const harness = harnessOf(
        { ...scan, paths: { ...scan.paths, userScope: userScopePaths } },
        presence,
      );
      return {
        harness,
        breadcrumbs: scan.breadcrumbs,
        entities: [...scan.entities.values()],
        edges: [...scan.edges.values()],
        projectFacts: scan.projectFacts,
      };
    },
  };
}
