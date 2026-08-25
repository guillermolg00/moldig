#!/usr/bin/env node
// Generates the harness-independent fixture cases under fixtures/shared/:
//
//   root-tree      discovery: marker walk, git + worktree identity, pruning, depth limit
//   skill-layouts  skills: canonical store, symlinked and copied agent dirs, lock files
//
// Everything here is SYNTHETIC. Nothing is read from the machine that runs this script;
// the shapes come from docs/research/09-project-breadcrumbs-on-this-machine.md (§2, §3),
// 04-prior-art-and-ecosystem.md (Vercel skills lock files) and 02 (Agent Skills spec).
//
// Idempotent: deletes and recreates only fixtures/shared/<case> for the cases it owns.
// Output: counts and paths only.
//
// Conventions (fixtures/README.md + ticket 15 extensions):
//   - nested git entries are written as `_git` and declared in fixture.json "renames"
//   - symlinks are never committed; fixture.json "symlinks" records them (case-relative paths)
//   - absolute paths inside file contents use <HOME> / <ROOT>
//   - no harness slug directories exist in these cases, so __HOME__/__ROOT__ are unused

import { mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHARED_DIR = resolve(HERE, '..', 'shared');
const MAX_CASE_BYTES = 300 * 1024;

// ---------------------------------------------------------------------------
// content helpers (neutral filler only; never prose from a real file)

/** `n` filler lines; `width` pads each line so byte size varies independently of line count */
function filler(n, width = 0) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    let line = `- filler line ${i}`;
    while (line.length < width) line += ' filler';
    out.push(line);
  }
  return out.join('\n') + '\n';
}

/** YAML frontmatter from an ordered list of [key, value] pairs, followed by a filler body */
function frontmatter(pairs, body) {
  const fm = pairs.map(([k, v]) => `${k}: ${v}`).join('\n');
  return `---\n${fm}\n---\n\n${body}`;
}

/** SKILL.md per the Agent Skills spec: `name` must equal the directory name */
function skillMd(name, lines, width = 0) {
  return frontmatter([['name', name], ['description', '<redacted>']], filler(lines, width));
}

/** Cursor .mdc rule: documented frontmatter keys only */
function cursorRule(lines) {
  return frontmatter(
    [['description', '<redacted>'], ['globs', '<redacted>'], ['alwaysApply', 'false']],
    filler(lines),
  );
}

const json = (value) => JSON.stringify(value, null, 2) + '\n';

// ---------------------------------------------------------------------------
// case: root-tree

const gitHead = 'ref: refs/heads/main\n';

