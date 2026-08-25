#!/usr/bin/env node
// Regenerates fixtures/opencode/<case>/ from this machine (OpenCode harness).
//
// Reproducible, dependency-free (node: built-ins only), idempotent: it deletes and
// recreates ONLY the case directories it owns. It reads structure from the real
// OpenCode files (JSON keys, Markdown line/byte counts, SQLite DDL) and writes
// anonymised trees per fixtures/README.md. It never copies a value, a transcript
// or a database row, and it prints only counts and fixture paths.
//
// Sources touched (read-only): ~/.config/opencode/{opencode.json,skill/**},
// ~/.local/share/opencode/opencode.db (mode=ro, sqlite_master only). The legacy JSON
// store (storage/project, storage/session, storage/message) is never opened: those files
// are written from the documented shape. Nothing named *auth*, *mcp* … is opened; MCP
// entries are synthesised from the documented shape.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..');
const HOME = homedir();
const SRC_CONFIG = join(HOME, '.config', 'opencode');
const SRC_DATA = join(HOME, '.local', 'share', 'opencode');

const REDACTED = '<redacted>';
const SYNTH_EPOCH_MS = 1_700_000_000_000; // fixed synthetic timestamp (2023-11-14T22:13:20Z)
const SAFE_KEY = /^[A-Za-z0-9_$.-]{1,40}$/;
const OPAQUE_KEY = /^[0-9a-f]{16,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9]{8,}$/i; // hashes, uuids, timestamps used as keys are values in disguise
const PUBLIC_SKILLS = new Set(['vercel-react-best-practices', 'web-design-guidelines', 'find-skills']);
const FORBIDDEN = /mcp|auth|oauth|cred|secret|token|key|\.env|google_accounts/i;

// Synthetic ids: repeated digits, never a hash of a real thing. The real ids are 40-hex.
const ID_PROJECT_A = '1'.repeat(40);
const ID_GONE = '2'.repeat(40);
const ID_HOME = '3'.repeat(40);

// Embedded snapshot of the DDL (OpenCode 1.17.9, read 2026-08-25) used only when the
// real database is not on the machine running this script.
const DDL_FALLBACK = {
  project: 'CREATE TABLE `project` (\n\t`id` text PRIMARY KEY,\n\t`worktree` text NOT NULL,\n\t`vcs` text,\n\t`name` text,\n\t`icon_url` text,\n\t`icon_color` text,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\t`time_initialized` integer,\n\t`sandboxes` text NOT NULL\n, `commands` text, `icon_url_override` text)',
  project_directory: 'CREATE TABLE "project_directory" (\n          `project_id` text NOT NULL,\n          `directory` text NOT NULL,\n          `type` text,\n          `strategy` text,\n          `time_created` integer NOT NULL,\n          CONSTRAINT `project_directory_pk` PRIMARY KEY(`project_id`, `directory`),\n          CONSTRAINT `fk_project_directory_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE\n        )',
  session: 'CREATE TABLE `session` (\n\t`id` text PRIMARY KEY,\n\t`project_id` text NOT NULL,\n\t`parent_id` text,\n\t`slug` text NOT NULL,\n\t`directory` text NOT NULL,\n\t`title` text NOT NULL,\n\t`version` text NOT NULL,\n\t`share_url` text,\n\t`summary_additions` integer,\n\t`summary_deletions` integer,\n\t`summary_files` integer,\n\t`summary_diffs` text,\n\t`revert` text,\n\t`permission` text,\n\t`time_created` integer NOT NULL,\n\t`time_updated` integer NOT NULL,\n\t`time_compacting` integer,\n\t`time_archived` integer, `workspace_id` text, `path` text, `agent` text, `model` text, `cost` real DEFAULT 0 NOT NULL, `tokens_input` integer DEFAULT 0 NOT NULL, `tokens_output` integer DEFAULT 0 NOT NULL, `tokens_reasoning` integer DEFAULT 0 NOT NULL, `tokens_cache_read` integer DEFAULT 0 NOT NULL, `tokens_cache_write` integer DEFAULT 0 NOT NULL, `metadata` text,\n\tCONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE\n)',
  workspace: 'CREATE TABLE "workspace" (\n          `id` text PRIMARY KEY,\n          `type` text NOT NULL,\n          `name` text DEFAULT \'\' NOT NULL,\n          `branch` text,\n          `directory` text,\n          `extra` text,\n          `project_id` text NOT NULL, `time_used` integer NOT NULL DEFAULT 0,\n          CONSTRAINT `fk_workspace_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE\n        )',
  indexes: [
    'CREATE INDEX `session_project_idx` ON `session` (`project_id`)',
    'CREATE INDEX `session_parent_idx` ON `session` (`parent_id`)',
    'CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`)',
  ],
};
const DISCOVERY_TABLES = ['project', 'session', 'project_directory', 'workspace'];

