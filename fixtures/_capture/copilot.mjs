#!/usr/bin/env node
// Regenerates fixtures/copilot/<case>/ from this machine (GitHub Copilot: CLI + VS Code).
//
// Reproducible, dependency-free (node: built-ins only), idempotent: it deletes and
// recreates ONLY the case directories it owns. It reads STRUCTURE from a few real files
// (JSON keys, a Markdown line/byte count, SQLite DDL from sqlite_master) and writes
// anonymised trees per fixtures/README.md plus the ticket-15 extensions. It never copies
// a value, a transcript, a session event or a database row, and it prints only counts
// and fixture paths.
//
// Sources touched (read-only):
//   ~/.copilot/config.json                                   keys only, every string -> <redacted>
//   ~/.copilot/session-state/*/session.db                    first one found; sqlite_master DDL only
//   ~/Library/Application Support/Code/User/settings.json    keys chat.* / github.copilot.* only
//   ~/Library/Application Support/Code/User/globalStorage/storage.json   keys only
//   ~/Library/Application Support/Code/User/globalStorage/state.vscdb    sqlite_master DDL only
//   <instructionsProject>/.github/copilot-instructions.md           line count + byte size only
//   (project named in fixtures/_capture/sources.local.json, gitignored; see sources.example.json)
// Never opened: anything whose name matches /mcp|auth|oauth|cred|secret|token|key|\.env/i
// (mcp-config.json, mcp-oauth-config/, User/mcp.json, …). MCP entries are synthesised
// from the documented shapes in docs/research/02 (keys + transport enumerations only).
// workspace.yaml, events.jsonl, checkpoints, plan.md and logs are never read: they are
// written synthetic from the key lists in docs/research/09.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSources, sourcePath } from './_sources.mjs';
import { DatabaseSync } from 'node:sqlite';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..');
const HOME = homedir();
const SRC_COPILOT = join(HOME, '.copilot');
const SRC_CODE_USER = join(HOME, 'Library', 'Application Support', 'Code', 'User');
const SOURCES = loadSources();
const SRC_PROJECT = sourcePath(SOURCES.copilot?.instructionsProject); // '' when undeclared: documented shape
const SRC_INSTRUCTIONS = SRC_PROJECT ? join(SRC_PROJECT, '.github', 'copilot-instructions.md') : '';

const REDACTED = '<redacted>';
const SYNTH_EPOCH_MS = 1_700_000_000_000; // fixed synthetic timestamp (2023-11-14T22:13:20Z)
const SAFE_KEY = /^[A-Za-z0-9_$.-]{1,60}$/;
const OPAQUE_KEY = /^[0-9a-f]{16,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9]{8,}$/i; // hashes, uuids, timestamps used as keys are values in disguise
const FORBIDDEN = /mcp|auth|oauth|cred|secret|token|key|\.env|google_accounts/i;
const MAX_CASE_BYTES = 300 * 1024;
const MAX_DB_BYTES = 100 * 1024;

// Synthetic ids: repeated digits, never derived from a real thing.
// Copilot CLI session ids are UUIDs; VS Code workspaceStorage ids are 32-hex hashes.
const SESSION_A = '00000000-0000-4000-8000-000000000001'; // cwd <ROOT>/project-a
const SESSION_GONE = '00000000-0000-4000-8000-000000000002'; // cwd <ROOT>/gone
const SESSION_SUBDIR = '00000000-0000-4000-8000-000000000003'; // cwd <ROOT>/project-a/packages/api
const WS_A = '1'.repeat(32);
const WS_A_DUP = '2'.repeat(32);
const WS_HOME = '3'.repeat(32);
const WS_GONE = '4'.repeat(32);

const ISO_NOW = '2026-01-15T12:00:00.000Z';
const ISO_OLD = '2025-06-01T12:00:00.000Z';

// Embedded DDL snapshots, used only when the real database is not on the machine that
// runs this script. Read from sqlite_master on 2026-08-25.
const DDL_FALLBACK_SESSION = {
  tables: {
    todos:
      "CREATE TABLE todos (\n                id TEXT PRIMARY KEY,\n                title TEXT NOT NULL,\n                description TEXT,\n                status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'blocked')),\n                created_at TEXT DEFAULT (datetime('now')),\n                updated_at TEXT DEFAULT (datetime('now'))\n            )",
    todo_deps:
      'CREATE TABLE todo_deps (\n                todo_id TEXT NOT NULL,\n                depends_on TEXT NOT NULL,\n                PRIMARY KEY (todo_id, depends_on),\n                FOREIGN KEY (todo_id) REFERENCES todos(id),\n                FOREIGN KEY (depends_on) REFERENCES todos(id)\n            )',
  },
  indexes: [],
};
const SESSION_DB_TABLES = ['todos', 'todo_deps'];
const DDL_FALLBACK_VSCDB = {
  tables: { ItemTable: 'CREATE TABLE ItemTable (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)' },
  indexes: [],
};

// ---------------------------------------------------------------- helpers

function assertReadable(path) {
  if (FORBIDDEN.test(relative(HOME, path))) throw new Error('refusing to open a file matching the forbidden name list');
}

