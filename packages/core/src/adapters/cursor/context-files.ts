/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order and the per-Project `order` numbers depend on it */
/**
 * Context files Cursor reads (research 02 [17][18]; spec §1.4): `.cursor/rules/**‍/*.mdc` in the
 * four types its frontmatter encodes (Always, Auto Attached, Agent Requested, Manual), the legacy
 * `.cursorrules`, the repository's `AGENTS.md` and `CLAUDE.md` (both load — D68) and the nested
 * `AGENTS.md` of a subtree. User rules under `~/.cursor/rules/` are the baseline of every session.
 *
 * `AGENTS.md` and `CLAUDE.md` belong to other adapters' stores; this one emits the entity so no
 * edge dangles when it runs alone, and `scan`'s merge (D38) keeps one entity per real file with
 * every reader's `loaded-by` edge on it. Cursor documents no import syntax for a rule body, so
 * `importCount` stays 0 and no `imports` edge is emitted (D68).
 */
import { basename, join } from "node:path";
import type { ContextFile, Format, LoadedByEdge } from "../../index/types.js";
import type { DiscoveredProject, Member } from "../../scan/discovery.js";
import { NESTED_DEPTH, nestedProjectDirs } from "../../scan/descend.js";
import { isFile, listDir, mapConcurrent, readText } from "../../scan/fs.js";
import { parseFrontmatter } from "../../scan/markdown.js";
import { addEntity, baseEntity, evidence, loadedBy, type CursorScan } from "./model.js";

/** The four rule types of `.mdc` frontmatter, in the precedence research 02 documents. */
export type RuleType = "always" | "auto-attached" | "agent-requested" | "manual";

function nonEmpty(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  return Array.isArray(value) && value.length > 0;
}

/** `alwaysApply` wins ("globs and description are ignored"), then `globs`, then `description`. */
export function ruleTypeOf(frontmatter: Record<string, unknown>): RuleType {
  if (frontmatter["alwaysApply"] === true) return "always";
  if (nonEmpty(frontmatter["globs"])) return "auto-attached";
  if (nonEmpty(frontmatter["description"])) return "agent-requested";
  return "manual";
}

interface Verdict {
  mode: LoadedByEdge["mode"];
  reason: string;
  text: string;
  counts: boolean;
  ordered: boolean;
  confidence?: LoadedByEdge["confidence"];
}

function ruleVerdict(type: RuleType, frontmatter: Record<string, unknown>, body: string): Verdict {
  const description =
    typeof frontmatter["description"] === "string" ? frontmatter["description"] : "";
  switch (type) {
    case "always":
      return {
        mode: "full",
        reason: "alwaysApply: true — injected in every chat",
        text: body,
        counts: true,
        ordered: true,
      };
    case "auto-attached":
      return {
        mode: "on-demand",
        reason: "globs-scoped rule: attached when matching files are in context",
        text: "",
        counts: false,
        ordered: false,
      };
    case "agent-requested":
      return {
        mode: "description-only",
        reason: "description-only rule: the model pulls it in when relevant",
        // The description is listed at startup, so it has a chain position and a token count —
        // but ticket 05's answer for Cursor is "only `alwaysApply` rules in full", and ticket 18
        // pins the Headline to those plus `.cursorrules`.
        text: description,
        counts: false,
        ordered: true,
      };
    default:
      return {
        mode: "manual",
        reason: "manual rule: @-mentioned by the user",
        text: "",
        counts: false,
        ordered: false,
      };
  }
}

interface FileInput {
  path: string;
  form: ContextFile["form"];
  format: Format;
  scope: "user" | "project";
  project: DiscoveredProject | null;
}

async function contextEntity(
  scan: CursorScan,
  input: FileInput,
): Promise<{ entity: ContextFile; frontmatter: Record<string, unknown>; body: string } | null> {
  const text = await readText(input.path);
  if (text === null) return null;
  const parsed = parseFrontmatter(text);
  const base = baseEntity(scan, {
    kind: "context-file",
    path: input.path,
    scope: input.scope,
    project: input.project,
    ownership: "human",
    locator: { type: "file", path: input.path },
    format: input.format,
    sensitive: false,
    protection: "none",
    removal: { method: "trash" },
    metrics: await scan.ctx.fileMetrics(input.path, text),
  });
  const entity: ContextFile = {
    ...base,
    kind: "context-file",
    form: input.form,
    fileName: basename(input.path),
    frontmatter: parsed.data,
    importCount: 0,
    containsMemorySection: false,
  };
  return { entity: addEntity(scan, entity), frontmatter: parsed.data, body: parsed.body };
}

function emit(
  scan: CursorScan,
  entity: ContextFile,
  project: DiscoveredProject | null,
  verdict: Verdict,
): void {
  const input = {
    from: entity.id,
    project: project?.id ?? null,
    mode: verdict.mode,
    reason: verdict.reason,
    placement: entity.path,
    effectiveName: null,
    ordered: verdict.ordered,
    charsLoaded: verdict.text.length,
    tokensLoaded: scan.ctx.tokenizer.count(verdict.text).o200k,
    countsTowardHeadline: verdict.counts,
    evidence: [evidence("loading-rule", verdict.reason)],
  };
  loadedBy(
    scan,
    verdict.confidence === undefined ? input : { ...input, confidence: verdict.confidence },
  );
}