// ---------------------------------------------------------------- helpers

function assertReadable(path) {
  if (FORBIDDEN.test(relative(HOME, path))) throw new Error('refusing to open a file matching the forbidden name list');
}

/** Walk a parsed JSON structure keeping only keys, booleans, null and small integers. */
function redact(value, path = []) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) < 1000 ? value : SYNTH_EPOCH_MS;
  if (typeof value === 'string') return REDACTED;
  if (Array.isArray(value)) return value.slice(0, 3).map((v, i) => redact(v, [...path, i]));
  if (typeof value === 'object') {
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      const key = SAFE_KEY.test(k) && !OPAQUE_KEY.test(k) ? k : `${REDACTED}-${++n}`;
      out[key] = redact(v, [...path, key]);
    }
    return out;
  }
  return REDACTED;
}

function readJsonRedacted(path, fallback) {
  try {
    assertReadable(path);
    if (!existsSync(path)) return { value: fallback, live: false };
    return { value: redact(JSON.parse(readFileSync(path, 'utf8'))), live: true };
  } catch {
    return { value: fallback, live: false };
  }
}

/** Neutral filler: `lines` lines totalling roughly `bytes` bytes. Never copies text. */
function filler(lines, bytes, start = 1) {
  const out = [];
  const perLine = Math.max(4, Math.floor(bytes / Math.max(lines, 1)));
  for (let i = 0; i < lines; i++) {
    let line = `- filler line ${start + i}`;
    while (line.length + 1 < perLine) line += ' filler';
    out.push(line);
  }
  return out.join('\n') + (lines > 0 ? '\n' : '');
}

/**
 * Mirror a Markdown file: frontmatter KEYS survive with `<redacted>` values (a public
 * skill `name` may stay, otherwise `skill-a`), the body is filler with the same line
 * count and roughly the same byte size. `fallback` = {keys, lines, bytes} is used when
 * the real file is absent.
 */
function mirrorMarkdown(srcPath, { fallback, skillName } = {}) {
  let keys = fallback?.keys ?? [];
  let bodyLines = fallback?.lines ?? 20;
  let bodyBytes = fallback?.bytes ?? 600;
  let live = false;
  try {
    assertReadable(srcPath);
    if (existsSync(srcPath)) {
      const text = readFileSync(srcPath, 'utf8');
      const lines = text.split('\n');
      let bodyStart = 0;
      if (lines[0] === '---') {
        const end = lines.indexOf('---', 1);
        if (end > 0) {
          keys = lines.slice(1, end).map((l) => l.match(/^([A-Za-z0-9_-]+):/)?.[1]).filter(Boolean);
          bodyStart = end + 1;
        }
      }
      const body = lines.slice(bodyStart);
      bodyLines = body.length - (body.at(-1) === '' ? 1 : 0);
      bodyBytes = Buffer.byteLength(body.join('\n'), 'utf8');
      live = true;
    }
  } catch {
    /* fall back to the synthetic spec */
  }
  let fm = '';
  if (keys.length) {
    fm = '---\n';
    for (const k of keys) {
      const v = k === 'name' && skillName ? (PUBLIC_SKILLS.has(skillName) ? skillName : 'skill-a') : REDACTED;
      fm += `${k}: ${v}\n`;
    }
    fm += '---\n';
  }
  return { text: fm + filler(bodyLines, bodyBytes), live };
}