/** Walk a parsed JSON structure keeping only keys, booleans, null and small integers. */
function redact(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) < 10_000 ? value : SYNTH_EPOCH_MS;
  if (typeof value === 'string') return REDACTED;
  if (Array.isArray(value)) return value.slice(0, 3).map(redact);
  if (typeof value === 'object') {
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) {
      const key = SAFE_KEY.test(k) && !OPAQUE_KEY.test(k) ? k : `${REDACTED}-${++n}`;
      out[key] = redact(v);
    }
    return out;
  }
  return REDACTED;
}

/** Strip line and block comments and trailing commas (VS Code settings are JSONC). */
function stripJsonc(text) {
  let out = '';
  let i = 0;
  let inStr = false;
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') {
        out += n ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inStr = false;
      i++;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function readJsonRedacted(path, fallback, { jsonc = false } = {}) {
  try {
    assertReadable(path);
    if (!existsSync(path)) return { value: fallback, live: false };
    const text = readFileSync(path, 'utf8');
    return { value: redact(JSON.parse(jsonc ? stripJsonc(text) : text)), live: true };
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

/** YAML frontmatter from ordered [key, value] pairs followed by a filler body. */
function frontmatter(pairs, body) {
  return `---\n${pairs.map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n\n${body}`;
}

/**
 * Mirror a Markdown file: frontmatter KEYS survive with `<redacted>` values, the body is
 * filler with the same line count and roughly the same byte size. `fallback` =
 * {keys, lines, bytes} is used when the real file is absent.
 */
function mirrorMarkdown(srcPath, { fallback } = {}) {
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
  const fm = keys.length ? `---\n${keys.map((k) => `${k}: ${REDACTED}`).join('\n')}\n---\n` : '';
  return { text: fm + filler(bodyLines, bodyBytes), live };
}

/** Minimal YAML emitter for flat key/value documents (Copilot CLI workspace.yaml). */
function yaml(pairs) {
  return pairs.map(([k, v]) => `${k}: ${v}`).join('\n') + '\n';
}

const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

class CaseWriter {
  constructor(dir) {
    this.dir = dir;
    this.files = 0;
    this.bytes = 0;
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  write(rel, content) {
    const abs = join(this.dir, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.files++;
    this.bytes += statSync(abs).size;
  }
  json(rel, value) {
    this.write(rel, JSON.stringify(value, null, 2) + '\n');
  }
  /** Account for a file written by someone else (SQLite). */
  account(rel) {
    this.files++;
    this.bytes += statSync(join(this.dir, ...rel.split('/'))).size;
  }
}

// ---------------------------------------------------------------- SQLite

/** Read CREATE statements for `tables` (and their indexes) from a real database, read-only. */
function readDdl(dbPath, tables, fallback) {
  if (!dbPath || !existsSync(dbPath)) return { ddl: fallback, live: false };
  let db;
  try {
    assertReadable(dbPath);
    db = new DatabaseSync(`file:${dbPath}?mode=ro`, { readOnly: true });
    const rows = db
      .prepare("select type, name, tbl_name, sql from sqlite_master where sql is not null and name not like 'sqlite_%' order by tbl_name, type desc, name")
      .all();
    const ddl = { tables: {}, indexes: [] };
    for (const r of rows) {
      if (!tables.includes(r.tbl_name)) continue;
      if (r.type === 'table') ddl.tables[r.tbl_name] = r.sql;
      else if (r.type === 'index') ddl.indexes.push(r.sql);
    }
    for (const t of tables) if (!ddl.tables[t]) throw new Error('missing table');
    return { ddl, live: true };
  } catch {
    return { ddl: fallback, live: false };
  } finally {
    db?.close();
  }
}

function firstSessionDb() {
  const base = join(SRC_COPILOT, 'session-state');
  try {
    if (!existsSync(base)) return null;
    for (const d of readdirSync(base).sort()) {
      const p = join(base, d, 'session.db');
      if (existsSync(p)) return p;
    }
  } catch {
    /* unreadable: treat as absent */
  }
  return null;
}

/** First value of a `CHECK(<col> IN ('a', 'b', …))` enumeration in a CREATE statement, if any. */
function checkEnum(ddl, col) {
  const m = new RegExp(`CHECK\\s*\\(\\s*"?${col}"?\\s+IN\\s*\\(([^)]*)\\)`, 'i').exec(ddl || '');
  if (!m) return undefined;
  const first = /'([^']*)'/.exec(m[1]);
  return first ? first[1] : undefined;
}

/** Insert `count` synthetic rows into `table`, typing values from PRAGMA table_info and wiring FKs to `parentIds`. */
function insertSyntheticRows(db, table, count, parentIds, ddl) {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
  const fks = db.prepare(`PRAGMA foreign_key_list("${table}")`).all();
  const pkCols = cols.filter((c) => c.pk > 0);
  const ids = [];
  for (let i = 1; i <= count; i++) {
    const names = [];
    const values = [];
    let fkIndex = 0;
    for (const c of cols) {
      const t = String(c.type || '').toUpperCase();
      const fk = fks.find((f) => f.from === c.name);
      const enumValue = checkEnum(ddl, c.name);
      let v;
      if (fk && parentIds[fk.table]?.length) {
        const pool = parentIds[fk.table];
        v = pool[(i - 1 + fkIndex++) % pool.length];
      } else if (c.pk > 0 && pkCols.length === 1 && t === 'INTEGER') v = i;
      else if (c.pk > 0) v = `synthetic-${table}-${i}`;
      else if (enumValue !== undefined) v = enumValue;
      else if (/INT/.test(t)) v = i;
      else if (/REAL|FLOA|DOUB|NUM/.test(t)) v = i;
      else if (/BLOB/.test(t)) v = Buffer.alloc(0);
      else v = REDACTED;
      names.push(`"${c.name}"`);
      values.push(v);
    }
    db.prepare(`INSERT INTO "${table}" (${names.join(', ')}) VALUES (${names.map(() => '?').join(', ')})`).run(...values);
    const idCol = pkCols.length === 1 ? pkCols[0] : cols[0];
    ids.push(values[cols.indexOf(idCol)]);
  }
  return ids;
}

/** Build the per-session `session.db` (Copilot CLI todo store) from real DDL with synthetic rows. */
function buildSessionDb(path, ddl) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA page_size = 1024');
  db.exec('PRAGMA journal_mode = DELETE');
  for (const t of SESSION_DB_TABLES) db.exec(ddl.tables[t]);
  for (const ix of ddl.indexes) db.exec(ix);
  const rows = {};
  const parentIds = {};
  for (const [table, count] of [
    ['todos', 3],
    ['todo_deps', 2],
  ]) {
    try {
      parentIds[table] = insertSyntheticRows(db, table, count, parentIds, ddl.tables[table]);
      rows[table] = count;
    } catch {
      rows[table] = 0;
    }
  }
  db.exec('VACUUM');
  db.close();
  return { bytes: statSync(path).size, rows };
}

/** Build VS Code's globalStorage/state.vscdb: an ItemTable with the two path-bearing keys. */
function buildStateVscdb(path, ddl) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA page_size = 1024');
  db.exec('PRAGMA journal_mode = DELETE');
  db.exec(ddl.tables.ItemTable);
  for (const ix of ddl.indexes) db.exec(ix);
  const ins = db.prepare('INSERT INTO ItemTable (key, value) VALUES (?, ?)');
  const recentlyOpened = {
    entries: [
      { folderUri: 'file://<ROOT>/project-a' },
      { folderUri: 'file://<ROOT>/gone' },
      { folderUri: 'file://<HOME>' },
      { fileUri: 'file://<ROOT>/project-a/README.md' },
      { workspace: { id: REDACTED, configPath: 'file://<ROOT>/project-a/a.code-workspace' }, label: REDACTED },
    ],
  };
  const trust = {
    uriTrustInfo: [
      { trusted: true, uri: { $mid: 1, path: '<ROOT>', scheme: 'file' } },
      { trusted: true, uri: { $mid: 1, path: '<HOME>', scheme: 'file' } },
    ],
  };
  ins.run('history.recentlyOpenedPathsList', JSON.stringify(recentlyOpened));
  ins.run('content.trust.model.key', JSON.stringify(trust));
  db.exec('VACUUM');
  db.close();
  return { bytes: statSync(path).size, rows: 2 };
}

// ---------------------------------------------------------------- captured-structure blocks

/** ~/.copilot/config.json: real top-level keys, every value redacted, trusted_folders replaced. */
function copilotConfig() {
  const fallback = {
    allowed_urls: [],
    banner: REDACTED,
    disabled_skills: [],
    last_logged_in_user: { host: REDACTED, login: REDACTED },
    logged_in_users: [{ host: REDACTED, login: REDACTED }],
    model: REDACTED,
    render_markdown: true,
    show_reasoning: false,
    trusted_folders: [],
  };
  const { value, live } = readJsonRedacted(join(SRC_COPILOT, 'config.json'), fallback);
  value.trusted_folders = ['<ROOT>/project-a', '<ROOT>/gone', '<HOME>'];
  return { value, live };
}

/** VS Code User/settings.json: only chat.* / github.copilot* keys survive; location maps are synthetic. */
function vscodeSettings() {
  const { value, live } = readJsonRedacted(join(SRC_CODE_USER, 'settings.json'), {}, { jsonc: true });
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (k.startsWith('chat.') || k.startsWith('github.copilot')) out[k] = v;
  }
  // Documented location settings (object maps path -> boolean, `~` expands to home).
  out['chat.useAgentsMdFile'] = true;
  out['chat.useNestedAgentsMdFiles'] = true;
  out['chat.useClaudeMdFile'] = true;
  out['chat.instructionsFilesLocations'] = { '.github/instructions': true, '~/.copilot/instructions': true, 'docs/instructions': false };
  out['chat.agentFilesLocations'] = { '.github/agents': true, '~/.copilot/agents': true };
  out['chat.promptFilesLocations'] = { '.github/prompts': true };
  out['chat.agentSkillsLocations'] = { '.github/skills': true, '.claude/skills': true, '~/.copilot/skills': true, '~/.claude/skills': true };
  return { value: out, live };
}

