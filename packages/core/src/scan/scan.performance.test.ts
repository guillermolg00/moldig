/**
 * The budget a scan has to stay inside (ticket 28). A synthetic machine of ~20,000 files is
 * built in a temp directory and scanned once with every adapter; the test fails if the scan
 * takes longer than `BUDGET_MS`.
 *
 * It exists to catch a regression rather than to measure a machine: the budget is generous
 * enough for the slowest of the three operating systems CI runs, and only the scan is timed —
 * building the tree is not, because creating 20,000 files costs far more on Windows than on
 * either Unix and would drown the signal.
 */
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { assertScanPlatform, scan } from "../index.js";
import { mapConcurrent } from "./fs.js";

/**
 * Measured on the machine ticket 28 was profiled on: 1.14 s for this tree, and 2.66 s with the
 * scan's filesystem memo removed. A shared CI runner is several times slower than that machine
 * and a Windows runner slower again on a stat-heavy walk, so the budget sits about seven times
 * above the measurement: it is a guard against the class of regression this ticket removed —
 * a real scan went from 57 s to 8 s — and not a stopwatch, and it must not go red because a
 * runner was busy.
 */
const BUDGET_MS = 8_000;
const PROJECTS = 60;
const NESTED_DIRS = 40;
const FILES_PER_DIR = 8;
const TRANSCRIPTS = 20;
const SKILLS = 20;
const NOW = new Date("2026-08-26T12:00:00.000Z");

let root = "";
let created = 0;

/** A handful of directories, each holding `FILES_PER_DIR` small files. */
async function fillTree(base: string, dirs: readonly string[]): Promise<void> {
  await mapConcurrent(dirs, async (relative) => {
    const dir = join(base, relative);
    await mkdir(dir, { recursive: true });
    await mapConcurrent(
      Array.from({ length: FILES_PER_DIR }, (_, index) => index),
      (index) =>
        writeFile(join(dir, `file-${index}.ts`), `export const value${index} = ${index};\n`),
    );
    created += FILES_PER_DIR;
  });
}

async function writeFileAt(path: string, text: string): Promise<void> {
  await writeFile(path, text);
  created += 1;
}

/** A skill store: `<dir>/<name>/SKILL.md`, the shape every adapter's skill pass expects. */
async function writeSkills(dir: string, prefix: string): Promise<void> {
  await mapConcurrent(
    Array.from({ length: SKILLS }, (_, index) => index),
    async (index) => {
      const skill = join(dir, `${prefix}-${index}`);
      await mkdir(skill, { recursive: true });
      await writeFileAt(
        join(skill, "SKILL.md"),
        `---\nname: ${prefix}-${index}\ndescription: skill ${index} of the ${prefix} store\n---\n\nBody of skill ${index}.\n`,
      );
    },
  );
}

/** The slug Claude Code gives a directory: every separator becomes a dash. */
function slugOf(path: string): string {
  return path.replaceAll(/[/\\:]/g, "-");
}

