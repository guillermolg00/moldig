/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order and the per-Project `order` numbers depend on it */
/**
 * The instructions Copilot injects (research 02 [69][70][77]): repository-wide
 * `.github/copilot-instructions.md`, path-scoped `.github/instructions/**\/*.instructions.md`
 * (frontmatter `applyTo`), the user-scope pair under `<COPILOT_HOME>`, and the root
 * `AGENTS.md` — nearest wins — with `CLAUDE.md` and `GEMINI.md` as root alternatives. Files
 * another adapter owns (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`) get a `loaded-by` edge from this
 * harness; the entity is emitted at the same id so nothing dangles when that adapter is not in
 * the run, and `scan`'s merge (D38) hands the row back to its owner when it is.
 *
 * Every directory the `chat.*FilesLocations` settings name is scanned too, and a directory the
 * settings switch off keeps its files with `mode: "disabled"` rather than hiding them.
 */
import { basename, join } from "node:path";
import type { Confidence, ContextFile, LoadedByEdge } from "../../index/types.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isFile, listDir, readText } from "../../scan/fs.js";
import { parseFrontmatter } from "../../scan/markdown.js";
import { booleanSetting, locationMap, locationsOf, type Location } from "./config.js";
import {
  addEntity,
  baseEntity,
  evidence,
  loadedBy,
  type CopilotScan,
  type MemberScope,
} from "./model.js";

const WALK_DEPTH = 6;
const PRUNED = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "__pycache__",
  "coverage",
]);

/** Frontmatter keys of an instructions file that reach the index (research 02 [69][70]). */
const INSTRUCTION_KEYS = ["applyTo", "name", "description", "excludeAgent"];

function project(
  frontmatter: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in frontmatter) out[key] = frontmatter[key];
  return out;
}

export interface ContextFacts {
  entity: ContextFile;
  /** What the harness injects: the body with the frontmatter block removed. */
  loadedText: string;
}

export async function contextFileEntity(
  scan: CopilotScan,
  path: string,
  form: ContextFile["form"],
  owner: DiscoveredProject | null,
  frontmatterKeys: readonly string[] = [],
): Promise<ContextFacts | null> {
  const text = await readText(path);
  if (text === null) return null;
  const frontmatter = parseFrontmatter(text);
  const base = baseEntity(scan, {
    kind: "context-file",
    path,
    scope: owner === null ? "user" : "project",
    project: owner,
    ownership: "human",
    locator: { type: "file", path },
    format: "md",
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: await scan.ctx.fileMetrics(path, text),
  });
  const entity: ContextFile = {
    ...base,
    kind: "context-file",
    form,
    fileName: basename(path),
    frontmatter: project(frontmatter.data, frontmatterKeys),
    // Nothing documents an import syntax for Copilot instructions (spec §2.4).
    importCount: 0,
    containsMemorySection: false,
  };
  return { entity: addEntity(scan, entity), loadedText: frontmatter.body };
}

export interface Verdict {
  mode: LoadedByEdge["mode"];
  reason: string;
  counts: boolean;
  confidence?: Confidence;
}

export function emitLoad(
  scan: CopilotScan,
  facts: ContextFacts,
  projectId: string | null,
  verdict: Verdict,
): void {
  const count = scan.ctx.tokenizer.count(facts.loadedText);
  loadedBy(scan, {
    from: facts.entity.id,
    project: projectId,
    mode: verdict.mode,
    reason: verdict.reason,
    placement: facts.entity.path,
    effectiveName: null,
    ordered: verdict.mode === "full",
    charsLoaded: facts.loadedText.length,
    importsResolved: null,
    tokensLoaded: verdict.mode === "disabled" ? 0 : count.o200k,
    disableModelInvocation: null,
    countsTowardHeadline: verdict.counts,
    evidence: [evidence("loading-rule", verdict.reason)],
    ...(verdict.confidence === undefined ? {} : { confidence: verdict.confidence }),
  });
}

/**
 * `applyTo` decides how much of a rule a session pays for: `**` is every request, another glob
 * is on demand, and no `applyTo` at all is attached by hand (D69).
 */
export function applyToMode(frontmatter: Record<string, unknown>): LoadedByEdge["mode"] {
  const applyTo = frontmatter["applyTo"];
  const globs =
    typeof applyTo === "string"
      ? applyTo.split(",").map((item) => item.trim())
      : Array.isArray(applyTo)
        ? applyTo.filter((item): item is string => typeof item === "string").map((i) => i.trim())
        : null;
  if (globs === null || globs.length === 0) return "manual";
  return globs.includes("**") ? "full" : "on-demand";
}

