#!/usr/bin/env node
// Generates the Gemini CLI fixture cases under fixtures/gemini-cli/:
//
//   from-docs         the complete documented layout (three live projects, one gone, one
//                     legacy scratch dir, extension, skills, commands, agents, hooks, memory)
//   zero-breadcrumbs  the exact shape research 09 observed on the capture machine
//                     (signed in, never used inside a project)
//
// Gemini CLI left NO project breadcrumbs on the capture machine (research 09: no
// projects.json, no trustedFolders.json, empty tmp/), so nothing here is parsed from a
// real file. Every tree is synthesised from the "Gemini CLI" section of
// docs/research/02-other-harnesses-on-disk-layout.md plus the observed-shape notes of
// research 02 ("On this machine") and research 09. The script never opens a file under
// the real home directory; `--check` only lists NAMES (depth <= 2) under ~/.gemini to
// re-confirm the zero-breadcrumb claim, never descending into antigravity/.
//
// Idempotent: deletes and recreates fixtures/gemini-cli/<case> for the cases it owns,
// nothing else. Dependency-free (node: built-ins only). Prints counts and paths only.
//
// Conventions (fixtures/README.md + ticket 15 extensions):
//   - nested git entries are written as `_git` and declared in fixture.json "renames"
//   - symlinks are never committed; fixture.json "symlinks" records them with `target`
//     as the LINK TEXT relative to the link's parent directory (what readlink returns)
//   - empty directories cannot be committed; fixture.json "dirs" lists them (same key
//     as fixtures/_capture/opencode.mjs)
//   - absolute paths inside file contents use <HOME> / <ROOT>
//   - Gemini slugs are basename-derived, so the __HOME__/__ROOT__ name tokens are unused

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'gemini-cli');
const MAX_CASE_BYTES = 300 * 1024;
const R = '<redacted>';
const ROOT = '<ROOT>';

// Visibly synthetic identifiers. LEGACY_SLUG has the shape of a legacy `sha256(path)`
// scratch directory (64 hex chars) but is the digest of nothing.
const LEGACY_SLUG = '0123456789abcdef'.repeat(4);
const SESSION_A = '00000000-0000-4000-8000-000000000001';
const SESSION_B = '00000000-0000-4000-8000-000000000002';

// ---------------------------------------------------------------- builders --

function filler(count, prefix = '- filler line') {
  const lines = [];
  for (let i = 1; i <= count; i += 1) lines.push(`${prefix} ${i}`);
  return `${lines.join('\n')}\n`;
}

function frontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(Array.isArray(value) ? `${key}: [${value.join(', ')}]` : `${key}: ${value}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

/** SKILL.md per the Agent Skills spec: `name` equals the directory name */
function skillMd(name, bodyLines = 6) {
  return `${frontmatter({ name, description: R })}\n# ${name}\n\n${filler(bodyLines)}`;
}

/** Gemini agent definition: documented frontmatter keys only */
function agentMd(name) {
  return `${frontmatter({ name, description: R, kind: 'local', display_name: R, tools: [R], model: R })}\n${filler(4)}`;
}

