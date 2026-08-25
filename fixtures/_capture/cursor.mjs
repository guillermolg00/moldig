#!/usr/bin/env node
// Regenerates fixtures/cursor/<case>/ from this machine (Cursor harness).
//
// Reproducible, dependency-free (node: built-ins only), idempotent: it deletes and
// recreates ONLY the case directories it owns. It reads STRUCTURE from the real Cursor
// files (JSON keys, Markdown line/byte counts, counts of workspace.json shapes) and writes
// anonymised trees per fixtures/README.md + the ticket-15 extensions. It never copies a
// value, a transcript, a database or a hash of a real thing, and it prints only counts
// and fixture paths.
//
// Sources touched (read-only):
//   ~/Library/Application Support/Cursor/User/workspaceStorage/*/workspace.json  (parsed; only
//       counts survive: folder vs workspace shape, formatting, number of case-only pairs)
//   ~/.cursor/{cli-config.json,ide_state.json}                                  (keys only)
//   <a project>/.cursor/rules/*.mdc, <a project>/.cursorrules                    (frontmatter keys,
//       line and byte counts only; override with MOLDIG_CURSOR_RULES_DIR / MOLDIG_CURSORRULES)
// Never opened: anything named *mcp*, *auth*, *token*, *key*, *secret*, *.env, and any
// state.vscdb (the fixture's SQLite files are built from VS Code's public schema, see README).
// The `~/.cursor/projects/<slug>` and `~/.cursor/worktrees` layouts were taken from `ls`
// (names only) and research note 09; every file inside them here is synthetic.

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSources, sourcePath } from './_sources.mjs';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..');
const HOME = homedir();
const SRC_CURSOR = join(HOME, '.cursor');
const SRC_WS = join(HOME, 'Library', 'Application Support', 'Cursor', 'User', 'workspaceStorage');
// Source projects live in fixtures/_capture/sources.local.json (gitignored; see sources.example.json); '' = documented shape
const SOURCES = loadSources();
const SRC_RULES_PROJECT = sourcePath(SOURCES.cursor?.rulesProject);
const SRC_CURSORRULES_PROJECT = sourcePath(SOURCES.cursor?.cursorrulesProject);
const SRC_RULES_DIR = process.env.MOLDIG_CURSOR_RULES_DIR ?? (SRC_RULES_PROJECT ? join(SRC_RULES_PROJECT, '.cursor', 'rules') : '');
const SRC_CURSORRULES = process.env.MOLDIG_CURSORRULES ?? (SRC_CURSORRULES_PROJECT ? join(SRC_CURSORRULES_PROJECT, '.cursorrules') : '');

const REDACTED = '<redacted>';
const SYNTH_EPOCH_MS = 1_700_000_000_000; // fixed synthetic timestamp (2023-11-14T22:13:20Z)
const SAFE_KEY = /^[A-Za-z0-9_$.-]{1,40}$/;
const OPAQUE_KEY = /^[0-9a-f]{16,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9]{8,}$/i; // hashes, uuids, timestamps used as keys are values in disguise
const FORBIDDEN = /mcp|auth|oauth|cred|secret|token|key|\.env|google_accounts|state\.vscdb/i;
const APP = 'home/Library/Application Support/Cursor';
const WS_DIR = `${APP}/User/workspaceStorage`;
const GLOBAL_DB = `${APP}/User/globalStorage/state.vscdb`;

// Synthetic ids. Storage ids are md5 of the PLACEHOLDER URI (32 hex like the real ones,
// never a hash of a real path). Transcript ids are fixed v4-shaped UUIDs.
const wsId = (seed) => createHash('md5').update(seed).digest('hex');
const UUID_1 = '00000000-0000-4000-8000-000000000001';
const UUID_2 = '00000000-0000-4000-8000-000000000002';
const UUID_3 = '00000000-0000-4000-8000-000000000003';
const WT_LIVE = 'abc'; // Cursor names worktree leaves with short random ids (3–5 alnum chars)
const WT_STALE = 'xyz';
const NUMERIC_SLUG = '1700000000000';
const WORKSPACES_TS = '1700000000000';

// VS Code's public storage schema (src/vs/base/parts/storage/node/storage.ts) plus Cursor's
// second table. Not read from any state.vscdb: the ticket forbids opening them.
const DDL_ITEM_TABLE = 'CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)';
const DDL_CURSOR_DISK_KV = 'CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)';

// ---------------------------------------------------------------- helpers

function assertReadable(path) {
  if (FORBIDDEN.test(basename(path))) throw new Error('refusing to open a file matching the forbidden name list');
}

/** Walk a parsed JSON structure keeping only keys, booleans, null and small integers. */
function redact(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) < 1000 ? value : SYNTH_EPOCH_MS;
  if (typeof value === 'string') return REDACTED;
  if (Array.isArray(value)) return value.slice(0, 3).map(redact);
  if (typeof value === 'object') {
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) out[SAFE_KEY.test(k) && !OPAQUE_KEY.test(k) ? k : `${REDACTED}-${++n}`] = redact(v);
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