function ruleVerdict(entity: ContextFile, enabled: boolean, setting: string): Verdict {
  if (!enabled) {
    return {
      mode: "disabled",
      reason: `location disabled in ${setting}`,
      counts: false,
    };
  }
  const mode = applyToMode(entity.frontmatter);
  if (mode === "full") {
    return { mode, reason: "applyTo: ** — included in every request", counts: true };
  }
  if (mode === "on-demand") {
    return {
      mode,
      reason: "applyTo-scoped rule: included when matching files are in context",
      counts: false,
    };
  }
  return { mode, reason: "no applyTo: attached by hand", counts: false, confidence: "medium" };
}

/** `*.instructions.md` below `dir` (recursive, bounded). */
async function instructionFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > WALK_DEPTH) return [];
  const entries = (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name));
  const found = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && !PRUNED.has(entry.name)) return instructionFiles(path, depth + 1);
      return entry.isFile() && entry.name.endsWith(".instructions.md") ? [path] : [];
    }),
  );
  return found.flat();
}

async function loadInstructionLocations(
  scan: CopilotScan,
  locations: readonly Location[],
  owner: DiscoveredProject | null,
  projectId: string | null,
): Promise<void> {
  for (const location of locations) {
    for (const file of await instructionFiles(location.path)) {
      const facts = await contextFileEntity(scan, file, "rule", owner, INSTRUCTION_KEYS);
      if (facts === null) continue;
      emitLoad(
        scan,
        facts,
        projectId,
        ruleVerdict(facts.entity, location.enabled, "chat.instructionsFilesLocations"),
      );
    }
  }
}

/** The instruction directories of the user scope: `<COPILOT_HOME>/instructions` and `~`-rooted entries. */
export function userInstructionLocations(scan: CopilotScan): Location[] {
  const map = locationMap(scan.harnessSettings, "chat.instructionsFilesLocations");
  return locationsOf(
    map,
    [join(scan.paths.cliHome, "instructions")],
    scan.paths.home,
    scan.paths.home,
  ).filter((location) => location.userScope || location.isDefault);
}

/** User scope: what every Copilot CLI session pays for, whatever the Project. */
export async function collectUserContextFiles(scan: CopilotScan): Promise<void> {
  const instructions = join(scan.paths.cliHome, "copilot-instructions.md");
  if (await isFile(instructions)) {
    const facts = await contextFileEntity(scan, instructions, "instructions", null);
    if (facts !== null) {
      emitLoad(scan, facts, null, {
        mode: "full",
        reason: "user instructions: included in every Copilot CLI session",
        counts: true,
      });
    }
  }
  await loadInstructionLocations(scan, userInstructionLocations(scan), null, null);
}

/** Root context files another adapter owns, in the order Copilot reads them. */
interface RootAlternative {
  relativePath: string;
  form: ContextFile["form"];
  reason: string;
  vscodeOnly: boolean;
}

const ROOT_ALTERNATIVES: RootAlternative[] = [
  {
    relativePath: "CLAUDE.md",
    form: "context",
    reason: "root alternative to AGENTS.md (research 02 [70][77])",
    vscodeOnly: false,
  },
  {
    relativePath: "GEMINI.md",
    form: "context",
    reason: "root alternative to AGENTS.md (research 02 [70][77])",
    vscodeOnly: false,
  },
  {
    relativePath: ".claude/CLAUDE.md",
    form: "context",
    reason: "root alternative read by VS Code (research 02 [70])",
    vscodeOnly: true,
  },
  {
    relativePath: "CLAUDE.local.md",
    form: "local",
    reason: "root alternative read by VS Code (research 02 [70])",
    vscodeOnly: true,
  },
];

/** `AGENTS.md` files below the member root (nearest wins), bounded and pruned. */
async function nestedAgentsFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth >= WALK_DEPTH) return [];
  const entries = (await listDir(dir))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .filter((entry) => !PRUNED.has(entry.name) && !entry.name.startsWith("."))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const found = await Promise.all(
    entries.map(async (entry) => {
      const child = join(dir, entry.name);
      const children = await listDir(child);
      if (children.some((item) => item.name === "SKILL.md")) return [];
      const below = await nestedAgentsFiles(child, depth + 1);
      if (children.some((item) => item.name === "AGENTS.md"))
        below.unshift(join(child, "AGENTS.md"));
      return below;
    }),
  );
  return found.flat();
}