const rootTree = {
  name: 'root-tree',
  files: {
    // monorepo: a repository with root markers, nested markers, pruned dirs, a nested repo, a skill
    'root/monorepo/_git/HEAD': gitHead,
    'root/monorepo/CLAUDE.md': filler(8),
    'root/monorepo/AGENTS.md': filler(6),
    'root/monorepo/apps/web/CLAUDE.md': filler(4),
    'root/monorepo/apps/api/AGENTS.md': filler(5),
    'root/monorepo/packages/ui/.cursor/rules/x.mdc': cursorRule(3),
    'root/monorepo/node_modules/pkg/CLAUDE.md': filler(3),
    'root/monorepo/dist/CLAUDE.md': filler(2),
    'root/monorepo/vendor/lib/_git/HEAD': gitHead,
    'root/monorepo/.agents/skills/skill-a/SKILL.md': skillMd('skill-a', 10),
    'root/monorepo/.agents/skills/skill-a/AGENTS.md': filler(4),

    // non-git directories
    'root/plain-with-markers/CLAUDE.md': filler(5),
    'root/bare/README.md': filler(3),

    // worktrees: main repo registers a live and a stale worktree
    'root/wt-main/_git/HEAD': gitHead,
    'root/wt-main/_git/worktrees/feature/gitdir': '<ROOT>/wt-feature/.git\n',
    'root/wt-main/_git/worktrees/feature/commondir': '../..\n',
    'root/wt-main/_git/worktrees/feature/HEAD': 'ref: refs/heads/feature\n',
    'root/wt-main/_git/worktrees/dead/gitdir': '<ROOT>/wt-dead/.git\n',
    'root/wt-main/_git/worktrees/dead/commondir': '../..\n',
    'root/wt-main/_git/worktrees/dead/HEAD': 'ref: refs/heads/dead\n',
    'root/wt-feature/_git': 'gitdir: <ROOT>/wt-main/.git/worktrees/feature\n',
    'root/wt-feature/CLAUDE.md': filler(3),
    'root/wt-detached/_git': 'gitdir: <ROOT>/wt-gone/.git/worktrees/orphan\n',

    // beyond the depth limit
    'root/deep/1/2/3/4/5/6/7/CLAUDE.md': filler(2),
  },
  fixture: {
    renames: [
      { from: 'root/monorepo/_git', to: 'root/monorepo/.git' },
      { from: 'root/monorepo/vendor/lib/_git', to: 'root/monorepo/vendor/lib/.git' },
      { from: 'root/wt-main/_git', to: 'root/wt-main/.git' },
      { from: 'root/wt-feature/_git', to: 'root/wt-feature/.git' },
      { from: 'root/wt-detached/_git', to: 'root/wt-detached/.git' },
    ],
    symlinks: [{ path: 'root/link-to-monorepo', target: 'monorepo', kind: 'dir' }],
    ages: [],
  },
  readme: `# shared/root-tree

A synthetic tree of projects for discovery tests: the marker walk, git and linked-worktree
identity, pruning and the depth limit, under the rules of ADR 0006 (a Project is a real
directory folded to its repository; discovery reads \`.git\` files itself and spawns no
process). It is independent of any harness: there is no
\`home/\` subtree and no breadcrumb, only the projects side under \`root/\`.

Nothing was captured from a machine. Every file is generated by
\`fixtures/_capture/shared.mjs\` from the shapes in research notes 09 (§2 worktrees,
§3 nested markers) and 04. Markdown bodies are filler lines; \`.git\` entries are the
minimum git writes (\`HEAD\`, \`worktrees/<name>/{gitdir,commondir,HEAD}\`).

## What \`root/\` holds

| Path | Represents | Expected reading |
|---|---|---|
| \`monorepo/\` (\`.git/HEAD\`, \`CLAUDE.md\`, \`AGENTS.md\`) | a repository with two context files at its root | one Project |
| \`monorepo/apps/web/CLAUDE.md\`, \`monorepo/apps/api/AGENTS.md\` | sub-app context files of a monorepo | nested Context files of \`monorepo\`, not Projects |
| \`monorepo/packages/ui/.cursor/rules/x.mdc\` | a Cursor rule three levels down | nested Context file of \`monorepo\` |
| \`monorepo/node_modules/pkg/CLAUDE.md\` | a dependency shipping its own CLAUDE.md | pruned: never reported |
| \`monorepo/dist/CLAUDE.md\` | build output | pruned: never reported |
| \`monorepo/vendor/lib/.git/HEAD\` | a repository nested inside a repository | its own Project |
| \`monorepo/.agents/skills/skill-a/{SKILL.md,AGENTS.md}\` | a Skill whose payload includes an \`AGENTS.md\` | one Skill; the AGENTS.md is payload, not a Context file |
| \`plain-with-markers/CLAUDE.md\` | a directory without git that carries harness configuration | a Project (CONTEXT.md definition) |
| \`bare/README.md\` | a directory without git and without markers | not a Project |
| \`wt-main/\` | a main repository registering worktrees \`feature\` (live) and \`dead\` (target gone) | one Project; \`dead\` is a stale registration (\`git worktree prune\` never ran) |
| \`wt-feature/\` | a linked worktree: \`.git\` **file** \`gitdir: <ROOT>/wt-main/.git/worktrees/feature\` | belongs to \`wt-main\`'s Project; its \`CLAUDE.md\` is that Project's |
| \`wt-detached/\` | a \`.git\` file whose \`gitdir:\` target does not exist | broken worktree back-link (cannot run git) |
| \`deep/1/2/3/4/5/6/7/CLAUDE.md\` | a marker 8 directories below the root | beyond the depth limit (6): must not be found |
| \`link-to-monorepo\` | a directory symlink to \`monorepo/\` (created from \`fixture.json\`) | same real directory: one Project, not two |

## Edge cases carried

- nested context files inside a monorepo vs. a nested repository (own Project)
- \`node_modules/\` and \`dist/\` pruning
- an \`AGENTS.md\` inside a skill directory (payload, not context)
- marker-bearing non-repository, bare non-repository
- linked worktree (\`.git\` file), stale worktree registration, detached worktree file
- depth limit
- symlinked project directory (realpath dedupe)

## Synthetic

Everything. \`.git\` entries are committed as \`_git\` (git cannot track nested \`.git\`) and
renamed at copy time by the \`renames\` list in \`fixture.json\`; the symlink is created at copy
time from the \`symlinks\` list. No file ages are declared.

## Slug rule

None. This case has no harness slug directories, so the \`__HOME__\` / \`__ROOT__\` name tokens
are not used. Inside file contents the \`gitdir\` records use \`<ROOT>\` for the absolute path
of the projects side.
`,
};

// ---------------------------------------------------------------------------
// case: skill-layouts

const skillLockV3 = {
  version: 3,
  skills: {
    // canonical dir exists, linked into ~/.claude/skills
    'skill-a': {
      source: '<redacted>',
      sourceType: 'github',
      sourceUrl: '<redacted>',
      skillPath: '<redacted>',
      skillFolderHash: '<redacted-hash>',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z',
    },
    // lock entry whose canonical dir is gone (removed by hand)
    'skill-c': {
      source: '<redacted>',
      sourceType: 'local',
      sourceUrl: '<redacted>',
      skillFolderHash: '<redacted-hash>',
      installedAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    },
  },
  lastSelectedAgents: ['claude-code', 'codex', 'cursor'],
};

const skillsLockV1 = {
  version: 1,
  skills: {
    // present as a real copy under .claude/skills
    'skill-a': {
      source: '<redacted>',
      sourceUrl: '<redacted>',
      sourceType: 'github',
      skillPath: '<redacted>',
      computedHash: '<redacted-hash>',
    },
    // lock entry with no directory in the project
    'skill-c': {
      source: '<redacted>',
      sourceType: 'local',
      computedHash: '<redacted-hash>',
    },
  },
};