/** Shape of a Markdown file: frontmatter keys, body line count and byte size. Nothing else. */
function markdownShape(srcPath, fallback) {
  try {
    assertReadable(srcPath);
    if (existsSync(srcPath)) {
      const lines = readFileSync(srcPath, 'utf8').split('\n');
      let keys = [];
      let bodyStart = 0;
      if (lines[0] === '---') {
        const end = lines.indexOf('---', 1);
        if (end > 0) {
          keys = lines.slice(1, end).map((l) => l.match(/^([A-Za-z0-9_-]+):/)?.[1]).filter(Boolean);
          bodyStart = end + 1;
        }
      }
      const body = lines.slice(bodyStart);
      return { keys, lines: body.length - (body.at(-1) === '' ? 1 : 0), bytes: Buffer.byteLength(body.join('\n'), 'utf8'), live: true };
    }
  } catch {
    /* fall through to the fallback */
  }
  return { ...fallback, live: false };
}

/** Render a Markdown file from a shape: keys survive, values come from `values` or `<redacted>`. */
function renderMarkdown(shape, values = {}) {
  const keys = [...shape.keys];
  for (const k of Object.keys(values)) if (!keys.includes(k)) keys.push(k);
  let fm = '';
  if (keys.length) {
    fm = '---\n';
    for (const k of keys) {
      const v = k in values ? values[k] : REDACTED;
      fm += v === '' ? `${k}:\n` : `${k}: ${v}\n`;
    }
    fm += '---\n';
  }
  return fm + filler(shape.lines, shape.bytes);
}