async function buildMachine(home: string): Promise<void> {
  const work = join(home, "work");
  const projects = Array.from({ length: PROJECTS }, (_, index) => join(work, `repo-${index}`));
  const nested = Array.from({ length: NESTED_DIRS }, (_, index) =>
    join("src", `area-${index % 5}`, `module-${index}`),
  );

  await mapConcurrent(
    projects,
    async (project) => {
      // A `.git` directory alone makes the directory a Project; `git: false` never spawns git.
      await mkdir(join(project, ".git"), { recursive: true });
      await mkdir(join(project, ".claude"), { recursive: true });
      await mkdir(join(project, ".cursor", "rules"), { recursive: true });
      await mkdir(join(project, ".github"), { recursive: true });
      await Promise.all([
        writeFileAt(join(project, "CLAUDE.md"), "# Project rules\n\nBe brief.\n"),
        writeFileAt(join(project, "AGENTS.md"), "# Agents\n\nRun the tests.\n"),
        writeFileAt(join(project, "GEMINI.md"), "# Gemini\n\nSame rules.\n"),
        writeFileAt(join(project, ".claude", "settings.json"), '{"model":"opus"}\n'),
        writeFileAt(
          join(project, ".cursor", "rules", "style.mdc"),
          "---\nalwaysApply: true\n---\n",
        ),
        writeFileAt(join(project, ".github", "copilot-instructions.md"), "# Copilot\n"),
        writeFileAt(join(project, ".mcp.json"), '{"mcpServers":{}}\n'),
      ]);
      await fillTree(project, nested);
      // One nested context file per Project, so the descent has something to emit.
      await writeFileAt(join(project, "src", "area-0", "AGENTS.md"), "# Nested\n");
    },
    8,
  );

  // The Claude Code user layer: one slug directory per Project, each with its transcripts.
  const claude = join(home, ".claude");
  await mkdir(join(claude, "skills"), { recursive: true });
  await mkdir(join(claude, "projects"), { recursive: true });
  await writeFileAt(join(claude, "CLAUDE.md"), "# User rules\n\nBe brief.\n");
  await writeFileAt(
    join(home, ".claude.json"),
    `${JSON.stringify({
      projects: Object.fromEntries(
        projects.map((path) => [path, { hasTrustDialogAccepted: true }]),
      ),
    })}\n`,
  );
  await writeSkills(join(claude, "skills"), "claude-skill");
  await writeSkills(join(home, ".agents", "skills"), "store-skill");
  await mapConcurrent(projects, async (project) => {
    const slug = join(claude, "projects", slugOf(project));
    await mkdir(slug, { recursive: true });
    await mapConcurrent(
      Array.from({ length: TRANSCRIPTS }, (_, index) => index),
      (index) =>
        writeFileAt(
          join(slug, `session-${index}.jsonl`),
          `${JSON.stringify({ cwd: project, version: "2.1.0", timestamp: NOW.toISOString() })}\n`,
        ),
    );
  });

  // The other harnesses' user layers, so every adapter has something of its own to read.
  for (const [dir, file, text] of [
    [join(home, ".codex"), "AGENTS.md", "# Codex\n"],
    [join(home, ".gemini"), "GEMINI.md", "# Gemini\n"],
    [join(home, ".cursor", "rules"), "user.mdc", "---\nalwaysApply: true\n---\n"],
    [join(home, ".config", "opencode"), "AGENTS.md", "# OpenCode\n"],
    [join(home, ".config", "github-copilot"), "config.json", "{}\n"],
  ] as const) {
    // oxlint-disable-next-line no-await-in-loop -- five fixed directories; order is irrelevant
    await mkdir(dir, { recursive: true });
    // oxlint-disable-next-line no-await-in-loop -- see above
    await writeFileAt(join(dir, file), text);
  }
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "moldig-bench-")));
  await buildMachine(root);
}, 300_000);

afterAll(async () => {
  if (root !== "") await rm(root, { recursive: true, force: true });
});

it(
  "scans a synthetic machine of ~20,000 files inside its budget",
  async () => {
    expect(created).toBeGreaterThanOrEqual(20_000);
    const started = performance.now();
    const index = await scan({
      home: root,
      roots: [root],
      cwd: join(root, "work", "repo-0"),
      platform: assertScanPlatform(process.platform),
      env: {},
      // No git: the budget must not depend on a binary CI may or may not have warmed.
      git: false,
      now: NOW,
    });
    const elapsed = performance.now() - started;
    // The tree is real, so the scan must have found it: a budget met by scanning nothing is no
    // budget at all.
    expect(index.projects.length).toBeGreaterThanOrEqual(PROJECTS);
    expect(index.entities.length).toBeGreaterThan(PROJECTS * 4);
    expect(index.scan.durationMs).toBeLessThanOrEqual(elapsed + 1);
    expect(elapsed).toBeLessThan(BUDGET_MS);
  },
  BUDGET_MS * 3,
);