/** Gemini custom command: TOML with the documented keys (`prompt` required, `description`) */
function commandToml() {
  return `description = "${R}"\nprompt = "${R}"\n`;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

class Case {
  constructor(name, readme) {
    this.name = name;
    this.readme = readme;
    this.files = new Map();
    this.renames = [];
    this.symlinks = [];
    this.ages = [];
    this.dirs = [];
  }

  file(path, content) {
    this.files.set(path, content);
    return this;
  }

  json(path, value) {
    return this.file(path, json(value));
  }

  /** a git repository: `_git/HEAD` on disk, renamed to `.git/HEAD` at copy time */
  git(dirRel) {
    this.file(`${dirRel}/_git/HEAD`, 'ref: refs/heads/main\n');
    this.renames.push({ from: `${dirRel}/_git`, to: `${dirRel}/.git` });
    return this;
  }

  symlink(path, target, kind) {
    this.symlinks.push({ path, target, kind });
    return this;
  }

  age(path, ageDays) {
    this.ages.push({ path, ageDays });
    return this;
  }

  dir(path) {
    this.dirs.push(path);
    return this;
  }

  fixture() {
    return { renames: this.renames, symlinks: this.symlinks, ages: this.ages, dirs: this.dirs };
  }
}

// ------------------------------------------------------- shared documents --

// ~/.gemini/settings.json, v2 nested schema: every documented top-level key, `context.*`
// sub-keys, `hooks.<Event>[]`, `mcp.{allowed,excluded}`, and the top-level `mcpServers`
// map with one stdio server (documented key shape; values redacted).
const userSettingsV2 = {
  general: { checkpointing: { enabled: true }, sessionRetention: {} },
  output: {},
  ui: { theme: R, customThemes: {} },
  ide: { hasSeenNudge: true },
  privacy: {},
  telemetry: { enabled: false },
  billing: {},
  model: {},
  modelConfigs: {},
  agents: {},
  context: {
    fileName: ['GEMINI.md', 'AGENTS.md'],
    importFormat: 'tree',
    includeDirectoryTree: true,
    discoveryMaxDirs: 200,
    memoryBoundaryMarkers: ['.git'],
    includeDirectories: [`${ROOT}/project-b`],
    loadMemoryFromIncludeDirectories: false,
    fileFiltering: {
      respectGitIgnore: true,
      respectGeminiIgnore: true,
      enableFileWatcher: false,
      enableRecursiveFileSearch: true,
      enableFuzzySearch: true,
      customIgnoreFilePaths: [],
    },
  },
  tools: {},
  mcp: { allowed: ['server-a'], excluded: [] },
  useWriteTodos: false,
  security: { auth: { selectedType: R } },
  admin: {},
  advanced: {},
  experimental: { autoMemory: true },
  extensions: {},
  skills: { enabled: true, disabled: ['skill-c'] },
  hooksConfig: {},
  hooks: {
    BeforeTool: [{ matcher: R, hooks: [{ type: 'command', command: R, name: R, timeout: 30000 }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: R }] }],
  },
  contextManagement: {},
  mcpServers: {
    'server-a': {
      command: R,
      args: [R, R],
      env: { VAR_A: R },
      cwd: `${ROOT}/project-a`,
      timeout: 600000,
      trust: false,
      includeTools: [R],
      excludeTools: [],
    },
  },
};

// <project>/.gemini/settings.json: a remote `httpUrl` server with `headers` + `oauth{}`,
// an SSE `url` server with the service-account keys, and one project hook.
const projectSettingsA = {
  context: { fileName: 'GEMINI.md' },
  mcpServers: {
    'server-b': {
      httpUrl: R,
      headers: { Authorization: R },
      timeout: 600000,
      trust: false,
      oauth: {
        enabled: true,
        clientId: R,
        clientSecret: R,
        authorizationUrl: R,
        tokenUrl: R,
        scopes: [R],
        redirectUri: R,
        tokenParamName: R,
        audiences: [R],
      },
    },
    'server-c': { url: R, authProviderType: R, targetAudience: R, targetServiceAccount: R },
  },
  hooks: {
    AfterTool: [{ matcher: R, hooks: [{ type: 'command', command: R, timeout: 5000 }] }],
  },
};

// Legacy flat keys (pre-v2 schema) that "may survive in older files".
const projectSettingsLegacy = {
  contextFileName: 'GEMINI.md',
  theme: R,
  checkpointing: { enabled: true },
  mcpServers: { 'server-d': { command: R, args: [R] } },
};

const extensionManifest = {
  name: 'ext-a',
  version: '1.0.0',
  description: R,
  mcpServers: { 'ext-server': { command: R, args: [`\${extensionPath}/${R}`] } },
  contextFileName: 'GEMINI.md',
  excludeTools: [R],
  settings: [{ name: R, description: R, envVar: 'VAR_A', sensitive: true }],
};

// ~/.agents/.skill-lock.json (Vercel skills CLI) with the documented key set.
const skillLock = {
  version: 1,
  skills: {
    'find-skills': {
      source: R,
      sourceType: R,
      sourceUrl: R,
      skillPath: R,
      skillFolderHash: R,
      installedAt: R,
      updatedAt: R,
    },
    'next-best-practices': {
      source: R,
      sourceType: R,
      sourceUrl: R,
      skillPath: R,
      skillFolderHash: R,
      installedAt: R,
      updatedAt: R,
    },
  },
  dismissed: { findSkillsPrompt: true },
  lastSelectedAgents: ['gemini-cli', 'claude-code'],
};

// -------------------------------------------------------------- from-docs --