/** VS Code globalStorage/storage.json: real keys redacted; the workspace map and last window get placeholders. */
function storageJson() {
  const fallback = {
    telemetry: REDACTED,
    profileAssociations: { workspaces: {}, emptyWindows: {} },
    windowsState: { lastActiveWindow: { folder: REDACTED, backupPath: REDACTED, uiState: { mode: 0, x: 0, y: 0, width: 1440, height: 900 } }, openedWindows: [] },
  };
  const { value, live } = readJsonRedacted(join(SRC_CODE_USER, 'globalStorage', 'storage.json'), fallback);
  const workspaces = { 'file://<ROOT>/project-a': REDACTED, 'file://<HOME>': REDACTED, 'file://<ROOT>/gone': REDACTED };
  if (value.profileAssociations && typeof value.profileAssociations === 'object') {
    value.profileAssociations.workspaces = workspaces;
    if ('emptyWindows' in value.profileAssociations) value.profileAssociations.emptyWindows = {};
  } else {
    value.profileAssociations = { workspaces, emptyWindows: {} };
  }
  const win = value.windowsState?.lastActiveWindow;
  if (win && typeof win === 'object') win.folder = 'file://<HOME>';
  if (Array.isArray(value.windowsState?.openedWindows)) value.windowsState.openedWindows = [];
  return { value, live };
}