/** Project scope: the chain a session started in this member loads, in order. */
export async function collectMemberContextFiles(
  scan: CopilotScan,
  scope: MemberScope,
): Promise<void> {
  const projectId = scope.project.id;
  const instructions = join(scope.path, ".github", "copilot-instructions.md");
  if (await isFile(instructions)) {
    const facts = await contextFileEntity(scan, instructions, "instructions", scope.project);
    if (facts !== null) {
      emitLoad(scan, facts, projectId, {
        mode: "full",
        reason: "repository instructions: included in every request (CLI and VS Code)",
        counts: true,
      });
    }
  }
  const locations = locationsOf(
    locationMap(scope.settings, "chat.instructionsFilesLocations"),
    [".github/instructions"],
    scope.path,
    scan.paths.home,
  ).filter((location) => !location.userScope);
  await loadInstructionLocations(scan, locations, scope.project, projectId);

  const agentsMd = booleanSetting(scope.settings, "chat.useAgentsMdFile") ?? true;
  const nested = booleanSetting(scope.settings, "chat.useNestedAgentsMdFiles") ?? true;
  const claudeMd = booleanSetting(scope.settings, "chat.useClaudeMdFile") ?? true;
  const root = join(scope.path, "AGENTS.md");
  if (await isFile(root)) {
    const facts = await contextFileEntity(scan, root, "context", scope.project);
    if (facts !== null) {
      emitLoad(
        scan,
        facts,
        projectId,
        agentsMd
          ? {
              mode: "full",
              reason: "AGENTS.md of the repository root: nearest wins (CLI and VS Code)",
              counts: true,
            }
          : { mode: "disabled", reason: "chat.useAgentsMdFile: false", counts: false },
      );
    }
  }
  for (const path of await nestedAgentsFiles(scope.path)) {
    const facts = await contextFileEntity(scan, path, "context", scope.project);
    if (facts === null) continue;
    emitLoad(
      scan,
      facts,
      projectId,
      agentsMd && nested
        ? {
            mode: "on-demand",
            reason: "nested AGENTS.md: nearest wins when working in that subtree",
            counts: false,
            confidence: "medium",
          }
        : {
            mode: "disabled",
            reason: agentsMd ? "chat.useNestedAgentsMdFiles: false" : "chat.useAgentsMdFile: false",
            counts: false,
          },
    );
  }
  const hasAgentsMd = await isFile(root);
  for (const alternative of ROOT_ALTERNATIVES) {
    const path = join(scope.path, ...alternative.relativePath.split("/"));
    if (!(await isFile(path))) continue;
    const facts = await contextFileEntity(scan, path, alternative.form, scope.project);
    if (facts === null) continue;
    emitLoad(
      scan,
      facts,
      projectId,
      claudeMd
        ? {
            mode: "full",
            reason: alternative.reason,
            counts: true,
            // D69: the defaults of `chat.useClaudeMdFile` are documented but unverified, and a
            // root alternative beside an `AGENTS.md` may be a fallback rather than an addition.
            confidence: hasAgentsMd ? "medium" : "high",
          }
        : { mode: "disabled", reason: "chat.useClaudeMdFile: false", counts: false },
    );
  }
  // `.claude/rules/**` — VS Code reads Claude Code's rules directory under the same setting.
  for (const path of await rulesUnder(join(scope.path, ".claude", "rules"))) {
    const facts = await contextFileEntity(scan, path, "rule", scope.project);
    if (facts === null) continue;
    emitLoad(
      scan,
      facts,
      projectId,
      claudeMd
        ? {
            mode: "full",
            reason: "rule of .claude/rules, read by VS Code (research 02 [70])",
            counts: true,
            confidence: "medium",
          }
        : { mode: "disabled", reason: "chat.useClaudeMdFile: false", counts: false },
    );
  }
}

/** `*.md` below a rules directory (recursive, bounded). */
async function rulesUnder(dir: string, depth = 0): Promise<string[]> {
  if (depth > WALK_DEPTH) return [];
  const entries = (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name));
  const found = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return rulesUnder(path, depth + 1);
      return entry.isFile() && entry.name.endsWith(".md") ? [path] : [];
    }),
  );
  return found.flat();
}