function buildFromDocs() {
  const c = new Case('from-docs', README_FROM_DOCS);
  const g = 'home/.gemini';
  const tmpA = `${g}/tmp/project-a`;

  // User scope
  c.file(`${g}/GEMINI.md`, `${filler(6)}\n## Gemini Added Memories\n\n${filler(3)}`);
  c.json(`${g}/settings.json`, userSettingsV2);
  c.json(`${g}/projects.json`, {
    projects: {
      [`${ROOT}/project-a`]: 'project-a',
      [`${ROOT}/gone`]: 'gone',
      [`${ROOT}/project-b`]: 'project-b',
      [`${ROOT}/nested/project-b`]: 'project-b-1',
    },
  });
  c.json(`${g}/trustedFolders.json`, {
    [`${ROOT}/project-a`]: 'TRUST_FOLDER',
    [`${ROOT}/gone`]: 'TRUST_FOLDER',
    [`${ROOT}/project-c`]: 'DO_NOT_TRUST',
    [`${ROOT}/nested/project-b`]: 'TRUST_PARENT',
  });
  c.file(`${g}/installation_id`, `${R}\n`);
  c.json(`${g}/keybindings.json`, {});
  c.json(`${g}/acknowledgments/agents.json`, {});
  // Secret files at their documented names, ZERO bytes: a test can assert the adapter
  // never opens them. Nothing was read from the real files of the same name.
  c.file(`${g}/oauth_creds.json`, '');
  c.file(`${g}/google_accounts.json`, '');
  c.file(`${g}/mcp-oauth-tokens.json`, '');
  c.file(`${g}/.env`, '');

  // Commands (subdir -> ':' namespace)
  c.file(`${g}/commands/cmd-a.toml`, commandToml());
  c.file(`${g}/commands/ns/cmd-b.toml`, commandToml());

  // Skills: one real copy, one symlink into ~/.agents/skills
  c.file(`${g}/skills/skill-c/SKILL.md`, skillMd('skill-c'));
  c.file('home/.agents/skills/skill-d/SKILL.md', skillMd('skill-d'));
  c.symlink(`${g}/skills/skill-d`, '../../.agents/skills/skill-d', 'dir');

  // Agents
  c.file(`${g}/agents/agent-b.md`, agentMd('agent-b'));

  // Extensions (only ~/.gemini/extensions/<name>/ is loaded)
  const ext = `${g}/extensions/ext-a`;
  c.json(`${ext}/gemini-extension.json`, extensionManifest);
  c.json(`${ext}/.gemini-extension-install.json`, { source: R, type: 'git', ref: R, autoUpdate: false });
  c.file(`${ext}/GEMINI.md`, filler(5));
  c.file(`${ext}/commands/ext-cmd.toml`, commandToml());
  c.file(`${ext}/skills/skill-b/SKILL.md`, skillMd('skill-b'));
  c.json(`${ext}/hooks/hooks.json`, {
    hooks: { BeforeAgent: [{ hooks: [{ type: 'command', command: `\${extensionPath}/${R}` }] }] },
  });
  c.file(`${ext}/agents/agent-a.md`, agentMd('agent-a'));
  c.file(`${ext}/.env`, '');
  c.json(`${g}/extensions/extension-enablement.json`, {
    'ext-a': { overrides: [`${ROOT}/**`, `!${ROOT}/gone/**`] },
  });

  // Project scratch: <slug> = project-a (live project)
  c.file(`${tmpA}/.project_root`, `${ROOT}/project-a\n`);
  c.file(
    `${tmpA}/chats/session-2026-08-20T10-00-00-0a1b2c3d.jsonl`,
    `${JSON.stringify({ sessionId: R, messageId: 1, synthetic: true })}\n${JSON.stringify({ sessionId: R, messageId: 2, synthetic: true })}\n`,
  );
  c.file(
    `${tmpA}/chats/${SESSION_A}/session-2026-08-20T10-05-00-1b2c3d4e.jsonl`,
    `${JSON.stringify({ sessionId: R, parentSessionId: R, messageId: 1, synthetic: true })}\n`,
  );
  c.json(`${tmpA}/checkpoint-tag-a.json`, { synthetic: true });
  c.json(`${tmpA}/checkpoints/2026-08-20T10-00-00-file-a-write_file.json`, { synthetic: true });
  c.json(`${tmpA}/logs.json`, []);
  c.file(`${tmpA}/logs/session-${SESSION_A}.jsonl`, `${JSON.stringify({ sessionId: R, synthetic: true })}\n`);
  c.file(`${tmpA}/shell_history`, `${R}\n${R}\n`);
  c.file(`${tmpA}/memory/MEMORY.md`, `# Memory index\n\n${filler(8)}`);
  c.file(`${tmpA}/memory/notes-a.md`, filler(5));
  c.file(
    `${tmpA}/memory/.inbox/memory/0001.patch`,
    '--- a/MEMORY.md\n+++ b/MEMORY.md\n@@ -1,1 +1,2 @@\n - filler line 1\n+- filler line 2\n',
  );
  c.file(`${tmpA}/memory/skills/skill-a/SKILL.md`, skillMd('skill-a', 3));
  c.file(`${tmpA}/${SESSION_A}/plans/plan-a.md`, `# Plan\n\n${filler(4)}`);
  c.dir(`${tmpA}/${SESSION_A}/tasks`);
  c.dir(`${tmpA}/${SESSION_A}/tracker`);
  c.dir(`${g}/tmp/bin`);
  c.age(`${tmpA}/chats/session-2026-08-20T10-00-00-0a1b2c3d.jsonl`, 3);

  // Project scratch: gone (breadcrumb whose directory no longer exists -> orphan)
  const tmpGone = `${g}/tmp/gone`;
  c.file(`${tmpGone}/.project_root`, `${ROOT}/gone\n`);
  c.file(
    `${tmpGone}/chats/session-2026-04-01T09-00-00-2c3d4e5f.jsonl`,
    `${JSON.stringify({ sessionId: R, messageId: 1, synthetic: true })}\n`,
  );
  c.file(`${tmpGone}/memory/GEMINI.md`, filler(4)); // legacy memory index name
  c.age(`${tmpGone}/chats/session-2026-04-01T09-00-00-2c3d4e5f.jsonl`, 120);

  // Project scratch: basename collision -> project-b and project-b-1
  c.file(`${g}/tmp/project-b/.project_root`, `${ROOT}/project-b\n`);
  c.file(`${g}/tmp/project-b-1/.project_root`, `${ROOT}/nested/project-b\n`);

  // Legacy sha256 slug dir not mapped by projects.json -> stray (unresolvable)
  const tmpLegacy = `${g}/tmp/${LEGACY_SLUG}`;
  c.file(
    `${tmpLegacy}/chats/session-2025-06-01T09-00-00-3d4e5f6a.json`,
    json({ sessionId: R, messages: [], synthetic: true }),
  );
  c.age(`${tmpLegacy}/chats/session-2025-06-01T09-00-00-3d4e5f6a.json`, 400);

  // Shadow git repo for checkpoint snapshots (internals inferred, see README)
  c.git(`${g}/history/project-a`);
  c.file(`${g}/history/project-a/.gitconfig`, `[user]\n\tname = ${R}\n\temail = ${R}\n[commit]\n\tgpgsign = false\n`);
  c.age(`${g}/history/project-a/.gitconfig`, 90);

  // Root side: project-a (live, git, full project config)
  const pa = 'root/project-a';
  c.git(pa);
  c.file(`${pa}/GEMINI.md`, `${filler(5)}\n@./docs/context-import.md\n\n${filler(3)}`);
  c.file(`${pa}/docs/context-import.md`, filler(4));
  c.file(`${pa}/AGENTS.md`, filler(6));
  c.file(`${pa}/.geminiignore`, 'dist/\n*.log\n');
  c.json(`${pa}/.gemini/settings.json`, projectSettingsA);
  c.file(`${pa}/.gemini/.env`, '');
  c.file(`${pa}/.gemini/commands/proj-cmd.toml`, commandToml());
  c.file(`${pa}/.gemini/skills/skill-e/SKILL.md`, skillMd('skill-e'));
  c.file(`${pa}/.agents/skills/skill-e/SKILL.md`, skillMd('skill-e', 7));
  c.file(`${pa}/.gemini/agents/agent-c.md`, agentMd('agent-c'));
  c.json(`${pa}/.gemini/extensions/legacy-ext/gemini-extension.json`, {
    name: 'legacy-ext',
    version: '0.1.0',
    description: R,
  });
  c.file(`${pa}/packages/sub-a/GEMINI.md`, filler(4));
  c.file(`${pa}/packages/sub-a/index.txt`, `${R}\n`);

  // Root side: project-b (legacy flat settings) and nested/project-b (collision)
  c.git('root/project-b');
  c.file('root/project-b/GEMINI.md', filler(3));
  c.json('root/project-b/.gemini/settings.json', projectSettingsLegacy);
  c.git('root/nested/project-b');
  c.file('root/nested/project-b/AGENTS.md', filler(3));

  // Root side: project-c (DO_NOT_TRUST -> its .gemini/settings.json is ignored)
  c.git('root/project-c');
  c.file('root/project-c/GEMINI.md', filler(3));
  c.json('root/project-c/.gemini/settings.json', {
    mcpServers: { 'server-untrusted': { command: R } },
  });

  // root/gone is intentionally absent.
  return c;
}