// ---------------------------------------------------------------- synthetic blocks

// Copilot CLI: ~/.copilot/mcp-config.json and project .github/mcp.json use `mcpServers`;
// type ∈ local|stdio|http|sse; keys command, args, env, tools, url, headers, timeout [76].
const MCP_CLI_USER = {
  mcpServers: {
    'server-local': { type: 'local', command: REDACTED, args: [REDACTED, REDACTED], env: { EXAMPLE_VAR: REDACTED }, tools: ['*'] },
    'server-http': { type: 'http', url: REDACTED, headers: { Authorization: REDACTED }, tools: ['*'], timeout: 30000 },
  },
};
const MCP_CLI_PROJECT = {
  mcpServers: {
    'server-stdio': { type: 'stdio', command: REDACTED, args: [REDACTED], tools: ['*'] },
    'server-sse': { type: 'sse', url: REDACTED, tools: ['*'] },
  },
};
// VS Code: .vscode/mcp.json and User/mcp.json use `servers` (+ `inputs`);
// type ∈ stdio|http|sse; keys command, args, env, envFile, url, headers, sandboxEnabled [71].
const MCP_VSCODE_USER = {
  servers: {
    'server-http': { type: 'http', url: REDACTED, headers: { Authorization: REDACTED } },
  },
  inputs: [{ type: 'promptString', id: REDACTED, description: REDACTED, password: true }],
};
const MCP_VSCODE_PROJECT = {
  servers: {
    'server-stdio': { type: 'stdio', command: REDACTED, args: [REDACTED], env: { EXAMPLE_VAR: REDACTED }, sandboxEnabled: false },
    'server-sse': { type: 'sse', url: REDACTED },
  },
  inputs: [{ type: 'promptString', id: REDACTED, description: REDACTED, password: true }],
};

function workspaceYaml({ id, cwd, gitRoot, full, createdAt, updatedAt, summaryCount }) {
  // Key list from research 09: id, cwd, created_at, updated_at, summary_count on every
  // session; git_root, branch, summary, repository on most. Values are placeholders.
  const pairs = [['id', id], ['cwd', cwd]];
  if (full) pairs.push(['git_root', gitRoot], ['repository', REDACTED], ['branch', REDACTED], ['summary', REDACTED]);
  pairs.push(['summary_count', String(summaryCount)], ['created_at', createdAt], ['updated_at', updatedAt]);
  return yaml(pairs);
}

function eventsJsonl({ id, cwd, createdAt }) {
  // Synthetic: research 09 documents only that line 1 carries data.context.cwd and
  // data.context.repository. Event type names are placeholders, not captured.
  return jsonl([
    { type: 'session.start', timestamp: createdAt, data: { sessionId: id, context: { cwd, repository: REDACTED, branch: REDACTED } } },
    { type: 'user.message', timestamp: createdAt, data: { content: REDACTED } },
  ]);
}

// ---------------------------------------------------------------- case: trust-and-sessions