const skillLayouts = {
  name: 'skill-layouts',
  files: {
    // canonical store (Vercel skills CLI, new layout)
    'home/.agents/skills/skill-a/SKILL.md': skillMd('skill-a', 12),
    'home/.agents/.skill-lock.json': json(skillLockV3),
    // old layout: a real copy directly in the agent dir, no lock entry
    'home/.claude/skills/skill-b/SKILL.md': skillMd('skill-b', 20, 40),
    // project scope: a duplicate copy of skill-a with a different line count + project lock
    'root/project-a/.claude/skills/skill-a/SKILL.md': skillMd('skill-a', 30, 60),
    'root/project-a/skills-lock.json': json(skillsLockV1),
  },
  fixture: {
    renames: [],
    symlinks: [{ path: 'home/.claude/skills/skill-a', target: '../../.agents/skills/skill-a', kind: 'dir' }],
    ages: [],
  },
  readme: `# shared/skill-layouts

A synthetic home + project pair for skill discovery independent of any harness: the
canonical store of Vercel's \`skills\` CLI, a symlinked agent dir, an old-layout real copy,
a project-scope duplicate, and both lock files.

Nothing was captured from a machine. Every file is generated by
\`fixtures/_capture/shared.mjs\` from research notes 04 (lock file field names) and 02
(Agent Skills spec, install layout). SKILL.md bodies are filler lines of different sizes.

## What the tree holds

| Path | Represents |
|---|---|
| \`home/.agents/skills/skill-a/SKILL.md\` | the canonical copy (\`npx skills add -g\`), 12 body lines |
| \`home/.claude/skills/skill-a\` | a directory symlink to the canonical copy (new Vercel layout; on disk the link text is relative, \`../../.agents/skills/skill-a\`). Created at copy time from \`fixture.json\` |
| \`home/.claude/skills/skill-b/SKILL.md\` | a real copy directly in the agent dir (old layout / manual install), 20 body lines, no lock entry |
| \`home/.agents/.skill-lock.json\` | global lock, \`version: 3\`: entries \`skill-a\` (dir exists) and \`skill-c\` (dir gone); \`lastSelectedAgents\` holds public agent ids |
| \`root/project-a/.claude/skills/skill-a/SKILL.md\` | a project-scope duplicate of \`skill-a\` with a different line count (30) and byte size |
| \`root/project-a/skills-lock.json\` | project lock, \`version: 1\`: entries \`skill-a\` (present) and \`skill-c\` (absent) |

\`root/project-a\` has no \`.git\`: it is a Project because it carries harness configuration.

## Edge cases carried

- symlinked agent dir → dedupe by realpath with the canonical copy (one Skill, two locations)
- real copy in the agent dir with no lock entry (unlocked / pre-v3 install)
- lock entries whose directory is missing, at both scopes (\`skill-c\`)
- the same skill name at user and project scope with different content (duplicate, drift)
- two lock schemas: v3 (\`skillFolderHash\`, \`installedAt\`, \`updatedAt\`, \`lastSelectedAgents\`) and v1 (\`computedHash\`)

## Synthetic

Everything. Lock values are placeholders (\`<redacted>\`, \`<redacted-hash>\`); timestamps are
fixed synthetic ISO dates so they parse. Optional lock keys documented in research 04 but not
exercised: \`dismissed\` (top-level) and \`sourceBaseUrl\` (entry). No file ages are declared.

## Slug rule

None. No harness slug directories exist in this case; \`__HOME__\` / \`__ROOT__\` are not used
and no file content carries an absolute path.
`,
};

// ---------------------------------------------------------------------------
// writer

function build(c) {
  const caseDir = join(SHARED_DIR, c.name);
  rmSync(caseDir, { recursive: true, force: true });
  mkdirSync(caseDir, { recursive: true });

  const all = { ...c.files, 'fixture.json': json(c.fixture), 'README.md': c.readme };
  for (const [rel, content] of Object.entries(all)) {
    const abs = join(caseDir, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }

  const { files, bytes } = measure(caseDir);
  if (bytes > MAX_CASE_BYTES) throw new Error(`${c.name}: ${bytes} bytes exceeds ${MAX_CASE_BYTES}`);
  console.log(`${relative(resolve(HERE, '..', '..'), caseDir).split(sep).join('/')}: ${files} files, ${bytes} bytes`);
  return { files, bytes };
}

function measure(dir) {
  let files = 0;
  let bytes = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = measure(p);
      files += sub.files;
      bytes += sub.bytes;
    } else {
      files += 1;
      bytes += statSync(p).size;
    }
  }
  return { files, bytes };
}

mkdirSync(SHARED_DIR, { recursive: true });
const totals = [rootTree, skillLayouts].map(build);
console.log(`shared: ${totals.length} cases, ${totals.reduce((n, t) => n + t.files, 0)} files, ${totals.reduce((n, t) => n + t.bytes, 0)} bytes`);