// ------------------------------------------------------- zero-breadcrumbs --

function buildZeroBreadcrumbs() {
  const c = new Case('zero-breadcrumbs', README_ZERO);
  const g = 'home/.gemini';

  // Key set observed on the capture machine (research 02 "On this machine"); no value was read.
  const observedSettings = {
    ide: { hasSeenNudge: true },
    security: { auth: { selectedType: R } },
    mcpServers: { 'server-a': { type: R, url: R, headers: { Authorization: R } } },
  };

  c.file(`${g}/GEMINI.md`, ''); // 0 bytes, as observed
  c.json(`${g}/settings.json`, observedSettings);
  c.json(`${g}/settings.json.orig`, { ide: { hasSeenNudge: true }, security: { auth: { selectedType: R } } });
  c.age(`${g}/settings.json.orig`, 200);
  c.file(`${g}/installation_id`, `${R}\n`);
  c.file(`${g}/oauth_creds.json`, '');
  c.file(`${g}/google_accounts.json`, '');
  c.dir(`${g}/tmp`);

  // Vercel skills canonical store + symlink fan-out
  c.file('home/.agents/skills/find-skills/SKILL.md', skillMd('find-skills'));
  c.file('home/.agents/skills/next-best-practices/SKILL.md', skillMd('next-best-practices', 9));
  c.json('home/.agents/.skill-lock.json', skillLock);
  c.symlink(`${g}/skills/find-skills`, '../../.agents/skills/find-skills', 'dir');
  c.symlink(`${g}/skills/next-best-practices`, '../../.agents/skills/next-best-practices', 'dir');
  c.symlink(`${g}/skills/skill-gone`, '../../.agents/skills/skill-gone', 'dir'); // dangling

  // Google Antigravity IDE state (NOT Gemini CLI); protobuf files omitted
  const ag = `${g}/antigravity`;
  c.file(`${ag}/skills/skill-f/SKILL.md`, skillMd('skill-f'));
  c.file(`${ag}/global_skills/find-skills/SKILL.md`, skillMd('find-skills'));
  c.file(`${ag}/mcp_config.json`, ''); // 0 bytes, as observed
  c.file(`${ag}/installation_id`, `${R}\n`);
  c.dir(`${ag}/brain/${SESSION_B}`);
  c.dir(`${ag}/conversations`);

  // A project other harnesses know; Gemini CLI has nothing on it.
  c.git('root/project-a');
  c.file('root/project-a/AGENTS.md', filler(4));
  return c;
}