function caseTrustAndSessions() {
  const dir = join(FIXTURES, 'copilot', 'trust-and-sessions');
  const w = new CaseWriter(dir);
  const live = {};
  const dbs = {};

  // ---- home/.copilot (Copilot CLI user scope)
  const cfg = copilotConfig();
  live.copilotConfig = cfg.live;
  w.json('home/.copilot/config.json', cfg.value);
  w.json('home/.copilot/mcp-config.json', MCP_CLI_USER);
  w.write('home/.copilot/copilot-instructions.md', filler(6, 220));
  w.write('home/.copilot/instructions/global.instructions.md', frontmatter([['applyTo', '"**"'], ['description', REDACTED]], filler(4, 140)));
  w.write('home/.copilot/logs/process-1700000000000-1.log', filler(5, 300));

  // session A: current, full keys, cwd = git root, all documented sub-entries
  const sA = `home/.copilot/session-state/${SESSION_A}`;
  w.write(`${sA}/workspace.yaml`, workspaceYaml({ id: SESSION_A, cwd: '<ROOT>/project-a', gitRoot: '<ROOT>/project-a', full: true, createdAt: ISO_NOW, updatedAt: ISO_NOW, summaryCount: 2 }));
  w.write(`${sA}/events.jsonl`, eventsJsonl({ id: SESSION_A, cwd: '<ROOT>/project-a', createdAt: ISO_NOW }));
  w.write(`${sA}/checkpoints/index.md`, filler(4, 120));
  w.write(`${sA}/checkpoints/001-checkpoint.md`, filler(12, 480));
  w.write(`${sA}/plan.md`, filler(8, 300));
  const sessionDdl = readDdl(firstSessionDb(), SESSION_DB_TABLES, DDL_FALLBACK_SESSION);
  live.sessionDb = sessionDdl.live;
  dbs.session = buildSessionDb(join(dir, ...`${sA}/session.db`.split('/')), sessionDdl.ddl);
  w.account(`${sA}/session.db`);

  // session GONE: old, minimal key set, cwd no longer exists, no events.jsonl
  const sG = `home/.copilot/session-state/${SESSION_GONE}`;
  w.write(`${sG}/workspace.yaml`, workspaceYaml({ id: SESSION_GONE, cwd: '<ROOT>/gone', full: false, createdAt: ISO_OLD, updatedAt: ISO_OLD, summaryCount: 0 }));
  w.write(`${sG}/checkpoints/index.md`, filler(2, 60));

  // session SUBDIR: cwd below the git root (not observed on the source machine; synthetic)
  const sS = `home/.copilot/session-state/${SESSION_SUBDIR}`;
  w.write(`${sS}/workspace.yaml`, workspaceYaml({ id: SESSION_SUBDIR, cwd: '<ROOT>/project-a/packages/api', gitRoot: '<ROOT>/project-a', full: true, createdAt: ISO_NOW, updatedAt: ISO_NOW, summaryCount: 1 }));
  w.write(`${sS}/events.jsonl`, eventsJsonl({ id: SESSION_SUBDIR, cwd: '<ROOT>/project-a/packages/api', createdAt: ISO_NOW }));
  w.write(`${sS}/checkpoints/index.md`, filler(2, 60));

  // skills: ~/.copilot/skills/<name> is a symlink into ~/.agents/skills (Vercel skills fan-out)
  w.write('home/.agents/skills/skill-a/SKILL.md', frontmatter([['name', 'skill-a'], ['description', REDACTED]], filler(10, 360)));

  // ---- home/Library/Application Support/Code/User (VS Code user scope)
  const CU = 'home/Library/Application Support/Code/User';
  const settings = vscodeSettings();
  live.vscodeSettings = settings.live;
  w.json(`${CU}/settings.json`, settings.value);
  w.json(`${CU}/mcp.json`, MCP_VSCODE_USER);
  w.json(`${CU}/workspaceStorage/${WS_A}/workspace.json`, { folder: 'file://<ROOT>/project-a' });
  w.json(`${CU}/workspaceStorage/${WS_A_DUP}/workspace.json`, { folder: 'file://<ROOT>/project-a' });
  w.json(`${CU}/workspaceStorage/${WS_HOME}/workspace.json`, { folder: 'file://<HOME>' });
  w.json(`${CU}/workspaceStorage/${WS_GONE}/workspace.json`, { folder: 'file://<ROOT>/gone' });
  const storage = storageJson();
  live.storageJson = storage.live;
  w.json(`${CU}/globalStorage/storage.json`, storage.value);
  const vscdbDdl = readDdl(join(SRC_CODE_USER, 'globalStorage', 'state.vscdb'), ['ItemTable'], DDL_FALLBACK_VSCDB);
  live.stateVscdb = vscdbDdl.live;
  dbs.vscdb = buildStateVscdb(join(dir, ...`${CU}/globalStorage/state.vscdb`.split('/')), vscdbDdl.ddl);
  w.account(`${CU}/globalStorage/state.vscdb`);

  // ---- root/ (projects side)
  // project-a: the one repository Copilot knows about (trusted, sessions, VS Code workspace)
  w.write('root/project-a/_git/HEAD', 'ref: refs/heads/main\n');
  const instr = mirrorMarkdown(SRC_INSTRUCTIONS, { fallback: { keys: [], lines: 40, bytes: 1600 } });
  live.copilotInstructions = instr.live;
  w.write('root/project-a/.github/copilot-instructions.md', instr.text);
  w.write('root/project-a/.github/instructions/api.instructions.md', frontmatter([['applyTo', '"packages/api/**/*.ts"'], ['description', REDACTED]], filler(6, 220)));
  w.write('root/project-a/.github/skills/skill-a/SKILL.md', frontmatter([['name', 'skill-a'], ['description', REDACTED]], filler(14, 520)));
  w.write('root/project-a/.github/agents/reviewer.md', frontmatter([['name', REDACTED], ['description', REDACTED], ['tools', `['${REDACTED}']`]], filler(8, 300)));
  w.write('root/project-a/.github/agents/planner.agent.md', frontmatter([['name', REDACTED], ['description', REDACTED], ['tools', `['${REDACTED}']`], ['model', REDACTED]], filler(8, 300)));
  w.write('root/project-a/.github/prompts/x.prompt.md', frontmatter([['description', REDACTED], ['agent', 'agent'], ['tools', `['${REDACTED}']`]], filler(5, 180)));
  w.json('root/project-a/.github/mcp.json', MCP_CLI_PROJECT);
  w.write('root/project-a/.github/ISSUE_TEMPLATE.md', filler(6, 200));
  w.write('root/project-a/.github/PULL_REQUEST_TEMPLATE.md', filler(6, 200));
  w.write('root/project-a/.github/workflows/ci.yml', 'name: ci\non: [push]\njobs: {}\n');
  w.json('root/project-a/.vscode/mcp.json', MCP_VSCODE_PROJECT);
  w.json('root/project-a/.vscode/settings.json', { 'chat.useAgentsMdFile': true, 'chat.instructionsFilesLocations': { '.github/instructions': true, 'docs/instructions': true } });
  w.write('root/project-a/AGENTS.md', filler(10, 400));
  w.write('root/project-a/packages/api/AGENTS.md', filler(4, 140));
  w.write('root/project-a/docs/instructions/db.instructions.md', frontmatter([['applyTo', '"**/*.sql"']], filler(3, 100)));

  // project-b: a repository with a .github/ that carries no Copilot customisation
  w.write('root/project-b/_git/HEAD', 'ref: refs/heads/main\n');
  w.write('root/project-b/.github/workflows/ci.yml', 'name: ci\non: [push]\njobs: {}\n');
  w.write('root/project-b/.github/CODEOWNERS', `* @${REDACTED}\n`);
  w.write('root/project-b/.github/dependabot.yml', 'version: 2\nupdates: []\n');
  w.json('root/project-b/.vscode/settings.json', { 'editor.formatOnSave': true });

  // ---- fixture.json
  const sessionFiles = (s, names) => names.map((n) => `home/.copilot/session-state/${s}/${n}`);
  const fixture = {
    renames: [
      { from: 'root/project-a/_git', to: 'root/project-a/.git' },
      { from: 'root/project-b/_git', to: 'root/project-b/.git' },
    ],
    symlinks: [{ path: 'home/.copilot/skills/skill-a', target: '../../.agents/skills/skill-a', kind: 'dir' }],
    ages: [
      ...[`home/.copilot/session-state/${SESSION_A}`, ...sessionFiles(SESSION_A, ['workspace.yaml', 'events.jsonl', 'session.db', 'plan.md', 'checkpoints/index.md', 'checkpoints/001-checkpoint.md'])].map((path) => ({ path, ageDays: 3 })),
      ...[`home/.copilot/session-state/${SESSION_GONE}`, ...sessionFiles(SESSION_GONE, ['workspace.yaml', 'checkpoints/index.md'])].map((path) => ({ path, ageDays: 200 })),
      ...[`home/.copilot/session-state/${SESSION_SUBDIR}`, ...sessionFiles(SESSION_SUBDIR, ['workspace.yaml', 'events.jsonl', 'checkpoints/index.md'])].map((path) => ({ path, ageDays: 40 })),
      { path: `${CU}/workspaceStorage/${WS_GONE}/workspace.json`, ageDays: 200 },
      { path: `${CU}/workspaceStorage/${WS_A_DUP}/workspace.json`, ageDays: 120 },
      { path: 'home/.copilot/logs/process-1700000000000-1.log', ageDays: 90 },
    ],
    dirs: [
      `home/.copilot/session-state/${SESSION_A}/files`,
      `home/.copilot/session-state/${SESSION_A}/rewind-snapshots`,
      `home/.copilot/session-state/${SESSION_GONE}/files`,
      `home/.copilot/session-state/${SESSION_SUBDIR}/files`,
      'home/.copilot/ide',
      'home/.copilot/pkg',
    ],
    sqlite: [{ path: `${CU}/globalStorage/state.vscdb`, rewrite: [{ table: 'ItemTable', column: 'value' }] }],
  };
  w.json('fixture.json', fixture);

  w.write('README.md', caseReadme({ sessionDdl, vscdbDdl, dbs }));
  return { dir, files: w.files, bytes: w.bytes, dbs, live };
}