class CaseWriter {
  constructor(dir) {
    this.dir = dir;
    this.files = 0;
    this.bytes = 0;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  write(rel, content) {
    const abs = join(this.dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.files++;
    this.bytes += statSync(abs).size;
  }
  json(rel, value) {
    this.write(rel, JSON.stringify(value, null, 2) + '\n');
  }
}

// ---------------------------------------------------------------- SQLite

function readDdl() {
  const dbPath = join(SRC_DATA, 'opencode.db');
  if (!existsSync(dbPath)) return { ddl: DDL_FALLBACK, live: false };
  let db;
  try {
    db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
    const rows = db
      .prepare("select type, name, tbl_name, sql from sqlite_master where sql is not null and tbl_name in (?,?,?,?) order by tbl_name, type desc, name")
      .all(...DISCOVERY_TABLES);
    const ddl = { indexes: [] };
    for (const r of rows) {
      if (r.type === 'table') ddl[r.tbl_name] = r.sql;
      else if (r.type === 'index') ddl.indexes.push(r.sql);
    }
    for (const t of DISCOVERY_TABLES) if (!ddl[t]) throw new Error('missing table');
    return { ddl, live: true, inSync: ddlEqual(ddl, DDL_FALLBACK) };
  } catch {
    return { ddl: DDL_FALLBACK, live: false };
  } finally {
    db?.close();
  }
}

/** True when the embedded fallback still matches the database (tables verbatim, indexes as a set). */
function ddlEqual(a, b) {
  return DISCOVERY_TABLES.every((t) => a[t] === b[t]) && [...a.indexes].sort().join('\n') === [...b.indexes].sort().join('\n');
}

function buildDatabase(path, ddl) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA page_size = 1024');
  db.exec('PRAGMA journal_mode = DELETE');
  for (const t of DISCOVERY_TABLES) db.exec(ddl[t]);
  for (const ix of ddl.indexes) db.exec(ix);

  const T = SYNTH_EPOCH_MS;
  const insProject = db.prepare(
    'INSERT INTO project (id, worktree, vcs, name, icon_url, icon_color, time_created, time_updated, time_initialized, sandboxes, commands, icon_url_override) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
  );
  insProject.run('global', '/', null, null, null, null, T - 86_400_000 * 120, T - 86_400_000 * 5, null, '[]', null, null);
  insProject.run(ID_PROJECT_A, '<ROOT>/project-a', 'git', REDACTED, null, null, T - 86_400_000 * 60, T, T - 86_400_000 * 60, '[]', null, null);
  insProject.run(ID_GONE, '<ROOT>/gone', 'git', REDACTED, null, null, T - 86_400_000 * 200, T - 86_400_000 * 150, null, '[]', null, null);
  insProject.run(ID_HOME, '<HOME>', null, null, null, null, T - 86_400_000 * 30, T - 86_400_000 * 30, null, '[]', null, null);

  const insSession = db.prepare(
    'INSERT INTO session (id, project_id, parent_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?,?,?,?)',
  );
  insSession.run('ses_synthetic0001', ID_PROJECT_A, null, REDACTED, '<ROOT>/project-a', REDACTED, '1.17.9', T - 3_600_000, T, null);
  insSession.run('ses_synthetic0002', ID_PROJECT_A, 'ses_synthetic0001', REDACTED, '<ROOT>/project-a/packages/api', REDACTED, '1.17.9', T - 1_800_000, T, null);
  insSession.run('ses_synthetic0003', ID_GONE, null, REDACTED, '<ROOT>/gone', REDACTED, '1.17.9', T - 86_400_000 * 150, T - 86_400_000 * 150, null);
  insSession.run('ses_synthetic0004', ID_HOME, null, REDACTED, '<HOME>', REDACTED, '1.17.9', T - 86_400_000 * 30, T - 86_400_000 * 30, T - 86_400_000 * 29);

  db.prepare('INSERT INTO project_directory (project_id, directory, type, strategy, time_created) VALUES (?,?,?,?,?)').run(
    ID_PROJECT_A,
    '<ROOT>/project-a/packages/api',
    null,
    null,
    T,
  );
  // workspace: intentionally 0 rows (as observed on this machine).
  db.exec('VACUUM');
  db.close();
  return statSync(path).size;
}

// ---------------------------------------------------------------- synthetic blocks

const MCP_SYNTHETIC = {
  'server-local': { type: 'local', command: [REDACTED, REDACTED], cwd: '<HOME>', environment: { EXAMPLE_VAR: REDACTED }, enabled: true },
  'server-remote': { type: 'remote', url: REDACTED, headers: { Authorization: REDACTED }, enabled: true, timeout: 5000 },
};

function userConfig() {
  // Real top-level keys survive (values redacted); `mcp` is never captured but
  // replaced by the documented synthetic shape; `instructions` is added.
  const { value, live } = readJsonRedacted(join(SRC_CONFIG, 'opencode.json'), { $schema: REDACTED, mcp: {} });
  const out = {};
  for (const k of Object.keys(value)) out[k] = k === 'mcp' ? MCP_SYNTHETIC : value[k];
  if (!('mcp' in out)) out.mcp = MCP_SYNTHETIC;
  out.instructions = ['<HOME>/.config/opencode/rules/*.md', '<HOME>/.config/opencode/style.md'];
  return { value: out, live };
}

function legacyProjectJson(kind) {
  // Documented shape only: the real storage/project/<id>.json files are never opened
  // (session-adjacent metadata is outside the parse allowlist). Field names follow the
  // OpenCode legacy JSON store as described in docs/research/02; every value is synthetic.
  if (kind === 'global') return { id: 'global', worktree: '/', time: { created: SYNTH_EPOCH_MS, updated: SYNTH_EPOCH_MS }, sandboxes: [] };
  return { id: ID_PROJECT_A, worktree: '<ROOT>/project-a', vcs: 'git', time: { created: SYNTH_EPOCH_MS, updated: SYNTH_EPOCH_MS, initialized: SYNTH_EPOCH_MS }, sandboxes: [] };
}

function legacySessionJson() {
  // Documented shape only: no real storage/session/*/ses_*.json is opened (session metadata).
  return { id: 'ses_synthetic0001', projectID: ID_PROJECT_A, directory: '<ROOT>/project-a', title: REDACTED, version: '1.17.9', time: { created: SYNTH_EPOCH_MS, updated: SYNTH_EPOCH_MS } };
}

// ---------------------------------------------------------------- case: db-and-config

function caseDbAndConfig() {
  const dir = join(FIXTURES, 'opencode', 'db-and-config');
  const w = new CaseWriter(dir);
  const live = {};

  // ---- home/.config/opencode (user scope)
  const cfg = userConfig();
  live.userConfig = cfg.live;
  w.json('home/.config/opencode/opencode.json', cfg.value);
  w.write('home/.config/opencode/AGENTS.md', filler(12, 480));
  w.write('home/.config/opencode/rules/rule-a.md', filler(6, 200));
  w.write('home/.config/opencode/style.md', filler(4, 120));
  w.json('home/.config/opencode/package.json', { dependencies: { '@opencode-ai/plugin': REDACTED } });
  w.write('home/.config/opencode/.gitignore', 'node_modules\n');
  w.json('home/.config/opencode/bun.lock', { lockfileVersion: 1, workspaces: { '': { dependencies: { '@opencode-ai/plugin': REDACTED } } }, packages: {} });
  w.json('home/.config/opencode/package-lock.json', { name: REDACTED, lockfileVersion: 3, packages: {} });
  w.write('home/.config/opencode/agents/agent-a.md', '---\ndescription: <redacted>\nmode: subagent\nmodel: <redacted>\ntemperature: 0.1\n---\n' + filler(5, 160));
  w.write('home/.config/opencode/commands/command-a.md', '---\ndescription: <redacted>\nagent: agent-a\nsubtask: true\n---\n' + filler(4, 120));

  // Older-generation real skill copies under singular `skill/` (Vercel skills CLI, Jan–Feb 2026).
  const vr = join(SRC_CONFIG, 'skill', 'vercel-react-best-practices');
  const skillMd = mirrorMarkdown(join(vr, 'SKILL.md'), { skillName: 'vercel-react-best-practices', fallback: { keys: ['name', 'description'], lines: 120, bytes: 5200 } });
  live.skillMd = skillMd.live;
  w.write('home/.config/opencode/skill/vercel-react-best-practices/SKILL.md', skillMd.text);
  const payloadAgents = mirrorMarkdown(join(vr, 'AGENTS.md'), { fallback: { keys: [], lines: 2249, bytes: 60500 } });
  live.payloadAgents = payloadAgents.live;
  w.write('home/.config/opencode/skill/vercel-react-best-practices/AGENTS.md', payloadAgents.text);
  const readme = mirrorMarkdown(join(vr, 'README.md'), { fallback: { keys: [], lines: 123, bytes: 3360 } });
  w.write('home/.config/opencode/skill/vercel-react-best-practices/README.md', readme.text);
  const meta = readJsonRedacted(join(vr, 'metadata.json'), { name: REDACTED, version: REDACTED });
  live.metadata = meta.live;
  w.json('home/.config/opencode/skill/vercel-react-best-practices/metadata.json', meta.value);
  w.write('home/.config/opencode/skill/vercel-react-best-practices/rules/rule-a.md', filler(20, 700));
  w.write('home/.config/opencode/skill/vercel-react-best-practices/rules/rule-b.md', filler(20, 700));
  const wd = mirrorMarkdown(join(SRC_CONFIG, 'skill', 'web-design-guidelines', 'SKILL.md'), { skillName: 'web-design-guidelines', fallback: { keys: ['name', 'description'], lines: 34, bytes: 1100 } });
  live.webDesign = wd.live;
  w.write('home/.config/opencode/skill/web-design-guidelines/SKILL.md', wd.text);

  // Newer generation: `skills/` holds symlinks into ~/.agents/skills (declared in fixture.json).
  w.write('home/.agents/skills/find-skills/SKILL.md', '---\nname: find-skills\ndescription: <redacted>\n---\n' + filler(18, 640));
  w.json('home/.agents/.skill-lock.json', { version: 1, skills: { 'find-skills': { source: REDACTED, sourceType: REDACTED, sourceUrl: REDACTED, skillPath: REDACTED, skillFolderHash: REDACTED, installedAt: REDACTED, updatedAt: REDACTED } }, dismissed: { findSkillsPrompt: false }, lastSelectedAgents: ['opencode'] });

  // ---- home/.local/share/opencode (data)
  const { ddl, live: ddlLive, inSync } = readDdl();
  live.ddl = ddlLive;
  live.ddlFallbackInSync = inSync;
  const dbBytes = buildDatabase(join(dir, 'home/.local/share/opencode/opencode.db'), ddl);
  w.files++;
  w.bytes += dbBytes;
  w.write('home/.local/share/opencode/opencode.db-wal', '');
  w.json('home/.local/share/opencode/storage/project/global.json', legacyProjectJson('global'));
  w.json(`home/.local/share/opencode/storage/project/${ID_PROJECT_A}.json`, legacyProjectJson('project'));
  w.json(`home/.local/share/opencode/storage/session/${ID_PROJECT_A}/ses_synthetic0001.json`, legacySessionJson());
  w.json('home/.local/share/opencode/storage/message/ses_synthetic0001/msg_synthetic0001.json', { id: 'msg_synthetic0001', sessionID: 'ses_synthetic0001', role: 'user', time: { created: SYNTH_EPOCH_MS } });

  // ---- root/ (projects side)
  w.write('root/project-a/_git/HEAD', 'ref: refs/heads/main\n');
  w.json('root/project-a/opencode.json', {
    $schema: REDACTED,
    instructions: ['docs/*.md', '<ROOT>/project-a/docs/rules.md'],
    mcp: { 'project-server': { type: 'local', command: [REDACTED], enabled: true } },
    permission: { skill: 'allow' },
  });
  w.write('root/project-a/AGENTS.md', filler(24, 960));
  w.write('root/project-a/docs/rules.md', filler(8, 280));
  w.write('root/project-a/packages/api/AGENTS.md', filler(6, 200));
  w.write('root/project-a/.opencode/agents/agent-a.md', '---\ndescription: <redacted>\nmode: primary\nmodel: <redacted>\npermission:\n  edit: ask\ntemperature: 0.2\n---\n' + filler(5, 160));
  w.write('root/project-a/.opencode/commands/command-a.md', '---\ndescription: <redacted>\nagent: agent-a\nmodel: <redacted>\nsubtask: false\n---\n' + filler(4, 120));
  w.write('root/project-a/.opencode/skills/skill-a/SKILL.md', '---\nname: skill-a\ndescription: <redacted>\n---\n' + filler(10, 360));
  w.write('root/project-a/.opencode/skill/web-design-guidelines/SKILL.md', wd.text);
  w.write('root/project-a/.claude/skills/web-design-guidelines/SKILL.md', wd.text);
  w.json('root/project-a/.opencode/package.json', { dependencies: { '@opencode-ai/plugin': REDACTED } });
  w.write('root/project-a/.opencode/.gitignore', 'node_modules\n');
  w.json('root/project-a/.opencode/bun.lock', { lockfileVersion: 1, workspaces: { '': { dependencies: { '@opencode-ai/plugin': REDACTED } } }, packages: {} });

  w.write('root/project-b/_git/HEAD', 'ref: refs/heads/main\n');
  w.write('root/project-b/opencode.jsonc', '{\n  // JSONC: comments and a trailing comma are legal here\n  "$schema": "<redacted>",\n  "instructions": ["CONTRIBUTING.md"],\n}\n');
  w.write('root/project-b/CLAUDE.md', filler(10, 400));
  w.write('root/project-b/CONTRIBUTING.md', filler(5, 160));

  // ---- fixture.json
  const fixture = {
    renames: [
      { from: 'root/project-a/_git', to: 'root/project-a/.git' },
      { from: 'root/project-b/_git', to: 'root/project-b/.git' },
    ],
    symlinks: [{ path: 'home/.config/opencode/skills/find-skills', target: '../../../.agents/skills/find-skills', kind: 'dir' }],
    ages: [
      { path: 'home/.local/share/opencode/storage/project/global.json', ageDays: 155 },
      { path: `home/.local/share/opencode/storage/project/${ID_PROJECT_A}.json`, ageDays: 155 },
      { path: `home/.local/share/opencode/storage/session/${ID_PROJECT_A}/ses_synthetic0001.json`, ageDays: 155 },
      { path: 'home/.local/share/opencode/storage/message/ses_synthetic0001/msg_synthetic0001.json', ageDays: 155 },
      { path: 'home/.config/opencode/skill/vercel-react-best-practices/SKILL.md', ageDays: 200 },
      { path: 'home/.config/opencode/skill/web-design-guidelines/SKILL.md', ageDays: 200 },
      { path: 'home/.local/share/opencode/opencode.db', ageDays: 0 },
    ],
    dirs: [
      'home/.config/opencode/skills',
      'home/.config/opencode/context-mode/sessions',
      'home/.cache/opencode/bin',
      'home/.local/share/opencode/bin',
      'home/.local/share/opencode/log',
      'home/.local/share/opencode/repos',
      'home/.local/share/opencode/snapshot',
      'home/.local/share/opencode/tool-output',
      'home/.local/share/opencode/storage/part',
      'home/.local/share/opencode/storage/session_diff',
      'home/.local/share/opencode/storage/migration',
    ],
    sqlite: [
      {
        path: 'home/.local/share/opencode/opencode.db',
        rewrite: [
          { table: 'project', column: 'worktree' },
          { table: 'session', column: 'directory' },
          { table: 'project_directory', column: 'directory' },
          { table: 'workspace', column: 'directory' },
        ],
      },
    ],
  };
  w.json('fixture.json', fixture);

  // ---- README.md (generated so the DDL section stays in sync)
  w.write('README.md', caseReadme(ddl, ddlLive));

  return { dir, files: w.files, bytes: w.bytes, dbBytes, live };
}

function caseReadme(ddl, ddlLive) {
  const ddlBlock = [ddl.project, ddl.session, ddl.project_directory, ddl.workspace, ...ddl.indexes].join(';\n\n') + ';\n';
  return `# opencode / db-and-config

An OpenCode 1.x install as found on a developer Mac in 2026: a user config with MCP
servers and instructions, both generations of skill directories, a project database
(\`opencode.db\`) that still names directories that no longer exist, the legacy JSON
store it superseded, and two projects under the root. Generated by
\`fixtures/_capture/opencode.mjs\`; every value is redacted or synthetic.

## Layout

\`home/\` (the user's home)

- \`.config/opencode/opencode.json\` — real top-level keys, values redacted. The \`mcp\` map is
  **synthetic** (one \`type: local\`, one \`type: remote\`, documented shape) and \`instructions\`
  is added with \`<HOME>\` placeholders that resolve to \`rules/rule-a.md\` and \`style.md\`.
- \`.config/opencode/AGENTS.md\` — user-scope rules file (documented; synthetic, this machine has none).
- \`.config/opencode/agents/agent-a.md\`, \`commands/command-a.md\` — documented frontmatter keys, synthetic.
- \`.config/opencode/skill/\` (**singular**, older Vercel-skills generation, real copies):
  \`vercel-react-best-practices/{SKILL.md,AGENTS.md,README.md,metadata.json,rules/}\` and
  \`web-design-guidelines/SKILL.md\`. Markdown bodies are filler with the original line count and
  byte size; \`rules/\` holds 2 filler files where the real one holds 47.
- \`.config/opencode/skills/\` (**plural**, newer generation): only a symlink
  \`find-skills -> ../../../.agents/skills/find-skills\` declared in \`fixture.json\` (\`target\` is the
  link text relative to the link's parent directory, as on disk); the target
  lives in \`home/.agents/skills/\` next to a \`.skill-lock.json\` with the documented keys.
- \`.config/opencode/{package.json,bun.lock,package-lock.json,.gitignore}\` — the plugin workspace
  OpenCode creates; a scanner must not take \`~/.config/opencode\` for a project.
- \`.local/share/opencode/opencode.db\` — tiny SQLite built from the real DDL (below) with synthetic
  rows; \`opencode.db-wal\` is an empty sidecar as on the real machine (the real DB runs in WAL mode).
- \`.local/share/opencode/storage/project/{global.json,1111….json}\` and
  \`storage/session/1111…/ses_synthetic0001.json\` — legacy JSON store written from the documented shape (no real file opened),
  values replaced. \`storage/message/…\` holds one synthetic 4-key message (no transcript was copied).
- Empty directories (\`bin/\`, \`log/\`, \`repos/\`, \`snapshot/\`, \`tool-output/\`, \`storage/{part,session_diff,migration}\`,
  \`context-mode/sessions\`, \`~/.cache/opencode/bin\`) are declared under \`dirs\` in \`fixture.json\`.
- Not present on purpose: \`auth.json\`, \`mcp-auth.json\`, \`~/.opencode\`, \`~/.claude/CLAUDE.md\`.

\`root/\` (the projects side)

- \`project-a/\` — git repository (\`_git/HEAD\` → \`.git/HEAD\`), \`opencode.json\` with \`instructions\`
  (a relative glob and an absolute \`<ROOT>\` path, both resolving to \`docs/rules.md\`), a project
  \`mcp\` entry and \`permission.skill\`; root \`AGENTS.md\` plus a nested \`packages/api/AGENTS.md\`;
  \`.opencode/{agents,commands,skills/skill-a,skill/web-design-guidelines,package.json,bun.lock,.gitignore}\`;
  \`.claude/skills/web-design-guidelines\` duplicates the \`.opencode/skill\` copy.
- \`project-b/\` — git repository with \`opencode.jsonc\` (comment + trailing comma), no \`AGENTS.md\`
  but a \`CLAUDE.md\` (fallback), not recorded in the database.
- \`gone/\` — does not exist; only the database names it.

## Edge cases carried

1. Database worktrees: \`<ROOT>/project-a\` (exists, \`vcs = git\`), \`<ROOT>/gone\` (ghost), \`<HOME>\`
   (home recorded as a project, no vcs) and \`/\` (id \`global\`, no vcs).
2. A session whose \`directory\` is a subdirectory of its project (\`packages/api\`) and that is a
   child session (\`parent_id\` set); \`project_directory\` names the same subdirectory.
3. A session with \`time_archived\` set; \`workspace\` has 0 rows.
4. Legacy JSON ids are a subset of the database ids (both name \`1111…\` and \`global\`).
5. Both skill directory generations at user scope (\`skill/\` real copies, \`skills/\` symlinks into
   \`~/.agents/skills\`) and at project scope (\`.opencode/skill\` and \`.opencode/skills\`).
6. An \`AGENTS.md\` (60 KB) and a \`README.md\` inside a skill payload: not context files.
7. The same skill in \`.opencode/skill/\` and \`.claude/skills/\` of one project (duplicate).
8. JSONC project config; \`CLAUDE.md\`-only project; nested \`AGENTS.md\`; \`instructions\` with a glob
   and an absolute placeholder path.
9. \`~/.config/opencode\` carries \`package.json\`/\`.gitignore\`/lockfiles but is not a project.
10. Ages: legacy store 155 days old, singular \`skill/\` copies 200 days old, database fresh.

## What is synthetic

Everything that is not a key name, a directory name, a line count or a byte size: the \`mcp\`
maps, \`instructions\`, every Markdown body, \`AGENTS.md\`/\`CLAUDE.md\`/rules/agents/commands files,
\`.skill-lock.json\`, package/lock files, the message file, every database row, ids
(\`1111…\`, \`2222…\`, \`3333…\`, \`ses_synthetic000N\`) and timestamps (fixed epoch 1700000000000 ms
minus round day offsets). The session \`version\` column carries \`1.17.9\`, the OpenCode version
observed on the source machine.

## Slug rule

OpenCode has no path-derived slug directories: nothing in the tree is named after a project
path, so \`__HOME__\`/\`__ROOT__\` are not used. Projects are keyed by an opaque 40-hex \`id\`
(\`global\` for \`/\`) and paths appear verbatim in \`project.worktree\`, \`session.directory\`,
\`project_directory.directory\`, \`workspace.directory\` and in the legacy JSON fields \`worktree\`
and \`directory\`. Inside the database the placeholders \`<ROOT>\`/\`<HOME>\` cannot be rewritten
textually; \`fixture.json\` lists the table/column pairs to \`UPDATE\` under \`sqlite\`.

## Database DDL

Read from \`sqlite_master\` of the real \`opencode.db\` (opened \`?mode=ro\`)${ddlLive ? '' : ' — fallback snapshot used at generation time'}.
Rows: \`project\` 4, \`session\` 4, \`project_directory\` 1, \`workspace\` 0.

\`\`\`sql
${ddlBlock}\`\`\`
`;
}

// ---------------------------------------------------------------- main

const result = caseDbAndConfig();
const rel = relative(process.cwd(), result.dir) || result.dir;
console.log(`case ${rel}: ${result.files} files, ${result.bytes} bytes (sqlite ${result.dbBytes} bytes)`);
const liveFlags = Object.entries(result.live).filter(([k]) => k !== 'ddlFallbackInSync');
console.log(`sources live: ${liveFlags.filter(([, v]) => v).length}/${liveFlags.length} (ddl ${result.live.ddl ? 'from database' : 'from fallback'}; embedded fallback in sync: ${result.live.ddl ? (result.live.ddlFallbackInSync ? 'yes' : 'NO') : 'n/a'})`);
if (result.bytes > 300 * 1024) throw new Error('case exceeds 300 KB');
if (result.dbBytes > 100 * 1024) throw new Error('sqlite exceeds 100 KB');