// ----------------------------------------------------------------- READMEs --

const README_FROM_DOCS = `# gemini-cli / from-docs

The complete Gemini CLI layout as documented, on a machine with three live projects, one gone
project and one legacy scratch directory. Nothing here was captured: Gemini CLI left no
breadcrumbs on the capture machine (research 09), so every file is synthesised from the
"Gemini CLI" section of \`docs/research/02-other-harnesses-on-disk-layout.md\` by
\`fixtures/_capture/gemini-cli.mjs\`. Values are \`<redacted>\`; only keys, enumerations,
filenames and path placeholders are real.

## Tree

- \`home/.gemini/\` user scope: \`GEMINI.md\` (with a legacy \`## Gemini Added Memories\` section),
  \`settings.json\` (v2 nested keys + top-level \`mcpServers\` with one stdio server, \`hooks\`,
  \`context.fileName\` = \`["GEMINI.md","AGENTS.md"]\`), \`projects.json\`, \`trustedFolders.json\`,
  \`commands/**/*.toml\`, \`skills/\`, \`agents/\`, \`extensions/ext-a/\` (+ \`extension-enablement.json\`),
  \`tmp/<slug>/\`, \`history/project-a/\`, \`installation_id\`, \`keybindings.json\`,
  \`acknowledgments/agents.json\`, and zero-byte placeholders at the secret file names
  (\`oauth_creds.json\`, \`google_accounts.json\`, \`mcp-oauth-tokens.json\`, \`.env\`).
- \`home/.agents/skills/skill-d/\`: target of the \`~/.gemini/skills/skill-d\` symlink.
- \`root/project-a/\`: git repo with \`GEMINI.md\` (one \`@./docs/context-import.md\` import),
  \`AGENTS.md\`, \`.geminiignore\`, \`.gemini/{settings.json,.env,commands,skills,agents,extensions}\`,
  \`.agents/skills/\`, nested \`packages/sub-a/GEMINI.md\`.
- \`root/project-b/\` (legacy flat settings keys), \`root/nested/project-b/\` (basename collision),
  \`root/project-c/\` (untrusted). \`root/gone/\` does not exist on purpose.

## Edge cases carried

1. Orphan breadcrumb: \`projects.json\` and \`trustedFolders.json\` name \`<ROOT>/gone\`; its
   \`tmp/gone/\` scratch exists (chat aged 120 days, legacy \`memory/GEMINI.md\` index) but the
   directory is gone.
2. Stray slug: \`tmp/0123456789abcdef…/\` (64 hex chars, the shape of a legacy \`sha256(path)\`
   directory; the digest of nothing) is not mapped by \`projects.json\` and carries no
   \`.project_root\` (legacy \`chats/*.json\`, aged 400 days).
3. Slug collision: \`<ROOT>/project-b\` -> \`project-b\`, \`<ROOT>/nested/project-b\` -> \`project-b-1\`.
4. Untrusted folder: \`<ROOT>/project-c\` is \`DO_NOT_TRUST\`, so its \`.gemini/settings.json\` (one MCP
   server) must be reported as ignored. \`TRUST_PARENT\` appears once.
5. \`context.fileName\` lists two names, so \`AGENTS.md\` is a context file for this user, at the
   project tier and for nested directories (JIT).
6. Skill precedence and duplicates: \`skill-e\` exists in both \`.gemini/skills\` and \`.agents/skills\`
   of project-a (\`.agents\` wins within the tier); \`skill-c\` is listed in \`skills.disabled\`;
   \`skill-d\` reaches \`~/.gemini/skills\` through a symlink into \`~/.agents/skills\`;
   \`tmp/project-a/memory/skills/skill-a\` is harness-owned memory, not an installed skill;
   \`extensions/ext-a/skills/skill-b\` is extension-tier.
7. MCP servers at four places: user \`settings.json\` (stdio: \`command/args/env/cwd/timeout/trust\`),
   project \`settings.json\` (\`httpUrl\` + \`headers\` + \`oauth{}\`, and \`url\` SSE with the
   service-account keys), extension manifest (\`\${extensionPath}\` variable), legacy flat project
   settings (\`server-d\`).
8. Project \`.gemini/extensions/legacy-ext/\` is present but is NOT loaded by the extension manager
   on \`main\`; only \`~/.gemini/extensions/\` counts.
9. Legacy flat keys (\`contextFileName\`, \`theme\`, \`checkpointing\`) in
   \`root/project-b/.gemini/settings.json\`.
10. Harness cache under \`tmp/project-a/\`: \`chats/\` (+ sub-agent \`chats/<parentSessionId>/\`),
    \`checkpoint-<tag>.json\`, \`checkpoints/\`, \`logs.json\` + \`logs/\`, \`shell_history\`,
    \`<sessionId>/{plans,tasks,tracker}/\` (\`tasks\`, \`tracker\` empty), \`~/.gemini/tmp/bin/\` (empty);
    shadow repo \`~/.gemini/history/project-a/\` (\`.git\` written as \`_git\`, \`.gitconfig\` aged 90 days).
11. Memory: \`tmp/project-a/memory/MEMORY.md\` index, sibling \`notes-a.md\`,
    \`memory/.inbox/memory/0001.patch\`.
12. Hooks live inside \`settings.json\` (\`hooks.<Event>[]\`) and \`<ext>/hooks/hooks.json\`; there is
    no \`.gemini/hooks/\` directory.
13. Zero-byte files at the documented secret names, so a test can assert they are never opened.

## Synthetic content

Everything. Chats, logs, checkpoints and shell history are 1-2 line JSON/JSONL/plain files with
placeholder fields (\`sessionId\`, \`messageId\`, \`synthetic: true\`); their real schema is not
documented in research 02 and the adapter only needs names, sizes and mtimes. Markdown bodies are
filler lines. Session ids are \`00000000-0000-4000-8000-00000000000N\`. No SQLite: Gemini CLI keeps none.

## fixture.json

\`renames\` (\`_git\` -> \`.git\`, four repositories under \`root/\` and the shadow repo under
\`home/.gemini/history/\`), \`symlinks\` (one; \`target\` is the link text relative to the link's parent
directory, as \`readlink\` returns it and as the Vercel skills CLI writes it), \`ages\` (four files),
\`dirs\` (three empty directories git cannot hold). No \`ages\` entry points inside a \`_git\` tree.

## Slug rule

\`~/.gemini/tmp/<slug>/\` and \`~/.gemini/history/<slug>/\` use \`slug = basename(path).toLowerCase()\`
with every character outside \`[a-z0-9]\` replaced by \`-\`; collisions get \`-1\`, \`-2\`; the mapping is
recorded in \`~/.gemini/projects.json\` (\`{"projects": {"<abs path>": "<slug>"}}\`) and each scratch
directory carries \`.project_root\`. Older installs used \`sha256(path)\` directories, auto-migrated.
Because the slug contains no path segment, the \`__HOME__\`/\`__ROOT__\` filename tokens are not
needed: the directory is literally \`tmp/project-a\`. The \`projects.json\` values are the slugs
themselves (documented), not opaque ids.

## Documentation this case depends on (research 02, Gemini CLI section)

- Context files table: \`~/.gemini/GEMINI.md\`, walk-up to \`context.memoryBoundaryMarkers\` (default
  \`[".git"]\`), JIT subdirectory loading, extension \`GEMINI.md\`, \`tmp/<slug>/memory/MEMORY.md\`
  (legacy \`memory/GEMINI.md\`), \`memory/.inbox/<kind>/*.patch\`, \`memory/skills/\` [39][40][42][56][57][58].
- \`context.fileName\` string|string[]; imports \`@./rel.md\` max depth 5; \`.geminiignore\` [43][46][56][58][66].
- Settings tiers and v2 key list; legacy flat keys; \`context.*\` sub-keys [45][46][54][55].
- \`mcpServers.<name>\` key shape and \`mcp.{allowed,excluded}\`; server names without \`_\` [46][61].
- \`.env\` discovery names [45][47][60].
- Extensions: only \`~/.gemini/extensions/<name>/\` is loaded; manifest keys;
  \`.gemini-extension-install.json\`; bundled dirs; \`extension-enablement.json\` shape [47][60].
- Skills, commands, hooks, agents tables [48][49][50][51][62][63][64][65].
- Session/state table: \`projects.json\` shape and slug rule, \`tmp/<slug>/\` contents, \`history/<slug>/\`,
  secret file names, \`trustedFolders.json\` enumeration, \`acknowledgments/agents.json\` [39][44][52][53][67][68].
- Open questions 7 and 8: legacy \`## Gemini Added Memories\` heading; v2 + top-level \`mcpServers\`.

Inferred, not stated in the docs: the content of \`.project_root\` (written as the absolute path),
the timestamp separator in \`session-<ISO ts>-<id8>\` filenames (\`:\` -> \`-\`), the internals of
\`history/<slug>/\` (\`.git/\` + a \`.gitconfig\` with \`[user]\`/\`[commit]\`), the \`{"hooks": {...}}\`
wrapper of \`<ext>/hooks/hooks.json\`, the shape of \`acknowledgments/agents.json\` and
\`keybindings.json\` (\`{}\`), and the \`type: "git"\` value in \`.gemini-extension-install.json\`.
`;