/** Every `*.mdc` below a rules directory, sorted, bounded like the marker walk. */
async function rulesUnder(dir: string, depth = 0): Promise<string[]> {
  if (depth > NESTED_DEPTH) return [];
  const entries = (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name));
  const found = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return rulesUnder(path, depth + 1);
      return entry.isFile() && entry.name.endsWith(".mdc") ? [path] : [];
    }),
  );
  return found.flat();
}

/** `~/.cursor/rules/*.mdc`: the same four verdicts at user scope (the session baseline). */
export async function collectUserContextFiles(scan: CursorScan): Promise<void> {
  for (const path of await rulesUnder(join(scan.paths.configDir, "rules"))) {
    const facts = await contextEntity(scan, {
      path,
      form: "rule",
      format: "mdc",
      scope: "user",
      project: null,
    });
    if (facts === null) continue;
    emit(
      scan,
      facts.entity,
      null,
      ruleVerdict(ruleTypeOf(facts.frontmatter), facts.frontmatter, facts.body),
    );
  }
}

/**
 * One member's context files, in chain order: its rules, the legacy `.cursorrules`, `AGENTS.md`,
 * `CLAUDE.md`, then the nested `AGENTS.md`/`CLAUDE.md` of the subtree. A member that is not the
 * repository directory is a linked worktree: its copies load only for sessions started there.
 */
async function collectMember(
  scan: CursorScan,
  project: DiscoveredProject,
  member: Member,
  worktree: string | null,
): Promise<void> {
  const inWorktree = (verdict: Verdict): Verdict =>
    worktree === null
      ? verdict
      : {
          ...verdict,
          reason: `in linked worktree ${worktree}: loaded by sessions started there`,
          counts: false,
          ordered: false,
        };

  for (const path of await rulesUnder(join(member.path, ".cursor", "rules"))) {
    const facts = await contextEntity(scan, {
      path,
      form: "rule",
      format: "mdc",
      scope: "project",
      project,
    });
    if (facts === null) continue;
    emit(
      scan,
      facts.entity,
      project,
      inWorktree(ruleVerdict(ruleTypeOf(facts.frontmatter), facts.frontmatter, facts.body)),
    );
  }

  const legacy = join(member.path, ".cursorrules");
  if (await isFile(legacy)) {
    // `.cursorrules` has no extension of its own: `formatOf()` would say `other`, and the file is
    // documented as plain text or Markdown.
    const facts = await contextEntity(scan, {
      path: legacy,
      form: "context",
      format: "txt",
      scope: "project",
      project,
    });
    if (facts !== null) {
      emit(
        scan,
        facts.entity,
        project,
        inWorktree({
          mode: "full",
          reason: "legacy .cursorrules: documented as still read, deprecated",
          text: facts.body,
          // D68: it loads in full and counts toward the headline; the deprecation is the reason
          // the verdict's confidence is low, not a reason to leave it out of the number.
          counts: true,
          ordered: true,
          confidence: "low",
        }),
      );
    }
  }

  const roots: { name: string; reason: string; confidence: LoadedByEdge["confidence"] }[] = [
    {
      name: "AGENTS.md",
      reason: "AGENTS.md of the repository root: always applied",
      confidence: "high",
    },
    {
      name: "CLAUDE.md",
      reason: "CLAUDE.md read the same way as AGENTS.md",
      // D68: both load when both exist; that they are read together is the medium-confidence part.
      confidence: (await isFile(join(member.path, "AGENTS.md"))) ? "medium" : "high",
    },
  ];
  for (const root of roots) {
    const path = join(member.path, root.name);
    if (!(await isFile(path))) continue;
    const facts = await contextEntity(scan, {
      path,
      form: "context",
      format: "md",
      scope: "project",
      project,
    });
    if (facts === null) continue;
    emit(
      scan,
      facts.entity,
      project,
      inWorktree({
        mode: "full",
        reason: root.reason,
        text: facts.body,
        counts: true,
        ordered: true,
        confidence: root.confidence,
      }),
    );
  }

  const nested = await nestedProjectDirs(member.path);
  // Which directories hold one of the two names is a question for the disk alone, so all of them
  // are asked at once through a bounded pool; the rows below are still emitted in walk order and
  // every `isFile` there is answered from the scan's memo (ticket 28).
  await mapConcurrent(
    nested.flatMap((dir) => [join(dir, "AGENTS.md"), join(dir, "CLAUDE.md")]),
    (path) => isFile(path),
  );
  for (const dir of nested) {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const path = join(dir, name);
      if (!(await isFile(path))) continue;
      const facts = await contextEntity(scan, {
        path,
        form: "context",
        format: "md",
        scope: "project",
        project,
      });
      if (facts === null) continue;
      emit(
        scan,
        facts.entity,
        project,
        inWorktree({
          mode: "on-demand",
          reason:
            name === "AGENTS.md"
              ? "nested AGENTS.md: applies when working in that subtree"
              : "nested CLAUDE.md: applies when working in that subtree",
          text: "",
          counts: false,
          ordered: false,
          confidence: name === "AGENTS.md" ? "high" : "medium",
        }),
      );
    }
  }
}

export async function collectProjectContextFiles(
  scan: CursorScan,
  project: DiscoveredProject,
): Promise<void> {
  if (project.reachability !== "present") return;
  const fold = scan.ctx.identity.fold;
  const members = project.members.filter((member) => member.reachability === "present");
  const repository = members.find((member) => fold(member.path) === fold(project.path));
  if (repository !== undefined) await collectMember(scan, project, repository, null);
  for (const member of members) {
    if (fold(member.path) === fold(project.path)) continue;
    await collectMember(scan, project, member, member.name ?? basename(member.path));
  }
}