function caseReadme({ sessionDdl, vscdbDdl, dbs }) {
  const sessionBlock = [...SESSION_DB_TABLES.map((t) => sessionDdl.ddl.tables[t]), ...sessionDdl.ddl.indexes].join(';\n\n') + ';\n';
  const vscdbBlock = [vscdbDdl.ddl.tables.ItemTable, ...vscdbDdl.ddl.indexes].join(';\n\n') + ';\n';
  const rows = SESSION_DB_TABLES.map((t) => `\`${t}\` ${dbs.session.rows[t]}`).join(', ');
  return `# copilot / trust-and-sessions

GitHub Copilot as a developer Mac leaves it in 2026, on both surfaces: the **Copilot CLI**
(\`~/.copilot\`: trusted folders, session state, user MCP config, skills fan-out) and **VS Code**
(\`~/Library/Application Support/Code/User\`: workspace storage, global state, user settings and
MCP config), plus two repositories under the root. One repository carries the full set of
project-scope customisation files, the other only a \`.github/\` that Copilot does not read.
Generated by \`fixtures/_capture/copilot.mjs\`; every value is redacted or synthetic.

## Layout

\`home/\` (the user's home)

- \`.copilot/config.json\` — real top-level keys, every value \`<redacted>\`; \`trusted_folders\` is
  replaced by \`[<ROOT>/project-a, <ROOT>/gone, <HOME>]\` (the home directory as a trusted folder
  was not observed on the source machine; it is carried on purpose).
- \`.copilot/mcp-config.json\` — **synthetic** (never captured): \`mcpServers\` with one \`type: local\`
  and one \`type: http\` server, documented keys only.
- \`.copilot/copilot-instructions.md\`, \`.copilot/instructions/global.instructions.md\` — user-scope
  instructions (documented; absent on the source machine; synthetic filler).
- \`.copilot/session-state/<uuid>/\` — three synthetic sessions (research 09 key list; nothing read):
  - \`${SESSION_A}\` — cwd \`<ROOT>/project-a\`, full key set (\`git_root == cwd\`,
    \`repository\`, \`branch\`, \`summary\`), \`events.jsonl\` (2 synthetic lines: line 1 carries
    \`data.context.cwd\` / \`.repository\`), \`checkpoints/{index.md,001-checkpoint.md}\`, \`plan.md\`,
    \`session.db\` (tiny SQLite, DDL below), empty \`files/\` and \`rewind-snapshots/\`. Age 3 days.
  - \`${SESSION_GONE}\` — cwd \`<ROOT>/gone\` (ghost), the minimal key set
    (\`id, cwd, summary_count, created_at, updated_at\` — 1 of 18 real sessions looks like this),
    no \`events.jsonl\` (3 of 18 real sessions have none). Age 200 days.
  - \`${SESSION_SUBDIR}\` — cwd \`<ROOT>/project-a/packages/api\` with
    \`git_root: <ROOT>/project-a\`. **Not observed** on the source machine (17/17 sessions had
    \`git_root == cwd\`); included so the adapter's fold-to-git-root path is testable. Age 40 days.
- \`.copilot/skills/skill-a\` — symlink \`../../.agents/skills/skill-a\` (Vercel skills fan-out),
  created at copy time from \`fixture.json\`; the target is in \`home/.agents/skills/\`.
- \`.copilot/logs/process-1700000000000-1.log\` — one synthetic log (name pattern
  \`process-<ts>-<pid>.log\`), 90 days old. \`ide/\` and \`pkg/\` are declared as empty dirs.
- Real checkpoint files are named \`NNN-<title-slug>.md\`, the slug being derived from the
  conversation (a file *name* that leaks content); the fixture uses \`001-checkpoint.md\`. Real
  sessions may also hold a \`research/\` directory (4 of 18) whose shape was not captured.
- Not present on purpose: \`mcp-oauth-config/\`, \`command-history-state.json\` (shape not
  captured), \`session-store.db\` (documented, absent on the source machine),
  \`rewind-snapshots/index.json\` and \`rewind-snapshots/backups/\` (shape not captured).
- \`Library/Application Support/Code/User/\` (VS Code):
  - \`workspaceStorage/<id>/workspace.json\` — \`{ "folder": "file://<ROOT>/project-a" }\` twice
    (ids \`1111…\` and \`2222…\`: VS Code kept two storage dirs for one folder on the source machine),
    \`file://<HOME>\` (\`3333…\`) and \`file://<ROOT>/gone\` (\`4444…\`, 200 days old).
  - \`globalStorage/state.vscdb\` — tiny SQLite, \`ItemTable\` with 2 rows:
    \`history.recentlyOpenedPathsList\` (\`entries[]\` of \`folderUri\` / \`fileUri\` / \`workspace\`
    shapes) and \`content.trust.model.key\` (\`uriTrustInfo[]\`). Values are JSON text containing
    \`file://<ROOT>…\` and \`<HOME>\` placeholders: \`fixture.json\` lists the column under \`sqlite\`.
  - \`globalStorage/storage.json\` — schema keys kept, values redacted, hash/uuid-shaped keys (per-workspace ids) dropped; \`profileAssociations.workspaces\` maps the
    three folder URIs, \`windowsState.lastActiveWindow.folder\` is \`file://<HOME>\`.
  - \`settings.json\` — only \`chat.*\` and \`github.copilot*\` keys survive from the real file (values
    redacted); the documented location maps (\`chat.instructionsFilesLocations\`,
    \`chat.agentFilesLocations\`, \`chat.promptFilesLocations\`, \`chat.agentSkillsLocations\`, object
    maps path → boolean, \`~\` expands to home) and the \`chat.use*MdFile\` booleans are synthetic.
  - \`mcp.json\` — **synthetic**: \`servers\` (\`type: http\`) + \`inputs\` (\`promptString\`).

\`root/\` (the projects side)

- \`project-a/\` — git repository (\`_git/HEAD\` → \`.git/HEAD\`). Copilot files:
  \`.github/copilot-instructions.md\` (line count and byte size mirrored from a real one, body is
  filler), \`.github/instructions/api.instructions.md\` (frontmatter \`applyTo\`, \`description\`),
  \`.github/skills/skill-a/SKILL.md\`, \`.github/agents/reviewer.md\` (no \`.agent.md\` suffix) and
  \`.github/agents/planner.agent.md\` (documented suffix), \`.github/prompts/x.prompt.md\`
  (\`agent: agent\`), \`.github/mcp.json\` (Copilot CLI shape, \`mcpServers\`, \`stdio\` + \`sse\`),
  \`.vscode/mcp.json\` (VS Code shape, \`servers\` + \`inputs\`), \`.vscode/settings.json\` with a
  \`chat.instructionsFilesLocations\` entry pointing at \`docs/instructions/\` (which holds
  \`db.instructions.md\`), root \`AGENTS.md\` and nested \`packages/api/AGENTS.md\`. Non-Copilot files
  in \`.github/\`: \`ISSUE_TEMPLATE.md\`, \`PULL_REQUEST_TEMPLATE.md\`, \`workflows/ci.yml\`.
- \`project-b/\` — git repository whose \`.github/\` holds only \`workflows/\`, \`CODEOWNERS\`,
  \`dependabot.yml\`, and whose \`.vscode/\` has no \`mcp.json\`. No breadcrumb names it.
- \`gone/\` — does not exist; named by \`trusted_folders\`, a session, a workspaceStorage dir,
  \`state.vscdb\` and \`storage.json\`.

## Edge cases carried

1. Trusted folders: an existing repo, a ghost, and the home directory.
2. Session cwd vs git root: equal (A), absent keys (GONE), subdirectory (SUBDIR).
3. A session directory without \`events.jsonl\`; sessions of three ages (3 / 40 / 200 days) so
   "older than N days" rules are testable; the session directories themselves are aged too.
4. Markdown inside session state (\`plan.md\`, \`checkpoints/*.md\`) that is **not** a context file.
5. A SQLite file (\`session.db\`) inside session state that carries no path column.
6. Two VS Code workspaceStorage dirs for one folder (dedupe by \`workspace.json\`), a workspace for
   \`<HOME>\`, a ghost workspace; \`state.vscdb\` entries of three shapes (\`folderUri\`, \`fileUri\`,
   \`workspace\`) where a \`fileUri\` must not be taken for a folder; trust entries for \`<ROOT>\`
   and \`<HOME>\`.
7. Two MCP schemas side by side: \`mcpServers\` (CLI: \`local|stdio|http|sse\`) in
   \`~/.copilot/mcp-config.json\` and \`.github/mcp.json\`, \`servers\` + \`inputs\` (VS Code:
   \`stdio|http|sse\`) in \`User/mcp.json\` and \`.vscode/mcp.json\`. The CLI does not read
   \`.vscode/mcp.json\`.
8. \`.github/agents/\` with and without the \`.agent.md\` suffix; \`.github/\` files that are
   templates or workflows, not instructions; a repository whose \`.github/\` never qualifies.
9. User settings that widen discovery: \`chat.instructionsFilesLocations\` with a \`~/\` path and a
   disabled entry, \`chat.agentSkillsLocations\` naming \`.claude/skills\` and \`~/.claude/skills\`;
   a project setting adding \`docs/instructions/\`.
10. A skill reachable through \`~/.copilot/skills\` only by symlink (realpath dedupe with
    \`~/.agents/skills\`); a project skill under \`.github/skills\`.

## What is synthetic

Everything except: the key names of \`~/.copilot/config.json\`, the \`chat.*\` / \`github.copilot*\`
key names of the VS Code user \`settings.json\`, the key names of \`globalStorage/storage.json\`,
the line count and byte size of \`copilot-instructions.md\`, and the two SQLite DDLs below. All
MCP files, every \`workspace.yaml\`, \`events.jsonl\`, checkpoint, plan, log, Markdown body,
\`workspace.json\`, every database row, every id (\`00000000-0000-4000-8000-00000000000N\`,
\`1111…\`–\`4444…\`) and timestamp (\`${ISO_NOW}\`, \`${ISO_OLD}\`, epoch 1700000000000 ms) are made up.
Session event type names (\`session.start\`, \`user.message\`) are placeholders: only the
\`data.context.cwd\` / \`data.context.repository\` fields are documented.

## Slug rule

Copilot has no path-derived slug directories, so \`__HOME__\` / \`__ROOT__\` are not used.
Copilot CLI sessions are keyed by a UUID directory whose \`workspace.yaml\` carries \`cwd\` (and
usually \`git_root\`) verbatim. VS Code's \`workspaceStorage/<id>\` is a hash of the folder URI that
the test helper cannot recompute; the adapter must read \`workspace.json\` inside it, which holds
the folder as a \`file://\` URI (\`file://<ROOT>/project-a\` here — the placeholder begins with
\`/\`, so the rewritten URI has the usual three slashes; a Windows root would need
percent-encoding, which the helper does not do). Inside \`state.vscdb\` the placeholders sit in
JSON text in \`ItemTable.value\`; \`fixture.json\` lists that column under \`sqlite\` for a textual
\`REPLACE\`.

## Database DDL

\`session-state/<uuid>/session.db\` — read from \`sqlite_master\` of a real per-session database
(opened \`?mode=ro\`)${sessionDdl.live ? '' : ' — fallback snapshot used at generation time'}. Rows: ${rows}.

\`\`\`sql
${sessionBlock}\`\`\`

\`globalStorage/state.vscdb\` — read from \`sqlite_master\` of the real VS Code global state
(opened \`?mode=ro\`)${vscdbDdl.live ? '' : ' — fallback snapshot used at generation time'}. Rows: \`ItemTable\` ${dbs.vscdb.rows}.

\`\`\`sql
${vscdbBlock}\`\`\`
`;
}

// ---------------------------------------------------------------- main

mkdirSync(join(FIXTURES, 'copilot'), { recursive: true });
const result = caseTrustAndSessions();
const rel = relative(process.cwd(), result.dir) || result.dir;
console.log(`case ${rel}: ${result.files} files, ${result.bytes} bytes (session.db ${result.dbs.session.bytes} bytes, state.vscdb ${result.dbs.vscdb.bytes} bytes)`);
console.log(`sources live: ${Object.entries(result.live).filter(([, v]) => v).length}/${Object.keys(result.live).length} (${Object.entries(result.live).map(([k, v]) => `${k}=${v ? 'live' : 'fallback'}`).join(', ')})`);
if (result.bytes > MAX_CASE_BYTES) throw new Error('case exceeds 300 KB');
for (const [name, db] of Object.entries(result.dbs)) if (db.bytes > MAX_DB_BYTES) throw new Error(`${name} exceeds 100 KB`);
