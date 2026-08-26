/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * The context OpenCode reads (research 02 §OpenCode "Rules"): `~/.config/opencode/AGENTS.md` in
 * every session — with `~/.claude/CLAUDE.md` as the Claude Code compatibility fallback, unless
 * `OPENCODE_DISABLE_CLAUDE_CODE*` turns it off — then, for a session started in a Project, every
 * `AGENTS.md` from the member root down to the session directory, concatenated **root-first**
 * (D62), with `CLAUDE.md` as a **per-walk** fallback (D62): one `AGENTS.md` anywhere on the walk
 * and no `CLAUDE.md` on it is read at all. Files listed in `instructions[]` of any configuration
 * file read follow the rules files in the chain; a URL entry is never fetched (ADR-0001).
 */
import { basename, dirname, join } from "node:path";
import type { ContextFile, LoadedByEdge } from "../../index/types.js";
import { formatOf, warning } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { nestedProjectDirs } from "../../scan/descend.js";
import { isFile, mapConcurrent, readText } from "../../scan/fs.js";
import { ancestors, isUnder, relativeUnder } from "../../scan/paths.js";
import type { ConfigFile } from "./config.js";
import { expandInstruction, instructionsOf, isUrlEntry } from "./config.js";
import {
  addEntity,
  baseEntity,
  displayPath,
  evidence,
  loadedBy,
  sessionDirOf,
  type OpenCodeScan,
} from "./model.js";

export const AGENTS_FILE = "AGENTS.md";
export const CLAUDE_FILE = "CLAUDE.md";

interface Verdict {
  mode: LoadedByEdge["mode"];
  reason: string;
  ordered: boolean;
  countsTowardHeadline: boolean;
}

/**
 * The context-file entity. `importCount: 0` and `containsMemorySection: false`: OpenCode
 * documents no import syntax and has no memory feature (research 10 §2.4).
 */