const README_ZERO = `# gemini-cli / zero-breadcrumbs

Gemini CLI installed and signed in, but never used inside a project: the exact shape research 09
found on the capture machine (\`~/.gemini\` with no \`projects.json\`, no \`trustedFolders.json\`, no
\`commands/\`, \`extensions/\` or \`history/\`, and an empty \`tmp/\`). Everything is synthesised by
\`fixtures/_capture/gemini-cli.mjs\` from the observed-shape notes in research 09 and research 02
("On this machine", \`~/.gemini/\` paragraph); no real file was opened.

## Tree

- \`home/.gemini/GEMINI.md\`: 0 bytes (as observed).
- \`home/.gemini/settings.json\`: the observed key set only (\`ide.hasSeenNudge\`,
  \`security.auth.selectedType\`, \`mcpServers.<name>.{type,url,headers.Authorization}\`), plus
  \`settings.json.orig\` (rotating backup, aged 200 days).
- \`home/.gemini/skills/\`: three symlinks into \`~/.agents/skills/\` (declared in \`fixture.json\`),
  one of them dangling (\`skill-gone\`).
- \`home/.agents/\`: Vercel skills canonical store (\`skills/<name>/SKILL.md\`, \`.skill-lock.json\`).
- \`home/.gemini/antigravity/\`: Google Antigravity IDE state (\`skills/\`, \`global_skills/\`,
  zero-byte \`mcp_config.json\`, \`installation_id\`, empty \`brain/<uuid>/\` and \`conversations/\`).
- \`home/.gemini/tmp/\`: empty (\`dirs\` in \`fixture.json\`).
- \`root/project-a/\`: a git repo with \`AGENTS.md\` and no Gemini configuration.

## Edge cases carried

1. Zero breadcrumbs: the adapter must yield no projects and no strays, and must not treat the
   home directory or \`~/.gemini\` as a project.
2. Symlink fan-out: \`~/.gemini/skills/<n>\` -> \`../../.agents/skills/<n>\` must dedupe against the
   canonical store instead of reporting duplicates; the dangling \`skill-gone\` link is an orphan.
3. \`~/.gemini/antigravity/\` is not Gemini CLI: its \`skills/\` and \`global_skills/find-skills\`
   (a third copy of a public skill) belong to Antigravity; \`mcp_config.json\` there is not a Gemini
   MCP config.
4. The observed \`settings.json\` mixes v2 nested keys with top-level \`mcpServers\` and carries a
   remote server whose \`headers.Authorization\` is a secret.
5. \`settings.json.orig\` is a backup file next to the live one (harness cache candidate).
6. Secret files (\`oauth_creds.json\`, \`google_accounts.json\`) are zero-byte placeholders.

## Synthetic content

Everything; the real files were never opened. The \`type\` value of the observed MCP server is
unknown and therefore \`<redacted>\` rather than an enumeration. Skill names \`find-skills\` and
\`next-best-practices\` are public open-source skill names; bodies are filler lines.

## fixture.json

\`renames\` (one), \`symlinks\` (three; \`target\` is the link text relative to the link's parent
directory), \`ages\` (one), \`dirs\` (three empty directories).

## Slug rule

Same as \`from-docs\` (\`basename\` lowercased, non-\`[a-z0-9]\` -> \`-\`, \`-1\`/\`-2\` on collision,
mapped in \`projects.json\`); no slug directory exists in this case.

## Documentation this case depends on

- Research 09: "Gemini CLI has no \`projects.json\`, no \`trustedFolders.json\` and an empty \`tmp/\`:
  zero"; \`~/.gemini/GEMINI.md\` exists but is 0 bytes; \`~/.gemini\` is user scope, never a root.
- Research 02 "On this machine": \`~/.gemini/\` entries and \`settings.json\` key names, \`skills/\`
  symlinks to \`../../.agents/skills/\`, Antigravity subtree, \`~/.agents/.skill-lock.json\` shape;
  open question 12 (Antigravity is opaque app state); open question 11 (symlink dedupe).
`;