class CaseWriter {
  constructor(dir) {
    this.dir = dir;
    this.files = 0;
    this.bytes = 0;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  abs(rel) {
    return join(this.dir, ...rel.split('/'));
  }
  write(rel, content) {
    const abs = this.abs(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.files++;
    this.bytes += statSync(abs).size;
  }
  json(rel, value) {
    this.write(rel, JSON.stringify(value, null, 2) + '\n');
  }
  count(rel) {
    this.files++;
    this.bytes += statSync(this.abs(rel)).size;
  }
}

// ---------------------------------------------------------------- real-machine structure (counts only)

function workspaceStats() {
  const stats = { dirs: 0, jsons: 0, folder: 0, workspace: 0, other: 0, compact: 0, indent: null, trailingNewline: 0, casePairs: 0, live: false };
  if (!existsSync(SRC_WS)) return stats;
  const byLower = new Map();
  for (const entry of readdirSync(SRC_WS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    stats.dirs++;
    const file = join(SRC_WS, entry.name, 'workspace.json');
    if (!existsSync(file)) continue;
    let raw;
    let parsed;
    try {
      raw = readFileSync(file, 'utf8');
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    stats.jsons++;
    if (!raw.includes('\n')) stats.compact++;
    else if (stats.indent === null) stats.indent = raw.split('\n')[1]?.match(/^[ \t]*/)?.[0] ?? '  '; // whitespace only
    if (raw.endsWith('\n')) stats.trailingNewline++;
    if (typeof parsed.folder === 'string') {
      stats.folder++;
      try {
        const p = decodeURIComponent(new URL(parsed.folder).pathname).replace(/\/$/, '');
        const set = byLower.get(p.toLowerCase()) ?? new Set();
        set.add(p);
        byLower.set(p.toLowerCase(), set);
      } catch {
        /* unparsable URI: counted as folder, not as a pair candidate */
      }
    } else if (typeof parsed.workspace === 'string') stats.workspace++;
    else stats.other++;
  }
  for (const set of byLower.values()) if (set.size > 1) stats.casePairs++;
  stats.live = stats.jsons > 0;
  return stats;
}

// ---------------------------------------------------------------- SQLite (synthetic, public schema)

function buildStateDb(path, { withDiskKv, itemRows = [], diskKvRows = [] }) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA page_size = 1024');
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec(DDL_ITEM_TABLE);
  if (withDiskKv) db.exec(DDL_CURSOR_DISK_KV);
  const insItem = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  for (const [k, v] of itemRows) insItem.run(k, v);
  if (withDiskKv) {
    const insKv = db.prepare('INSERT INTO cursorDiskKV (key, value) VALUES (?, ?)');
    for (const [k, v] of diskKvRows) insKv.run(k, v);
  }
  db.exec('VACUUM');
  db.close();
  return statSync(path).size;
}

// ---------------------------------------------------------------- synthetic blocks

const USER_MCP = {
  mcpServers: {
    'server-stdio': { type: 'stdio', command: REDACTED, args: [REDACTED, REDACTED], env: { VAR_A: REDACTED } },
    'server-url': { type: 'http', url: REDACTED, headers: { 'Header-A': REDACTED } },
  },
};
const PROJECT_MCP = { mcpServers: { 'server-stdio': { command: REDACTED, args: [REDACTED, REDACTED] } } };

const transcript = (n) => `synthetic transcript ${n}: line 1\nsynthetic transcript ${n}: line 2\n`;
const serverMetadata = (name) => ({ serverIdentifier: REDACTED, serverName: name });

function planMd() {
  return [
    '---',
    `name: ${REDACTED}`,
    `overview: ${REDACTED}`,
    'todos:',
    '  - id: todo-1',
    `    content: ${REDACTED}`,
    `    status: ${REDACTED}`,
    '    dependencies: []',
    '  - id: todo-2',
    `    content: ${REDACTED}`,
    `    status: ${REDACTED}`,
    '    dependencies:',
    '      - todo-1',
    '---',
    '',
    filler(8, 320),
  ].join('\n');
}

// ---------------------------------------------------------------- case: workspaces

function caseWorkspaces() {
  const dir = join(FIXTURES, 'cursor', 'workspaces');
  const w = new CaseWriter(dir);
  const live = {};

  // ---- what the real workspaceStorage looks like (counts only) → formatting of workspace.json
  const ws = workspaceStats();
  live.workspaceStorage = ws.live;
  const compact = ws.jsons > 0 && ws.compact * 2 >= ws.jsons;
  const indent = ws.indent || '\t';
  const newline = ws.jsons === 0 || ws.trailingNewline * 2 >= ws.jsons ? '\n' : '';
  const wsJson = (v) => (compact ? JSON.stringify(v) : JSON.stringify(v, null, indent)) + newline;

  // ---- home/Library/Application Support/Cursor/User/workspaceStorage
  // One storage dir per breadcrumb; the id is md5 of the placeholder URI.
  const STORAGE = [
    { key: 'a', uri: 'file://<ROOT>/API-NESTJS', shape: 'folder', what: 'upper-case member of the case-only pair; no `~/.cursor/projects` slug' },
    { key: 'b', uri: 'file://<ROOT>/api-nestjs', shape: 'folder', what: 'lower-case member of the pair; owns the slug `__ROOT__-api-nestjs`' },
    { key: 'c', uri: 'file://<ROOT>/gone', shape: 'folder', what: 'ghost: the directory no longer exists, the slug `__ROOT__-gone` does' },
    { key: 'd', uri: 'file://<ROOT>/project-a', shape: 'folder', what: 'live repository with a full slug dir' },
    { key: 'e', uri: 'file://<ROOT>/project-a', shape: 'folder', seed: 'file://<ROOT>/project-a#2', what: 'second storage dir for the same folder (Cursor keeps 2–5 per folder here)' },
    { key: 'f', uri: 'file://<ROOT>/project-a/packages/api', shape: 'folder', what: 'a subdirectory of project-a opened as its own workspace (nested pair)' },
    { key: 'g', uri: 'file://<HOME>', shape: 'folder', what: 'the home directory opened as a workspace (user scope, never a Project)' },
    { key: 'h', uri: `file://<HOME>/Library/Application%20Support/Cursor/Workspaces/${WORKSPACES_TS}/workspace.json`, shape: 'workspace', what: 'untitled multi-root workspace; the `Workspaces/<ts>/` target is missing (as all 22 are on this machine)' },
    { key: 'i', uri: null, shape: 'none', seed: 'no-workspace-json', what: 'storage dir with `state.vscdb` but no `workspace.json` (114 dirs vs 113 json here)' },
  ];
  const ids = {};
  let wsDbBytes = 0;
  for (const s of STORAGE) {
    const id = wsId(s.seed ?? s.uri);
    ids[s.key] = id;
    if (s.shape === 'folder') w.write(`${WS_DIR}/${id}/workspace.json`, wsJson({ folder: s.uri }));
    else if (s.shape === 'workspace') w.write(`${WS_DIR}/${id}/workspace.json`, wsJson({ workspace: s.uri }));
    wsDbBytes += buildStateDb(w.abs(`${WS_DIR}/${id}/state.vscdb`), { withDiskKv: false });
    w.count(`${WS_DIR}/${id}/state.vscdb`);
  }

  // ---- globalStorage/state.vscdb: the only ItemTable rows a scanner may care about, synthetic values
  const recentlyOpened = {
    entries: [
      { folderUri: 'file://<ROOT>/project-a' },
      { folderUri: 'file://<ROOT>/gone' },
      { folderUri: 'file://<ROOT>/API-NESTJS' },
      { fileUri: 'file://<ROOT>/project-a/AGENTS.md' },
      { workspace: { configPath: `file://<HOME>/Library/Application%20Support/Cursor/Workspaces/${WORKSPACES_TS}/workspace.json`, id: REDACTED }, label: REDACTED },
    ],
  };
  const globalDbBytes = buildStateDb(w.abs(GLOBAL_DB), {
    withDiskKv: true,
    itemRows: [
      ['history.recentlyOpenedPathsList', JSON.stringify(recentlyOpened)],
      ['cursor/memoriesEnabled', 'true'],
      ['cursorPendingMemories', '[]'],
    ],
    diskKvRows: [
      [`composerData:${UUID_1}`, '{}'],
      [`composerData:${UUID_2}`, '{}'],
    ],
  });
  w.count(GLOBAL_DB);
  copyFileSync(w.abs(GLOBAL_DB), w.abs(`${GLOBAL_DB}.backup`));
  w.count(`${GLOBAL_DB}.backup`);
  w.write(`${GLOBAL_DB}-wal`, '');

  // ---- home/.cursor (user scope)
  w.json('home/.cursor/mcp.json', USER_MCP);
  w.json('home/.cursor/mcp.json.backup', USER_MCP);
  const cli = readJsonRedacted(join(SRC_CURSOR, 'cli-config.json'), { version: 1, editor: { vimMode: false }, hasChangedDefaultModel: false, permissions: { allow: [REDACTED], deny: [] } });
  live.cliConfig = cli.live;
  w.json('home/.cursor/cli-config.json', cli.value);
  const ide = readJsonRedacted(join(SRC_CURSOR, 'ide_state.json'), { recentlyViewedFiles: [REDACTED] });
  live.ideState = ide.live;
  w.json('home/.cursor/ide_state.json', ide.value);
  w.write('home/.cursor/rules/user-rule.mdc', renderMarkdown({ keys: ['description', 'globs', 'alwaysApply'], lines: 4, bytes: 140 }, { description: REDACTED, globs: '', alwaysApply: 'true' }));
  w.write('home/.cursor/plans/plan_a_00000000.plan.md', planMd());
  w.write('home/.cursor/skills-cursor/create-rule/SKILL.md', renderMarkdown({ keys: ['name', 'description'], lines: 12, bytes: 480 }, { name: 'create-rule' }));
  w.write('home/.cursor/skills-cursor/migrate-to-skills/SKILL.md', renderMarkdown({ keys: ['name', 'description'], lines: 10, bytes: 400 }, { name: 'migrate-to-skills' }));
  w.write('home/.cursor/skills/web-design-guidelines/SKILL.md', renderMarkdown({ keys: ['name', 'description'], lines: 34, bytes: 1100 }, { name: 'web-design-guidelines' }));
  w.write('home/.agents/skills/find-skills/SKILL.md', renderMarkdown({ keys: ['name', 'description'], lines: 18, bytes: 640 }, { name: 'find-skills' }));

  // ---- home/.cursor/projects/<slug> (layouts from `ls`; every file synthetic)
  const P = 'home/.cursor/projects';
  w.write(`${P}/__ROOT__-api-nestjs/agent-transcripts/${UUID_1}.txt`, transcript(1));
  w.write(`${P}/__ROOT__-api-nestjs/agent-transcripts/${UUID_2}.txt`, transcript(2));
  w.json(`${P}/__ROOT__-api-nestjs/mcp-cache.json`, { 'user-server-stdio': { tools: [] }, 'cursor-ide-browser': { tools: [] } });
  w.json(`${P}/__ROOT__-api-nestjs/mcps/user-server-stdio/SERVER_METADATA.json`, serverMetadata('user-server-stdio'));
  w.write(`${P}/__ROOT__-api-nestjs/mcps/user-server-stdio/INSTRUCTIONS.md`, filler(3, 120));
  w.json(`${P}/__ROOT__-api-nestjs/mcps/cursor-ide-browser/SERVER_METADATA.json`, serverMetadata('cursor-ide-browser'));
  w.write(`${P}/__ROOT__-project-a/agent-transcripts/${UUID_3}.txt`, transcript(3));
  w.json(`${P}/__ROOT__-project-a/mcp-cache.json`, { 'user-server-stdio': { tools: [] } });
  w.json(`${P}/__HOME__/mcp-cache.json`, { 'cursor-ide-browser': { tools: [] } });

  // ---- home/.cursor/worktrees/<repo>/<id>: Cursor-created linked worktrees (`.git` is a FILE)
  const WT = 'home/.cursor/worktrees';
  w.write(`${WT}/project-a/${WT_LIVE}/_git`, `gitdir: <ROOT>/project-a/.git/worktrees/${WT_LIVE}\n`);
  w.write(`${WT}/project-a/${WT_LIVE}/AGENTS.md`, filler(6, 200));
  w.write(`${WT}/gone/${WT_STALE}/_git`, `gitdir: <ROOT>/gone/.git/worktrees/${WT_STALE}\n`);

  // ---- root/project-a (project scope)
  const R = 'root/project-a';
  w.write(`${R}/_git/HEAD`, 'ref: refs/heads/main\n');
  w.write(`${R}/_git/worktrees/${WT_LIVE}/gitdir`, `<HOME>/.cursor/worktrees/project-a/${WT_LIVE}/.git\n`);
  w.write(`${R}/_git/worktrees/${WT_LIVE}/commondir`, '../..\n');
  w.write(`${R}/_git/worktrees/${WT_LIVE}/HEAD`, 'ref: refs/heads/feature\n');

  const RULE_FALLBACK = { keys: ['description', 'globs', 'alwaysApply'], lines: 30, bytes: 1500 };
  const shapeAlways = markdownShape(join(SRC_RULES_DIR, 'cursor_rules.mdc'), RULE_FALLBACK);
  const shapeScoped = markdownShape(join(SRC_RULES_DIR, 'self_improve.mdc'), { ...RULE_FALLBACK, lines: 50, bytes: 2400 });
  const shapeAgent = markdownShape(join(SRC_RULES_DIR, 'dev_workflow.mdc'), { ...RULE_FALLBACK, lines: 300, bytes: 18000 });
  live.rules = shapeAlways.live && shapeScoped.live && shapeAgent.live;
  const always = renderMarkdown(shapeAlways, { description: REDACTED, globs: '', alwaysApply: 'true' });
  w.write(`${R}/.cursor/rules/always.mdc`, always);
  w.write(`${R}/.cursor/rules/scoped.mdc`, renderMarkdown(shapeScoped, { description: REDACTED, globs: REDACTED, alwaysApply: 'false' }));
  w.write(`${R}/.cursor/rules/agent.mdc`, renderMarkdown(shapeAgent, { description: REDACTED, globs: '', alwaysApply: 'false' }));
  w.write(`${R}/.cursor/rules/sub/manual.mdc`, renderMarkdown({ keys: ['description', 'globs', 'alwaysApply'], lines: 5, bytes: 180 }, { description: '', globs: '', alwaysApply: 'false' }));
  w.write(`${WT}/project-a/${WT_LIVE}/.cursor/rules/always.mdc`, always); // the checkout carries the repo's rule

  const shapeCursorrules = markdownShape(SRC_CURSORRULES, { keys: [], lines: 120, bytes: 5000 });
  live.cursorrules = shapeCursorrules.live;
  w.write(`${R}/.cursorrules`, renderMarkdown({ ...shapeCursorrules, keys: [] }));

  w.json(`${R}/.cursor/mcp.json`, PROJECT_MCP);
  w.json(`${R}/.cursor/worktrees.json`, { 'setup-worktree': REDACTED });
  w.json(`${R}/.cursor/hooks.json`, { version: 1, hooks: { beforeShellExecution: [{ command: REDACTED, type: 'command', timeout: 30 }] } });
  w.write(`${R}/.cursor/skills/skill-a/SKILL.md`, renderMarkdown({ keys: ['name', 'description'], lines: 10, bytes: 360 }, { name: 'skill-a' }));
  w.write(`${R}/.cursor/agents/agent-a.md`, renderMarkdown({ keys: ['name', 'description', 'model', 'readonly', 'is_background'], lines: 5, bytes: 160 }, { name: 'agent-a', model: 'inherit', readonly: 'false', is_background: 'false' }));
  w.write(`${R}/.cursor/commands/command-a.md`, filler(4, 120));
  w.write(`${R}/.cursorignore`, 'dist/\n');
  w.write(`${R}/.cursorindexingignore`, 'coverage/\n');
  w.write(`${R}/AGENTS.md`, filler(24, 960));
  w.write(`${R}/packages/api/AGENTS.md`, filler(6, 200));

  // ---- root/API-NESTJS: one directory for two breadcrumbs (case-insensitive source volume)
  w.write('root/API-NESTJS/_git/HEAD', 'ref: refs/heads/main\n');
  w.write('root/API-NESTJS/AGENTS.md', filler(8, 280));

  // ---- fixture.json
  const fixture = {
    renames: [
      { from: 'root/project-a/_git', to: 'root/project-a/.git' },
      { from: 'root/API-NESTJS/_git', to: 'root/API-NESTJS/.git' },
      { from: `${WT}/project-a/${WT_LIVE}/_git`, to: `${WT}/project-a/${WT_LIVE}/.git` },
      { from: `${WT}/gone/${WT_STALE}/_git`, to: `${WT}/gone/${WT_STALE}/.git` },
    ],
    symlinks: [{ path: 'home/.cursor/skills/find-skills', target: '../../.agents/skills/find-skills', kind: 'dir' }],
    ages: [
      { path: `${WS_DIR}/${ids.c}/workspace.json`, ageDays: 200 },
      { path: `${WS_DIR}/${ids.c}/state.vscdb`, ageDays: 200 },
      { path: `${WS_DIR}/${ids.a}/workspace.json`, ageDays: 90 },
      { path: `${WS_DIR}/${ids.b}/workspace.json`, ageDays: 10 },
      { path: `${WS_DIR}/${ids.h}/workspace.json`, ageDays: 150 },
      { path: `${P}/__ROOT__-api-nestjs/agent-transcripts/${UUID_1}.txt`, ageDays: 45 },
      { path: `${P}/__ROOT__-api-nestjs/agent-transcripts/${UUID_2}.txt`, ageDays: 45 },
      { path: 'home/.cursor/mcp.json.backup', ageDays: 120 },
      { path: 'home/.cursor/plans/plan_a_00000000.plan.md', ageDays: 90 },
    ],
    dirs: [
      `${APP}/Workspaces`,
      `${APP}/logs`,
      `${WS_DIR}/${ids.d}/anysphere.cursor-retrieval`,
      `${WS_DIR}/${ids.d}/images`,
      `${WS_DIR}/${ids.d}/obsolete`,
      `${P}/__ROOT__-api-nestjs/rules`,
      `${P}/__ROOT__-api-nestjs/terminals`,
      `${P}/__ROOT__-api-nestjs/mcps/user-server-stdio/tools`,
      `${P}/__ROOT__-project-a/rules`,
      `${P}/__ROOT__-project-a/terminals`,
      `${P}/__ROOT__-project-a/agent-tools`,
      `${P}/__ROOT__-project-a/canvases`,
      `${P}/__ROOT__-project-a/assets`,
      `${P}/__ROOT__-gone/rules`,
      `${P}/${NUMERIC_SLUG}/canvases`,
      'home/.cursor/ai-tracking',
      'home/.cursor/browser-logs',
      'home/.cursor/extensions',
    ],
    sqlite: [
      { path: GLOBAL_DB, rewrite: [{ table: 'ItemTable', column: 'value' }] },
      { path: `${GLOBAL_DB}.backup`, rewrite: [{ table: 'ItemTable', column: 'value' }] },
    ],
  };
  w.json('fixture.json', fixture);
  w.write('README.md', caseReadme({ ids, STORAGE, compact, ws }));

  return { dir, files: w.files, bytes: w.bytes, dbBytes: wsDbBytes + 2 * globalDbBytes, live, ws };
}

function caseReadme({ ids, STORAGE, compact, ws }) {
  const storageRows = STORAGE.map((s) => `| \`${ids[s.key]}\` | ${s.shape === 'none' ? '—' : `\`${s.shape}\` = \`${s.uri}\``} | ${s.what} |`).join('\n');
  return `# cursor / workspaces

Cursor (the IDE and its CLI) as found on a developer Mac in 2026: the app's per-workspace
storage under \`~/Library/Application Support/Cursor\`, whose \`workspace.json\` files are the
authoritative breadcrumbs, the path-slug directories under \`~/.cursor/projects\`, Cursor-created
linked worktrees under \`~/.cursor/worktrees\`, the user-scope config in \`~/.cursor\`, and two
projects under the root. Generated by \`fixtures/_capture/cursor.mjs\`; every value is redacted
or synthetic.

## Layout

\`home/Library/Application Support/Cursor/\` (app state, user scope, never git)

- \`User/workspaceStorage/<id>/workspace.json\` — \`{"folder": "<file URI>"}\` or
  \`{"workspace": "<file URI of a .code-workspace-like file>"}\`, ${compact ? 'compact single line' : `pretty-printed with ${ws.indent === '\t' || !ws.indent ? 'a tab' : `${ws.indent.length} spaces`}`}${ws.jsons === 0 || ws.trailingNewline * 2 >= ws.jsons ? ' and a trailing newline' : ', no trailing newline'}
  as Cursor writes them (${ws.live ? `${ws.jsons} real files inspected: ${ws.folder} folder, ${ws.workspace} workspace, ${ws.other} other` : 'formatting taken from the fallback; no real files were found'}).
  The ids are md5 of the placeholder URI, 32 hex like the real ones, never a hash of a real path.

| storage id | content | represents |
|---|---|---|
${storageRows}

- \`User/workspaceStorage/<id>/state.vscdb\` — a tiny SQLite file per storage dir with the empty
  \`ItemTable\` (see "SQLite" below). The real ones are opaque per-workspace UI state.
- \`User/workspaceStorage/${ids.d}/{anysphere.cursor-retrieval,images,obsolete}/\` — empty
  siblings as observed, declared under \`dirs\`.
- \`User/globalStorage/state.vscdb\` (+ \`.backup\` copy, empty \`-wal\` sidecar) — \`ItemTable\` rows
  \`history.recentlyOpenedPathsList\` (5 entries: 3 \`folderUri\`, 1 \`fileUri\`, 1 \`workspace\`),
  \`cursor/memoriesEnabled\` (\`true\`), \`cursorPendingMemories\` (\`[]\`); \`cursorDiskKV\` holds two
  \`composerData:<uuid>\` rows whose value is \`{}\` (the real value shape was not captured).
  No \`cursorAuth/*\` or \`secret://*\` rows exist here on purpose.
- \`Workspaces/\`, \`logs/\` — empty directories (\`dirs\`); the multi-root target named by storage
  \`${ids.h}\` is therefore missing.

\`home/.cursor/\` (user scope)

- \`mcp.json\` — **synthetic**: \`mcpServers\` with one stdio entry (\`type, command, args, env\`) and
  one url entry (\`type: http, url, headers\`). \`mcp.json.backup\` is an identical copy, 120 days
  old, as Cursor leaves \`mcp.json.backup*\` siblings next to the live file.
- \`cli-config.json\`, \`ide_state.json\` — real key names, every value redacted.
- \`rules/user-rule.mdc\` — user rule file. Documented as existing; its \`.mdc\` format is
  **presumed** (this machine has no \`~/.cursor/rules\`).
- \`plans/plan_a_00000000.plan.md\` — frontmatter keys \`name, overview, todos[{id,content,status,dependencies}]\`,
  synthetic; plans carry no path.
- \`skills-cursor/{create-rule,migrate-to-skills}/SKILL.md\` — Cursor's built-in generator skills
  (public names, filler bodies).
- \`skills/web-design-guidelines/\` — a real directory (older Vercel-skills generation) next to
  \`skills/find-skills\`, a symlink into \`home/.agents/skills/\` declared in \`fixture.json\`.
- \`projects/<slug>/\` — see the slug rule below. Layouts mirror what \`ls\` showed on this machine,
  files are synthetic:
  - \`__ROOT__-api-nestjs/\`: \`agent-transcripts/<uuid>.txt\` ×2 (2-line synthetic texts, 45 days old),
    \`mcp-cache.json\` (\`{"<server>": {"tools": []}}\`), \`mcps/<server>/{SERVER_METADATA.json,INSTRUCTIONS.md,tools/}\`
    with the observed \`user-\`/\`cursor-\` name prefixes, empty \`rules/\` and \`terminals/\`.
  - \`__ROOT__-project-a/\`: one transcript, \`mcp-cache.json\`, empty \`rules/ terminals/ agent-tools/ canvases/ assets/\`.
  - \`__HOME__/\`: only \`mcp-cache.json\` (the home slug on this machine has exactly that).
  - \`__ROOT__-gone/\`: only an empty \`rules/\` (ghost with a slug dir).
  - \`${NUMERIC_SLUG}/\`: a bare window id with an empty \`canvases/\` — resolves to no path.
- \`worktrees/<repo>/<id>/\` — Cursor-created linked worktrees. \`.git\` is a **file**
  (written as \`_git\`, renamed by \`fixture.json\`) with \`gitdir: <main repo>/.git/worktrees/<id>\`.
  \`project-a/abc\` is live (the main repo's \`.git/worktrees/abc/gitdir\` points back) and carries
  \`AGENTS.md\` + \`.cursor/rules/always.mdc\` like a checkout does; \`gone/xyz\` is stale: its
  \`gitdir:\` names \`<ROOT>/gone\`, which does not exist.
- \`ai-tracking/\`, \`browser-logs/\`, \`extensions/\` — empty (\`dirs\`). The real \`ai-tracking/ai-code-tracking.db\`
  was not captured (not a breadcrumb source; see "Not captured").

\`root/\` (the projects side)

- \`project-a/\` — git repository (\`_git/HEAD\` + \`_git/worktrees/abc/{gitdir,commondir,HEAD}\`),
  \`.cursor/rules/always.mdc\` (\`alwaysApply: true\` → Always), \`scoped.mdc\` (\`globs\` → Auto Attached),
  \`agent.mdc\` (\`description\` only → Agent Requested), \`sub/manual.mdc\` (neither → Manual; subfolders
  are scanned), legacy \`.cursorrules\`, **synthetic** \`.cursor/mcp.json\` (\`{command,args}\`),
  \`.cursor/{worktrees.json,hooks.json}\`, \`.cursor/skills/skill-a/SKILL.md\`, \`.cursor/agents/agent-a.md\`,
  \`.cursor/commands/command-a.md\`, \`.cursorignore\`, \`.cursorindexingignore\`, \`AGENTS.md\` and a
  nested \`packages/api/AGENTS.md\`.
- \`API-NESTJS/\` — git repository with an \`AGENTS.md\`. **Only the upper-case spelling exists**:
  the source volume is case-insensitive APFS, so \`<ROOT>/API-NESTJS\` and \`<ROOT>/api-nestjs\` are
  one directory there, yet Cursor recorded two storage dirs and one (lower-case) slug.
- \`gone/\` — does not exist; two breadcrumbs (storage \`${ids.c}\` and the slug) name it.

## Edge cases carried

1. Case-only pair: two \`workspace.json\` folders that differ only in case, one directory under
   \`root/\`, one slug dir named after the lower-case form. On a case-insensitive filesystem both
   breadcrumbs resolve to the same directory and must fold into ONE Project; an exact-case slug
   lookup for \`<ROOT>/API-NESTJS\` finds nothing while a case-insensitive one finds
   \`__ROOT__-api-nestjs\`. On a case-sensitive filesystem (Linux CI) \`<ROOT>/api-nestjs\` is
   missing: the lower-case breadcrumb becomes a ghost whose slug dir still exists.
2. Ghost breadcrumbs with leftovers: \`<ROOT>/gone\` (storage dir 200 days old + slug dir) and the
   stale worktree \`worktrees/gone/xyz\`.
3. Duplicate storage dirs for one folder (\`${ids.d}\`, \`${ids.e}\`).
4. A subdirectory of a project opened as its own workspace (\`project-a/packages/api\`): folds into
   \`project-a\` by git root.
5. Home opened as a workspace + home slug dir: user scope, never a candidate root.
6. \`{"workspace": …}\` entry whose \`Workspaces/<ts>/workspace.json\` target is missing, and a storage
   dir with no \`workspace.json\` at all.
7. Slugs that resolve to nothing: bare numeric \`${NUMERIC_SLUG}\`.
8. A live linked worktree under \`~/.cursor/worktrees\` (outside every root) with a \`.git\` file whose
   back-link is intact, next to a stale one.
9. All four rule types by frontmatter, a rule in a subfolder, the legacy \`.cursorrules\`.
10. \`mcp.json.backup\` sibling; \`state.vscdb.backup\` and \`-wal\` sidecars.
11. Ages: ghost storage 200 days, multi-root entry 150 days, backup 120 days, plan 90 days,
    upper-case pair member 90 days vs lower-case 10 days, transcripts 45 days.

## What is synthetic

Everything except key names, directory layouts, line counts and byte sizes. Specifically:
both \`mcp.json\` files, \`mcp-cache.json\`, every \`mcps/\` file, every transcript, every
Markdown body (\`.mdc\` rules mirror the frontmatter keys, line count and byte size of
${ws.live ? 'three real project rule files' : 'fallback shapes'}; \`.cursorrules\` mirrors a real one's size), the plan, hooks,
worktrees.json, every SQLite row, every id (storage ids, UUIDs, worktree ids \`abc\`/\`xyz\`,
window id \`${NUMERIC_SLUG}\`). \`cli-config.json\` and \`ide_state.json\` keep real keys only.

## Slug rule

\`~/.cursor/projects/<slug>\`: the absolute path with every run of \`[^A-Za-z0-9]+\` collapsed to
one \`-\` and a leading \`-\` stripped, case kept:

\`\`\`js
const cursorSlug = (p) => p.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-/, '');
\`\`\`

so \`/tmp/x/root/project-a\` → \`tmp-x-root-project-a\` and \`/tmp/x.y/home\` → \`tmp-x-y-home\`.
In directory names the token \`__ROOT__\` stands for \`cursorSlug(<ROOT>)\` and \`__HOME__\` for
\`cursorSlug(<HOME>)\`; the \`-\` that follows a token is the collapsed \`/\`. Decoding a slug is
ambiguous (\`a-b\` may be \`a/b\`, \`a.b\` or \`a-b\`), so the adapter must resolve slugs through the
\`workspace.json\` set, never by splitting. Note this is NOT Claude Code's rule (Claude keeps a
leading \`-\` and maps each non-alphanumeric character separately).

Inside file contents \`<ROOT>\`/\`<HOME>\` appear inside \`file://\` URIs (\`file://<ROOT>/project-a\`);
the literal parts are percent-encoded (\`Application%20Support\`) and the helper must
percent-encode the injected path if it contains characters outside the unreserved set.
The two \`globalStorage\` databases need the placeholders rewritten with SQL: \`fixture.json\`
lists the table/column under \`sqlite\`.

## SQLite

No \`state.vscdb\` was opened on the source machine (forbidden). The fixture databases use VS
Code's public storage schema and Cursor's second table, built with \`node:sqlite\`:

\`\`\`sql
${DDL_ITEM_TABLE};
${DDL_CURSOR_DISK_KV};
\`\`\`

Per-workspace files carry only the empty \`ItemTable\`; the global one carries the rows listed
above. A scanner must treat these files as opaque, sized blobs except for the
\`history.recentlyOpenedPathsList\` row.

## Not captured

- \`ai-tracking/ai-code-tracking.db\`, \`User/History/\`, \`User/{settings,keybindings}.json\`,
  \`~/.cursor/argv.json\`, \`extensions/\` contents: not breadcrumb or config sources for the scanner.
- \`~/.cursor/plans\` holds 85 real plans; one synthetic stands in.
- \`~/.cursor/worktrees\` on this machine holds 10 leaves for 2 gone repos; reduced to one live + one
  stale.
`;
}

// ---------------------------------------------------------------- main

const result = caseWorkspaces();
const rel = relative(process.cwd(), result.dir) || result.dir;
console.log(`case ${rel}: ${result.files} files, ${result.bytes} bytes (sqlite ${result.dbBytes} bytes)`);
console.log(`sources live: ${Object.entries(result.live).filter(([, v]) => v).length}/${Object.keys(result.live).length}`);
console.log(`real workspaceStorage: ${result.ws.dirs} dirs, ${result.ws.jsons} workspace.json (${result.ws.folder} folder, ${result.ws.workspace} workspace, ${result.ws.other} other, ${result.ws.compact} compact, ${result.ws.trailingNewline} with trailing newline, indent ${JSON.stringify(result.ws.indent)}), case-only pairs: ${result.ws.casePairs}`);
if (result.bytes > 300 * 1024) throw new Error('case exceeds 300 KB');