async function contextFileEntity(
  scan: OpenCodeScan,
  path: string,
  form: ContextFile["form"],
  project: DiscoveredProject | null,
): Promise<{ entity: ContextFile; text: string } | null> {
  const text = await readText(path);
  if (text === null) return null;
  const base = baseEntity(scan, {
    kind: "context-file",
    path,
    scope: project === null ? "user" : "project",
    project,
    ownership: "human",
    locator: { type: "file", path },
    format: formatOf(path),
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
    frontmatter: {},
    importCount: 0,
    containsMemorySection: false,
  };
  return { entity: addEntity(scan, entity), text };
}

function emit(
  scan: OpenCodeScan,
  entity: ContextFile,
  text: string,
  project: string | null,
  verdict: Verdict,
): void {
  const reads = verdict.mode !== "never" && verdict.mode !== "disabled";
  loadedBy(scan, {
    from: entity.id,
    project,
    mode: verdict.mode,
    reason: verdict.reason,
    placement: entity.path,
    effectiveName: null,
    ordered: verdict.ordered,
    charsLoaded: reads ? text.length : 0,
    importsResolved: null,
    tokensLoaded: reads ? scan.ctx.tokenizer.count(text).o200k : 0,
    disableModelInvocation: null,
    countsTowardHeadline: verdict.countsTowardHeadline,
    evidence: [evidence("loading-rule", verdict.reason)],
  });
}

async function emitFile(
  scan: OpenCodeScan,
  path: string,
  form: ContextFile["form"],
  project: DiscoveredProject | null,
  verdict: Verdict,
): Promise<void> {
  const facts = await contextFileEntity(scan, path, form, project);
  if (facts === null) return;
  emit(scan, facts.entity, facts.text, project?.id ?? null, verdict);
}

/** `~/.claude/CLAUDE.md`, the file the compatibility fallback names (`$CLAUDE_CONFIG_DIR` honoured). */
function claudeUserFile(scan: OpenCodeScan): string {
  const override = scan.ctx.consultEnv("CLAUDE_CONFIG_DIR");
  const dir = override === undefined ? join(scan.paths.home, ".claude") : override;
  return join(dir, CLAUDE_FILE);
}

/** User rules and the Claude Code compatibility fallback (§2.4 rule 1). */
export async function collectUserContextFiles(scan: OpenCodeScan): Promise<void> {
  const agents = join(scan.paths.configDir, AGENTS_FILE);
  const present = await isFile(agents);
  if (present) {
    await emitFile(scan, agents, "context", null, {
      mode: "full",
      reason: "user rules: read in every session",
      ordered: true,
      countsTowardHeadline: true,
    });
  }
  const disabled =
    scan.ctx.consultEnv("OPENCODE_DISABLE_CLAUDE_CODE") !== undefined ||
    scan.ctx.consultEnv("OPENCODE_DISABLE_CLAUDE_CODE_PROMPT") !== undefined;
  const fallback = claudeUserFile(scan);
  if (!(await isFile(fallback))) return;
  const verdict: Verdict = disabled
    ? {
        mode: "never",
        reason: "OPENCODE_DISABLE_CLAUDE_CODE is set",
        ordered: false,
        countsTowardHeadline: false,
      }
    : present
      ? {
          mode: "never",
          reason: "not read: ~/.config/opencode/AGENTS.md takes precedence",
          ordered: false,
          countsTowardHeadline: false,
        }
      : {
          mode: "full",
          reason: "fallback: no ~/.config/opencode/AGENTS.md (Claude Code compat)",
          ordered: true,
          countsTowardHeadline: true,
        };
  await emitFile(scan, fallback, "context", null, verdict);
}

/**
 * Rule 2: the chain a session started in the Project pays, root-first, and everything else the
 * Project holds — subdirectories below the session directory and the other members — as
 * unordered rows that only sessions started there pay.
 */
export async function collectProjectContextFiles(
  scan: OpenCodeScan,
  project: DiscoveredProject,
): Promise<void> {
  if (project.reachability !== "present") return;
  const fold = scan.ctx.identity.fold;
  const session = sessionDirOf(scan, project);
  const levels = ancestors(session.dir)
    .filter((dir) => isUnder(fold(dir), fold(session.member)))
    .toReversed();

  // D62: the walk decides once whether any AGENTS.md exists; `CLAUDE.md` is its fallback, per walk.
  const found = await Promise.all(
    levels.map(async (dir) => ({
      dir,
      agents: (await isFile(join(dir, AGENTS_FILE))) ? join(dir, AGENTS_FILE) : null,
      claude: (await isFile(join(dir, CLAUDE_FILE))) ? join(dir, CLAUDE_FILE) : null,
    })),
  );
  const anyAgents = found.some((level) => level.agents !== null);
  for (const level of found) {
    const where =
      fold(level.dir) === fold(session.member)
        ? "the project root"
        : fold(level.dir) === fold(session.dir)
          ? "the session directory"
          : "an ancestor of the session directory";
    if (level.agents !== null) {
      await emitFile(scan, level.agents, "context", project, {
        mode: "full",
        reason: `AGENTS.md of ${where}`,
        ordered: true,
        countsTowardHeadline: true,
      });
    }
    if (level.claude === null) continue;
    await emitFile(
      scan,
      level.claude,
      "context",
      project,
      anyAgents
        ? {
            mode: "never",
            reason: "not read: AGENTS.md found on the walk",
            ordered: false,
            countsTowardHeadline: false,
          }
        : {
            mode: "full",
            reason: "fallback: no AGENTS.md between the session directory and the project root",
            ordered: true,
            countsTowardHeadline: true,
          },
    );
  }

  const others: { dir: string; reason: () => string }[] = (
    await nestedProjectDirs(session.dir)
  ).map((dir) => ({
    dir,
    reason: () =>
      `loaded by sessions started in ${relativeUnder(dir, session.member) ?? basename(dir)}`,
  }));
  for (const member of project.members) {
    if (member.reachability !== "present" || fold(member.path) === fold(session.member)) continue;
    const name = member.name ?? basename(member.path);
    const reason = (): string => `in linked worktree ${name}: loaded by sessions started there`;
    others.push({ dir: member.path, reason });
    for (const dir of await nestedProjectDirs(member.path)) others.push({ dir, reason });
  }
  // Which of the two names each directory holds is a question for the disk alone, so all of them
  // are asked at once through a bounded pool; the rows below are emitted in walk order and every
  // `isFile` there is answered from the scan's memo (ticket 28).
  await mapConcurrent(
    others.flatMap(({ dir }) => [join(dir, AGENTS_FILE), join(dir, CLAUDE_FILE)]),
    (path) => isFile(path),
  );
  for (const { dir, reason } of others) {
    const agents = join(dir, AGENTS_FILE);
    const claude = join(dir, CLAUDE_FILE);
    const hasAgents = await isFile(agents);
    if (hasAgents) {
      await emitFile(scan, agents, "context", project, {
        mode: "full",
        reason: reason(),
        ordered: false,
        countsTowardHeadline: false,
      });
    }
    if (!(await isFile(claude))) continue;
    await emitFile(
      scan,
      claude,
      "context",
      project,
      hasAgents
        ? {
            mode: "never",
            reason: "not read: AGENTS.md found on the walk",
            ordered: false,
            countsTowardHeadline: false,
          }
        : {
            mode: "full",
            reason: reason(),
            ordered: false,
            countsTowardHeadline: false,
          },
    );
  }
}

/**
 * Rule 3: `instructions[]` of one configuration layer. Entries resolve against the directory of
 * the file that listed them; the Project of a match is the Project it lies in, so a user-level
 * entry naming a file inside a repository is that repository's row.
 */
export async function collectInstructions(
  scan: OpenCodeScan,
  layer: ConfigFile,
  project: DiscoveredProject | null,
): Promise<void> {
  const baseDir = dirname(layer.path);
  const where = displayPath(scan, layer.path, layer.project ?? project);
  for (const entry of instructionsOf(layer)) {
    if (isUrlEntry(entry)) {
      scan.ctx.warn(
        warning(
          "unsupported-shape",
          "instructions entry is a URL: not fetched",
          "opencode",
          layer.path,
          "skipped",
        ),
      );
      continue;
    }
    for (const path of await expandInstruction(entry, baseDir, scan.paths.home)) {
      const owner = project ?? scan.ctx.discovery.projectOf(path);
      await emitFile(scan, path, "instructions", owner, {
        mode: "full",
        reason: `listed in instructions[] of ${where}`,
        ordered: true,
        countsTowardHeadline: true,
      });
    }
  }
}