// ------------------------------------------------------------------ write --

const USERNAME = homedir().split(/[\\/]/).filter(Boolean).pop() ?? '';
const FORBIDDEN = [
  ['absolute-home-path', /\/(Users|home)\//],
  ['url', /https?:\/\//i],
  ['email', /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/],
  ['token-prefix', /\b(sk|ya29|ghp|gho|xox[abp]|AIza)[-_][A-Za-z0-9]{8,}/],
  ['long-base64', /[A-Za-z0-9+/]{48,}={0,2}/],
];

function writeCase(c) {
  const dir = join(OUT, c.name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of c.files) {
    const abs = join(dir, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  writeFileSync(join(dir, 'fixture.json'), json(c.fixture()));
  writeFileSync(join(dir, 'README.md'), c.readme);
  return dir;
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

/** Re-reads the generated case (never a real file) and rejects anything that looks identifying. */
function lint(dir) {
  const files = walk(dir);
  let bytes = 0;
  const problems = [];
  for (const abs of files) {
    bytes += statSync(abs).size;
    const text = readFileSync(abs, 'utf8').split(LEGACY_SLUG).join('');
    for (const [label, re] of FORBIDDEN) {
      if (re.test(text)) problems.push(`${label}: ${abs}`);
    }
    if (USERNAME && text.toLowerCase().includes(USERNAME.toLowerCase())) problems.push(`username: ${abs}`);
  }
  return { files: files.length, bytes, problems };
}

/** `--check`: names only, depth <= 2, never inside antigravity/. Prints presence and counts. */
function check() {
  const gemini = join(homedir(), '.gemini');
  const names = existsSync(gemini) ? readdirSync(gemini) : [];
  const documented = [
    'GEMINI.md', 'settings.json', 'projects.json', 'trustedFolders.json', 'commands',
    'extensions', 'history', 'tmp', 'skills', 'agents', 'policies', 'acknowledgments',
  ];
  console.log(`~/.gemini entries: ${names.length}`);
  for (const name of documented) console.log(`  ${name}: ${names.includes(name) ? 'present' : 'absent'}`);
  const tmp = join(gemini, 'tmp');
  const tmpEntries = existsSync(tmp) ? readdirSync(tmp) : [];
  console.log(`  tmp/ entries (slug dirs): ${tmpEntries.length}`);
}

function main() {
  if (process.argv.includes('--check')) {
    check();
    return;
  }
  mkdirSync(OUT, { recursive: true });
  let failed = false;
  for (const build of [buildFromDocs, buildZeroBreadcrumbs]) {
    const c = build();
    const dir = writeCase(c);
    const { files, bytes, problems } = lint(dir);
    const rel = posix.join('fixtures', 'gemini-cli', c.name);
    console.log(
      `${rel}: ${files} files, ${bytes} bytes, ${c.renames.length} renames, ${c.symlinks.length} symlinks, ${c.ages.length} ages, ${c.dirs.length} dirs`,
    );
    if (bytes > MAX_CASE_BYTES) {
      console.log('  over the 300 KB budget');
      failed = true;
    }
    for (const p of problems) {
      console.log(`  forbidden pattern ${p}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}

main();
