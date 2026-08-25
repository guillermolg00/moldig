#!/usr/bin/env node
// Regenerates fixtures/codex/<case>/ from this machine (OpenAI Codex CLI + desktop app).
//
// Reproducible, dependency-free (node: built-ins only), idempotent: it deletes and
// recreates ONLY the case directories it owns. It reads STRUCTURE from the real Codex
// files (TOML key names, Markdown line/byte counts, SQLite DDL) and writes anonymised
// trees per fixtures/README.md plus the ticket-15 extensions. It never copies a value,
// a transcript, a database row or a rule, and it prints only counts and fixture paths.
//
// Sources touched (read-only):
//   $CODEX_HOME/config.toml            parsed; every string value becomes "<redacted>",
//                                      [mcp_servers.*] and [projects.*] tables are dropped
//                                      and re-synthesised from the documented shape
//   $CODEX_HOME/state_5.sqlite         opened ?mode=ro (fallback ?immutable=1); only
//                                      sqlite_master rows for threads/projects/project_roots
//   $CODEX_HOME/memories/*.md          line/byte counts only (first .md, name never used)
//   $CODEX_HOME/skills/{vercel-react-best-practices,.system/skill-creator}/SKILL.md
//                                      line/byte counts + frontmatter key names (public skills)
//   $CODEX_HOME/skills/vercel-react-best-practices/metadata.json   key names only
// Nothing named *auth*, *mcp*, *cred*, *secret*, *token*, *key*, *.env* is ever opened.
// Sessions, history, shell snapshots and desktop state are SYNTHESISED, never read.
//
// When the real database is absent the DDL comes from the sidecar snapshot
// fixtures/_capture/codex.ddl.json, which this script (re)writes whenever the live
// database was readable.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { zstdCompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '..');
const HOME = homedir();
const SRC = process.env.CODEX_HOME || join(HOME, '.codex');
const DDL_SNAPSHOT = join(HERE, 'codex.ddl.json');

const REDACTED = '<redacted>';
const T_S = 1_700_000_000; // fixed synthetic epoch, seconds (2023-11-14T22:13:20Z)
const T_MS = T_S * 1000;
const DAY_S = 86_400;
const FORBIDDEN = /mcp|auth|oauth|cred|secret|token|key|\.env|google_accounts/i;
const SCHEMA_KEY = /^[a-z][a-z0-9_]{0,40}$/; // Codex config keys are snake_case; anything else is user-named
const PUBLIC_SKILLS = new Set(['vercel-react-best-practices', 'web-design-guidelines', 'find-skills', 'skill-creator']);
const STATE_TABLES = ['threads', 'projects', 'project_roots'];
const MAX_CASE_BYTES = 300 * 1024;
const MAX_DB_BYTES = 100 * 1024;
const MAX_USER_NAMED = 3; // user-named sub-tables kept per parent (plugins.*, marketplaces.*, …)

const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// ---------------------------------------------------------------- generic helpers

function assertReadable(path) {
  if (FORBIDDEN.test(relative(SRC, path))) throw new Error('refusing to open a file matching the forbidden name list');
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
 * skill `name` may stay, otherwise `skill-a`); the body is filler with the same line
 * count and roughly the same byte size. `fallback` = {keys, lines, bytes} is used when
 * the real file is absent or unreadable.
 */
function mirrorMarkdown(srcPath, { fallback, skillName } = {}) {
  let keys = fallback?.keys ?? [];
  let bodyLines = fallback?.lines ?? 20;
  let bodyBytes = fallback?.bytes ?? 600;
  let live = false;
  try {
    assertReadable(srcPath);
    if (existsSync(srcPath)) {
      const lines = readFileSync(srcPath, 'utf8').split('\n');
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
  return { text: fm + filler(bodyLines, bodyBytes), live, lines: bodyLines, bytes: bodyBytes };
}

/** Walk a parsed JSON structure keeping only keys, booleans, null and small integers. */
function redactJson(value) {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isInteger(value) && Math.abs(value) < 1000 ? value : 0;
  if (typeof value === 'string') return REDACTED;
  if (Array.isArray(value)) return value.slice(0, 3).map(redactJson);
  if (typeof value === 'object') {
    const out = {};
    let n = 0;
    for (const [k, v] of Object.entries(value)) out[/^[A-Za-z0-9_$.-]{1,40}$/.test(k) ? k : `entry-${++n}`] = redactJson(v);
    return out;
  }
  return REDACTED;
}

function readJsonRedacted(path, fallback) {
  try {
    assertReadable(path);
    if (!existsSync(path)) return { value: fallback, live: false };
    return { value: redactJson(JSON.parse(readFileSync(path, 'utf8'))), live: true };
  } catch {
    return { value: fallback, live: false };
  }
}

class CaseWriter {
  constructor(dir) {
    this.dir = dir;
    this.paths = [];
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  write(rel, content) {
    const abs = join(this.dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.paths.push(rel);
  }
  json(rel, value) {
    this.write(rel, JSON.stringify(value, null, 2) + '\n');
  }
  measure() {
    let bytes = 0;
    for (const rel of this.paths) bytes += statSync(join(this.dir, rel)).size;
    return { files: this.paths.length, bytes };
  }
}

// ---------------------------------------------------------------- TOML (structure only)
//
// A small TOML 1.0 reader that keeps key names and value KINDS. String contents are
// consumed and discarded (escapes are not decoded: the value never survives).
// Values: {kind:'string'|'number'|'bool'|'datetime'|'array'|'inline'|'table', ...}

class Toml {
  constructor(text) {
    this.s = text;
    this.i = 0;
  }
  get c() {
    return this.s[this.i];
  }
  eof() {
    return this.i >= this.s.length;
  }
  at(str) {
    return this.s.startsWith(str, this.i);
  }
  ws() {
    while (this.c === ' ' || this.c === '\t') this.i++;
  }
  comment() {
    if (this.c === '#') while (!this.eof() && this.c !== '\n') this.i++;
  }
  blank() {
    for (;;) {
      this.ws();
      this.comment();
      if (this.c === '\n' || this.c === '\r') {
        this.i++;
        continue;
      }
      return;
    }
  }
  expect(ch) {
    if (this.c !== ch) throw new Error(`toml: expected ${ch} at offset ${this.i}`);
    this.i++;
  }
  eol() {
    this.ws();
    this.comment();
    if (!this.eof() && this.c !== '\n' && this.c !== '\r') throw new Error(`toml: trailing data at offset ${this.i}`);
  }
  document() {
    const root = {};
    const tables = [];
    let cur = root;
    for (;;) {
      this.blank();
      if (this.eof()) break;
      if (this.c === '[') {
        const isArray = this.s[this.i + 1] === '[';
        this.i += isArray ? 2 : 1;
        const keys = this.key();
        this.ws();
        this.expect(']');
        if (isArray) this.expect(']');
        cur = {};
        tables.push({ keys, isArray, entries: cur });
      } else {
        const keys = this.key();
        this.ws();
        this.expect('=');
        this.ws();
        setPath(cur, keys, this.value());
      }
      this.eol();
    }
    return { root, tables };
  }
  key() {
    const parts = [];
    for (;;) {
      this.ws();
      let part;
      if (this.c === '"') part = this.basicString();
      else if (this.c === "'") part = this.literalString();
      else {
        const m = /^[A-Za-z0-9_-]+/.exec(this.s.slice(this.i, this.i + 512));
        if (!m) throw new Error(`toml: bad key at offset ${this.i}`);
        part = m[0];
        this.i += part.length;
      }
      parts.push(part);
      this.ws();
      if (this.c === '.') {
        this.i++;
        continue;
      }
      return parts;
    }
  }
  basicString() {
    this.expect('"');
    let out = '';
    for (;;) {
      if (this.eof() || this.c === '\n') throw new Error('toml: unterminated string');
      if (this.c === '"') {
        this.i++;
        return out;
      }
      if (this.c === '\\') {
        this.i += 2;
        out += '_';
        continue;
      }
      out += this.c;
      this.i++;
    }
  }
  literalString() {
    this.expect("'");
    const end = this.s.indexOf("'", this.i);
    if (end < 0) throw new Error('toml: unterminated literal string');
    const out = this.s.slice(this.i, end);
    this.i = end + 1;
    return out;
  }
  multiBasic() {
    this.i += 3;
    for (;;) {
      if (this.eof()) throw new Error('toml: unterminated multi-line string');
      if (this.c === '\\') {
        this.i += 2;
        continue;
      }
      if (this.at('"""')) {
        this.i += 3;
        while (this.c === '"') this.i++;
        return;
      }
      this.i++;
    }
  }
  multiLiteral() {
    this.i += 3;
    const end = this.s.indexOf("'''", this.i);
    if (end < 0) throw new Error('toml: unterminated multi-line literal');
    this.i = end + 3;
    while (this.c === "'") this.i++;
  }
  value() {
    if (this.at('"""')) {
      this.multiBasic();
      return { kind: 'string' };
    }
    if (this.at("'''")) {
      this.multiLiteral();
      return { kind: 'string' };
    }
    if (this.c === '"') {
      this.basicString();
      return { kind: 'string' };
    }
    if (this.c === "'") {
      this.literalString();
      return { kind: 'string' };
    }
    if (this.c === '[') return this.array();
    if (this.c === '{') return this.inline();
    if (this.at('true') || this.at('false')) {
      const v = this.at('true');
      this.i += v ? 4 : 5;
      return { kind: 'bool', value: v };
    }
    const m = /^[+-]?[0-9A-Za-z_.:+-]+/.exec(this.s.slice(this.i, this.i + 128));
    if (!m) throw new Error(`toml: bad value at offset ${this.i}`);
    let token = m[0];
    this.i += token.length;
    if (/^\d{4}-\d{2}-\d{2}$/.test(token) && /^ \d{2}:/.test(this.s.slice(this.i, this.i + 4))) {
      const t = /^ [0-9:.+-Zz]+/.exec(this.s.slice(this.i, this.i + 64));
      this.i += t[0].length;
      token += t[0];
    }
    if (/^(\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2})/.test(token)) return { kind: 'datetime' };
    if (/^[+-]?(inf|nan)$/.test(token)) return { kind: 'number', value: 0 };
    if (/^[+-]?(0x[0-9A-Fa-f_]+|0o[0-7_]+|0b[01_]+|[0-9_]+(\.[0-9_]+)?([eE][+-]?[0-9_]+)?)$/.test(token)) {
      const n = Number(token.replace(/_/g, ''));
      return { kind: 'number', value: Number.isFinite(n) ? n : 0 };
    }
    throw new Error(`toml: unrecognised value at offset ${this.i}`);
  }
  array() {
    this.expect('[');
    const items = [];
    for (;;) {
      this.blank();
      if (this.c === ']') {
        this.i++;
        return { kind: 'array', items };
      }
      items.push(this.value());
      this.blank();
      if (this.c === ',') {
        this.i++;
        continue;
      }
      if (this.c === ']') {
        this.i++;
        return { kind: 'array', items };
      }
      throw new Error(`toml: bad array at offset ${this.i}`);
    }
  }
  inline() {
    this.expect('{');
    const entries = {};
    this.ws();
    if (this.c === '}') {
      this.i++;
      return { kind: 'inline', entries };
    }
    for (;;) {
      const keys = this.key();
      this.ws();
      this.expect('=');
      this.ws();
      setPath(entries, keys, this.value());
      this.ws();
      if (this.c === ',') {
        this.i++;
        this.ws();
        continue;
      }
      this.expect('}');
      return { kind: 'inline', entries };
    }
  }
}

function setPath(obj, keys, value) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!cur[k] || cur[k].kind !== 'table') cur[k] = { kind: 'table', entries: {} };
    cur = cur[k].entries;
  }
  cur[keys.at(-1)] = value;
}

// redaction: key names survive when they look like schema keys, every string becomes
// "<redacted>", numbers survive only when small integers, arrays are capped at 3 items.
function redactValue(v) {
  switch (v.kind) {
    case 'string':
    case 'datetime':
      return { kind: 'string', value: REDACTED };
    case 'number':
      return { kind: 'number', value: Number.isInteger(v.value) && Math.abs(v.value) <= 65535 ? v.value : 0 };
    case 'bool':
      return v;
    case 'array':
      return { kind: 'array', items: v.items.slice(0, 3).map(redactValue) };
    case 'inline':
      return { kind: 'inline', entries: redactEntries(v.entries) };
    case 'table':
      return { kind: 'table', entries: redactEntries(v.entries) };
  }
  throw new Error('toml: unknown value kind');
}

function redactEntries(entries) {
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(entries)) out[SCHEMA_KEY.test(k) ? k : `entry-${++n}`] = redactValue(v);
  return out;
}

/** Nested `kind:'table'` entries become their own records so tables can be merged by path. */
function flattenTables(records) {
  const out = [];
  const walk = (keys, entries, isArray) => {
    const flat = {};
    const nested = [];
    for (const [k, v] of Object.entries(entries)) {
      if (v.kind === 'table') nested.push([k, v.entries]);
      else flat[k] = v;
    }
    out.push({ keys, isArray, entries: flat });
    for (const [k, e] of nested) walk([...keys, k], e, false);
  };
  for (const r of records) walk(r.keys, r.entries, r.isArray);
  return out;
}

function mergeTables(records) {
  const out = [];
  const byPath = new Map();
  for (const r of records) {
    const path = r.keys.join('\u0000');
    if (!r.isArray && byPath.has(path)) Object.assign(byPath.get(path).entries, r.entries);
    else {
      const copy = { keys: r.keys, isArray: r.isArray, entries: { ...r.entries } };
      out.push(copy);
      if (!r.isArray) byPath.set(path, copy);
    }
  }
  return out;
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
const fmtKey = (k) => (BARE_KEY.test(k) ? k : `"${k.replace(/["\\]/g, '')}"`);
function fmtValue(v) {
  switch (v.kind) {
    case 'string':
      return `"${v.value}"`;
    case 'number':
      return String(v.value);
    case 'bool':
      return v.value ? 'true' : 'false';
    case 'array':
      return `[${v.items.map(fmtValue).join(', ')}]`;
    case 'inline': {
      const parts = Object.entries(v.entries).map(([k, x]) => `${fmtKey(k)} = ${fmtValue(x)}`);
      return parts.length ? `{ ${parts.join(', ')} }` : '{}';
    }
  }
  throw new Error('toml: cannot emit value kind');
}

function emitToml(header, rootScalars, tables) {
  const lines = header.map((l) => `# ${l}`);
  for (const [k, v] of Object.entries(rootScalars)) lines.push(`${fmtKey(k)} = ${fmtValue(v)}`);
  for (const t of tables) {
    lines.push('', `${t.isArray ? '[[' : '['}${t.keys.map(fmtKey).join('.')}${t.isArray ? ']]' : ']'}`);
    for (const [k, v] of Object.entries(t.entries)) lines.push(`${fmtKey(k)} = ${fmtValue(v)}`);
  }
  return lines.join('\n') + '\n';
}

// value constructors for synthetic blocks
const S = (v = REDACTED) => ({ kind: 'string', value: v });
const N = (v) => ({ kind: 'number', value: v });
const B = (v) => ({ kind: 'bool', value: v });
const A = (...items) => ({ kind: 'array', items });

// table paths whose children are named by the user (never schema keys)
const USER_NAMED_PARENTS = new Set([
  'profiles',
  'plugins',
  'permissions',
  'marketplaces',
  'model_providers',
  'apps',
  'agents',
  'hooks',
  'shell_environment_policy.set',
  'shell_environment_policy.filters',
  'tui.keymap',
]);

const CONFIG_FALLBACK_TOML = [
  // top-level keys observed on the source machine (research 02 §Codex, [126]); used only when
  // the real file is absent on the machine running this script
  'model = "x"',
  'model_reasoning_effort = "x"',
  'personality = "x"',
  'notify = ["x"]',
  'plan_mode_reasoning_effort = "x"',
  'service_tier = "x"',
].join('\n');

/**
 * Parse the real user config, keep key names + value kinds, drop the two user-keyed
 * maps (mcp_servers, projects) and rebuild them synthetically. Returns TOML text + counts.
 */
function userConfigToml() {
  const path = join(SRC, 'config.toml');
  let doc = null;
  let live = false;
  try {
    assertReadable(path);
    if (existsSync(path)) {
      doc = new Toml(readFileSync(path, 'utf8')).document();
      live = true;
    }
  } catch {
    doc = null;
    live = false;
  }
  if (!doc) doc = new Toml(CONFIG_FALLBACK_TOML).document();

  const counts = { topLevelKeys: 0, tables: 0, mcpServers: new Set(), projects: new Set() };
  const rootScalars = {};
  let records = [];
  const redactedRoot = redactEntries(doc.root);
  for (const [k, v] of Object.entries(redactedRoot)) {
    if (v.kind === 'table') records.push({ keys: [k], isArray: false, entries: v.entries });
    else {
      rootScalars[k] = v;
      counts.topLevelKeys++;
    }
  }

  const renamed = new Map();
  for (const t of doc.tables) {
    const [head, ...rest] = t.keys;
    counts.tables++;
    if (head === 'mcp_servers') {
      if (rest[0] !== undefined) counts.mcpServers.add(rest[0]);
      continue;
    }
    if (head === 'projects') {
      if (rest[0] !== undefined) counts.projects.add(rest[0]);
      continue;
    }
    if (!SCHEMA_KEY.test(head)) continue; // unknown top-level table name: dropped
    const keys = [head];
    let dropped = false;
    for (const seg of rest) {
      const parent = keys.join('.');
      if (SCHEMA_KEY.test(seg) && !USER_NAMED_PARENTS.has(parent)) keys.push(seg);
      else {
        // user-named child (plugin id, marketplace, profile, env var…): renamed entry-N, at most 3 per parent
        const id = `${parent}\u0000${seg}`;
        if (!renamed.has(id)) renamed.set(id, [...renamed.keys()].filter((x) => x.startsWith(parent + '\u0000')).length + 1);
        const n = renamed.get(id);
        if (n > MAX_USER_NAMED) {
          dropped = true;
          break;
        }
        keys.push(`entry-${n}`);
      }
    }
    if (dropped) continue;
    records.push({ keys, isArray: t.isArray, entries: redactEntries(t.entries) });
  }
  records = mergeTables(flattenTables(records));

  // synthetic: feature flags that the fixture's memories/ and hooks.json rely on
  let features = records.find((r) => !r.isArray && r.keys.length === 1 && r.keys[0] === 'features');
  if (!features) {
    features = { keys: ['features'], isArray: false, entries: {} };
    records.unshift(features);
  }
  features.entries.memories = B(true);
  features.entries.hooks = B(true);

  // synthetic: MCP servers, documented keys + transport enumerations only (never captured)
  records.push(
    {
      keys: ['mcp_servers', 'x'],
      isArray: false,
      entries: {
        command: S(),
        args: A(S(), S()),
        cwd: S('<ROOT>/project-a'),
        enabled: B(true),
        required: B(false),
        startup_timeout_sec: N(10),
        tool_timeout_sec: N(60),
        enabled_tools: A(S()),
        default_tools_approval_mode: S('prompt'),
      },
    },
    { keys: ['mcp_servers', 'x', 'env'], isArray: false, entries: { EXAMPLE_VAR: S() } },
    { keys: ['mcp_servers', 'x', 'tools', 'tool-a'], isArray: false, entries: { approval_mode: S('approve') } },
    {
      keys: ['mcp_servers', 'y'],
      isArray: false,
      entries: { url: S(), auth: S('oauth'), enabled: B(true), startup_timeout_sec: N(10), scopes: A(S()) },
    },
    { keys: ['mcp_servers', 'y', 'http_headers'], isArray: false, entries: { Authorization: S() } },
  );

  // synthetic: trust entries (the real file's 43 tables collapse to these)
  for (const [p, level] of [
    ['<ROOT>/project-a', 'trusted'],
    ['<ROOT>/project-b', 'untrusted'],
    ['<ROOT>/gone', 'trusted'],
    ['<ROOT>', 'trusted'],
    ['<HOME>', 'trusted'],
    ['/', 'trusted'],
  ]) {
    records.push({ keys: ['projects', p], isArray: false, entries: { trust_level: S(level) } });
  }

  const text = emitToml(
    [
      'fixture: key names mirrored from a real ~/.codex/config.toml, every value "<redacted>";',
      '[features], [mcp_servers.*] and [projects.*] are synthetic (documented shape, placeholder paths).',
    ],
    rootScalars,
    records,
  );
  new Toml(text).document(); // self-check: the emitted file must parse
  return { text, live, counts: { topLevelKeys: counts.topLevelKeys, tables: counts.tables, mcpServers: counts.mcpServers.size, projects: counts.projects.size } };
}

// ---------------------------------------------------------------- SQLite

function loadSnapshot() {
  if (!existsSync(DDL_SNAPSHOT)) throw new Error(`no live state_5.sqlite and no snapshot at ${DDL_SNAPSHOT}`);
  const snap = JSON.parse(readFileSync(DDL_SNAPSHOT, 'utf8'));
  return { tables: snap.tables, indexes: snap.indexes };
}

function readDdl() {
  const dbPath = join(SRC, 'state_5.sqlite');
  if (!existsSync(dbPath)) return { ddl: loadSnapshot(), live: false, mode: 'snapshot' };
  for (const [mode, uri] of [
    ['mode=ro', `file:${dbPath}?mode=ro`],
    ['immutable=1', `file:${dbPath}?immutable=1`],
  ]) {
    let db;
    try {
      db = new DatabaseSync(uri, { readOnly: true });
      const rows = db
        .prepare(
          "select type, name, tbl_name, sql from sqlite_master where sql is not null and type in ('table','index') and tbl_name in (?,?,?) order by tbl_name, type desc, name",
        )
        .all(...STATE_TABLES);
      const ddl = { tables: {}, indexes: [] };
      for (const r of rows) {
        if (r.type === 'table') ddl.tables[r.tbl_name] = r.sql;
        else ddl.indexes.push(r.sql);
      }
      if (!ddl.tables.threads) throw new Error('threads table not found');
      writeFileSync(DDL_SNAPSHOT, JSON.stringify({ source: 'state_5.sqlite', tables: ddl.tables, indexes: ddl.indexes }, null, 2) + '\n');
      return { ddl, live: true, mode };
    } catch {
      /* try the next open mode */
    } finally {
      db?.close();
    }
  }
  return { ddl: loadSnapshot(), live: false, mode: 'snapshot' };
}

const THREAD_ROWS = [
  { id: uuid(1), cwd: '<ROOT>/project-a', day: '2026-08-20', git: true, age: 5 },
  { id: uuid(2), cwd: '<ROOT>/project-a/packages/x', day: '2026-08-21', git: true, age: 4 },
  { id: uuid(3), cwd: '<ROOT>/gone', day: '2026-02-01', git: true, age: 205 },
  { id: uuid(4), cwd: '/', day: '2026-02-02', git: false, age: 204 },
];
const rolloutName = (day, id, ext = '.jsonl') => `rollout-${day}T10-00-00-${id}${ext}`;
const rolloutRel = (r, ext) => `home/.codex/sessions/${r.day.replaceAll('-', '/')}/${rolloutName(r.day, r.id, ext)}`;
const rolloutAbs = (r) => `<HOME>/.codex/${rolloutRel(r).slice('home/.codex/'.length)}`;

/** Value for one column of `threads`, chosen by name then by declared type. */
function threadColumnValue(col, spec, ordinal) {
  const name = col.name.toLowerCase();
  const type = (col.type || '').toUpperCase();
  if (name === 'id') return spec.id;
  if (name === 'cwd') return spec.cwd;
  if (name === 'rollout_path') return rolloutAbs(spec);
  if (name === 'project_id') return null; // always NULL on the source machine
  if (name.startsWith('git_')) return spec.git ? REDACTED : null;
  if (name === 'archived_at') return null; // nothing is archived
  if (/INT/.test(type)) {
    if (!/(_at$|_at_ms$|time|^ts$|created|updated)/.test(name)) return 0;
    const seconds = T_S - spec.age * DAY_S + ordinal;
    return name.endsWith('_ms') ? seconds * 1000 : seconds;
  }
  if (/REAL|FLOA|DOUB/.test(type)) return 0;
  if (/BLOB/.test(type)) return col.notnull ? new Uint8Array(0) : null;
  return REDACTED;
}

function buildDatabase(path, ddl) {
  mkdirSync(dirname(path), { recursive: true });
  // FK targets outside the discovery set are not created: do not enforce them while building
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: false });
  db.exec('PRAGMA page_size = 1024');
  db.exec('PRAGMA journal_mode = WAL'); // the real file runs in WAL mode; the header keeps the flag
  for (const t of STATE_TABLES) if (ddl.tables[t]) db.exec(ddl.tables[t]);
  for (const ix of ddl.indexes) db.exec(ix);

  const cols = db.prepare('PRAGMA table_info(threads)').all();
  const names = cols.map((c) => `"${c.name}"`).join(', ');
  const marks = cols.map(() => '?').join(', ');
  const ins = db.prepare(`INSERT INTO threads (${names}) VALUES (${marks})`);
  THREAD_ROWS.forEach((spec, i) => ins.run(...cols.map((c) => threadColumnValue(c, spec, i))));
  // projects and project_roots: 0 rows, as observed on the source machine

  const pathColumns = [];
  for (const t of STATE_TABLES) {
    if (!ddl.tables[t]) continue;
    for (const c of db.prepare(`PRAGMA table_info(${t})`).all()) {
      if (/^(cwd|path|rollout_path)$|_path$|_dir$/.test(c.name)) pathColumns.push({ table: t, column: c.name });
    }
  }
  db.exec('VACUUM');
  db.close();
  for (const sidecar of ['-wal', '-shm']) if (existsSync(path + sidecar)) unlinkSync(path + sidecar);

  // self-check: a read-only open sees the four rows. immutable=1 so that no -wal/-shm is
  // created next to the fixture (a plain mode=ro open of a WAL database does create them)
  const check = new DatabaseSync(`file:${path}?immutable=1`, { readOnly: true });
  const n = check.prepare('select count(*) as n from threads').get().n;
  check.close();
  for (const sidecar of ['-wal', '-shm']) if (existsSync(path + sidecar)) unlinkSync(path + sidecar);
  if (n !== THREAD_ROWS.length) throw new Error(`self-check: expected ${THREAD_ROWS.length} thread rows, found ${n}`);
  return { bytes: statSync(path).size, pathColumns, columnCount: cols.length };
}

// ---------------------------------------------------------------- synthetic blocks

const sessionMeta = (r) =>
  JSON.stringify({
    timestamp: `${r.day}T10:00:00.000Z`,
    type: 'session_meta',
    payload: {
      id: r.id,
      timestamp: `${r.day}T10:00:00.000Z`,
      cwd: r.cwd,
      originator: REDACTED,
      cli_version: '0.0.0',
      source: REDACTED,
      model_provider: REDACTED,
      git: r.git ? { branch: REDACTED, commit_hash: REDACTED, repository_url: REDACTED } : null,
    },
  }) + '\n';

const OLD_ROLLOUT = { id: uuid(5), day: '2025-09-01', age: 358 };
const ARCHIVED_ROLLOUT = { id: uuid(6), cwd: '<HOME>', day: '2026-01-15', git: false, age: 222 };
const ZST_ROLLOUT = { id: uuid(7), cwd: '/', day: '2026-03-01', git: false, age: 177 };
const SHELL_SNAPSHOT = `${uuid(8)}.${T_MS}000000.sh`;
const DESKTOP_TMP = `..codex-global-state.json.tmp-${T_MS}-${uuid(9)}`;

const PROJECT_CONFIG_TOML = `# project layer (loaded for every directory root->cwd, only when the project is trusted)
model_reasoning_effort = "<redacted>"
project_doc_max_bytes = 32768

[mcp_servers.project-server]
command = "<redacted>"
args = ["<redacted>"]
enabled = true
`;

const RULES = `# synthetic Starlark rules (documented keys only); the real rules files are never copied
prefix_rule(
    pattern = ["<redacted>"],
    decision = "allow",
    justification = "<redacted>",
)
prefix_rule(pattern = ["<redacted>", "<redacted>"], decision = "prompt", match = ["<redacted>"], not_match = ["<redacted>"])
prefix_rule(pattern = ["<redacted>"], decision = "forbidden")
`;

const hooksJson = (event) => ({
  hooks: {
    [event]: [{ matcher: REDACTED, hooks: [{ type: 'command', command: REDACTED, timeout: 30, statusMessage: REDACTED, async: false }] }],
    PreToolUse: [{ matcher: REDACTED, hooks: [{ type: 'mcp_tool', command: REDACTED, timeout: 30 }] }],
  },
});

const OPENAI_YAML = `interface:
  display_name: <redacted>
  short_description: <redacted>
policy:
  allow_implicit_invocation: true
`;

const desktopState = () => ({
  'active-workspace-roots': ['<ROOT>/project-a'],
  'local-projects': {
    [uuid(10)]: { createdAt: T_MS, id: uuid(10), name: REDACTED, rootPaths: ['<ROOT>/project-a'], updatedAt: T_MS },
    [uuid(11)]: { createdAt: T_MS - 200 * DAY_S * 1000, id: uuid(11), name: REDACTED, rootPaths: ['<ROOT>/gone'], updatedAt: T_MS - 150 * DAY_S * 1000 },
  },
  'pinned-thread-ids': [],
});

// ---------------------------------------------------------------- case: trust-and-state

function caseTrustAndState() {
  const dir = join(FIXTURES, 'codex', 'trust-and-state');
  const w = new CaseWriter(dir);
  const live = {};

  // ---- home/.codex: config + trust
  const cfg = userConfigToml();
  live.config = cfg.live;
  w.write('home/.codex/config.toml', cfg.text);
  w.write('home/.codex/AGENTS.override.md', ''); // empty: skipped, AGENTS.md wins
  w.write('home/.codex/AGENTS.md', filler(10, 400));
  w.write('home/.codex/rules/default.rules', RULES);
  w.json('home/.codex/hooks.json', hooksJson('SessionStart'));
  w.json('home/.codex/version.json', { latest_version: '0.0.0', last_checked_at: '2026-08-25T00:00:00Z', dismissed_version: '0.0.0' });

  // ---- home/.codex: state
  const { ddl, live: ddlLive, mode } = readDdl();
  live.ddl = ddlLive;
  const dbRel = 'home/.codex/state_5.sqlite';
  const db = buildDatabase(join(dir, dbRel), ddl);
  w.paths.push(dbRel);
  for (const r of THREAD_ROWS) w.write(rolloutRel(r), sessionMeta(r));
  w.write(
    `home/.codex/sessions/2025/09/01/${rolloutName(OLD_ROLLOUT.day, OLD_ROLLOUT.id)}`,
    JSON.stringify({ git: { branch: REDACTED, commit_hash: REDACTED, repository_url: REDACTED }, id: OLD_ROLLOUT.id, instructions: REDACTED, timestamp: `${OLD_ROLLOUT.day}T10:00:00.000Z` }) + '\n',
  );
  w.write(rolloutRel(ZST_ROLLOUT, '.jsonl.zst'), zstdCompressSync(Buffer.from(sessionMeta(ZST_ROLLOUT))));
  w.write(`home/.codex/archived_sessions/${rolloutName(ARCHIVED_ROLLOUT.day, ARCHIVED_ROLLOUT.id)}`, sessionMeta(ARCHIVED_ROLLOUT));
  w.write(
    'home/.codex/session_index.jsonl',
    THREAD_ROWS.slice(0, 2).map((r) => JSON.stringify({ id: r.id, thread_name: REDACTED, updated_at: `${r.day}T10:00:00Z` })).join('\n') + '\n',
  );
  w.write('home/.codex/history.jsonl', THREAD_ROWS.slice(0, 2).map((r, i) => JSON.stringify({ session_id: r.id, ts: T_S + i, text: REDACTED })).join('\n') + '\n');
  w.write(`home/.codex/shell_snapshots/${SHELL_SNAPSHOT}`, '# synthetic shell snapshot (Codex desktop app); the real files capture shell state and are never copied\n');

  // ---- home/.codex: memories (feature-flagged; documented names + the hand-named file seen on this machine)
  w.write('home/.codex/memories/MEMORY.md', filler(8, 300));
  let memorySrc = null;
  try {
    memorySrc = readdirSync(join(SRC, 'memories')).find((n) => n.endsWith('.md') && !FORBIDDEN.test(n)) ?? null;
  } catch {
    memorySrc = null;
  }
  const memory = mirrorMarkdown(memorySrc ? join(SRC, 'memories', memorySrc) : join(SRC, 'memories', 'none.md'), { fallback: { keys: [], lines: 12, bytes: 480 } });
  live.memory = memory.live;
  w.write('home/.codex/memories/memory-a.md', memory.text);

  // ---- home/.codex: desktop-app state (documented key names only; the real file is never read)
  w.json('home/.codex/.codex-global-state.json', desktopState());
  w.json('home/.codex/.codex-global-state.json.bak', desktopState());
  w.json(`home/.codex/${DESKTOP_TMP}`, desktopState());

  // ---- home/.codex/skills: symlink generation, real copies, bundled system skills
  w.write('home/.agents/skills/find-skills/SKILL.md', '---\nname: find-skills\ndescription: <redacted>\n---\n' + filler(18, 640));
  const vr = join(SRC, 'skills', 'vercel-react-best-practices');
  const vrSkill = mirrorMarkdown(join(vr, 'SKILL.md'), { skillName: 'vercel-react-best-practices', fallback: { keys: ['name', 'description'], lines: 120, bytes: 5200 } });
  live.skillMd = vrSkill.live;
  w.write('home/.codex/skills/vercel-react-best-practices/SKILL.md', vrSkill.text);
  const vrAgents = mirrorMarkdown(join(vr, 'AGENTS.md'), { fallback: { keys: [], lines: 2249, bytes: 60500 } });
  live.skillPayload = vrAgents.live;
  w.write('home/.codex/skills/vercel-react-best-practices/AGENTS.md', vrAgents.text);
  const meta = readJsonRedacted(join(vr, 'metadata.json'), { name: REDACTED, version: REDACTED });
  live.skillMetadata = meta.live;
  w.json('home/.codex/skills/vercel-react-best-practices/metadata.json', meta.value);
  w.write('home/.codex/skills/vercel-react-best-practices/rules/rule-a.md', filler(20, 700));
  w.write('home/.codex/skills/vercel-react-best-practices/agents/openai.yaml', OPENAI_YAML);
  const sys = mirrorMarkdown(join(SRC, 'skills', '.system', 'skill-creator', 'SKILL.md'), { skillName: 'skill-creator', fallback: { keys: ['name', 'description'], lines: 40, bytes: 1600 } });
  live.systemSkill = sys.live;
  w.write('home/.codex/skills/.system/skill-creator/SKILL.md', sys.text);
  w.write('home/.codex/skills/.system/skill-creator/agents/openai.yaml', OPENAI_YAML);
  w.write('home/.codex/skills/.system/.codex-system-skills.marker', '');

  // ---- root/: the projects side
  w.write('root/project-a/_git/HEAD', 'ref: refs/heads/main\n');
  w.write('root/project-a/AGENTS.md', filler(24, 960));
  w.write('root/project-a/AGENTS.override.md', filler(3, 100));
  w.write('root/project-a/packages/x/AGENTS.md', filler(6, 200));
  w.write('root/project-a/.codex/config.toml', PROJECT_CONFIG_TOML);
  w.write('root/project-a/.codex/rules/default.rules', RULES);
  w.json('root/project-a/.codex/hooks.json', hooksJson('UserPromptSubmit'));
  w.write('root/project-a/.codex/skills/vercel-react-best-practices/SKILL.md', vrSkill.text);
  w.write('root/project-a/.codex/skills/vercel-react-best-practices/AGENTS.md', filler(4, 120));
  w.write('root/project-a/.agents/skills/skill-b/SKILL.md', '---\nname: skill-b\ndescription: <redacted>\n---\n' + filler(10, 360));

  w.write('root/project-b/_git/HEAD', 'ref: refs/heads/main\n');
  w.write('root/project-b/AGENTS.md', filler(8, 300));
  w.write('root/project-b/.codex/config.toml', PROJECT_CONFIG_TOML);

  // ---- fixture.json
  const fixture = {
    renames: [
      { from: 'root/project-a/_git', to: 'root/project-a/.git' },
      { from: 'root/project-b/_git', to: 'root/project-b/.git' },
    ],
    symlinks: [{ path: 'home/.codex/skills/find-skills', target: '../../.agents/skills/find-skills', kind: 'dir' }],
    ages: [
      ...THREAD_ROWS.map((r) => ({ path: rolloutRel(r), ageDays: r.age })),
      { path: `home/.codex/sessions/2025/09/01/${rolloutName(OLD_ROLLOUT.day, OLD_ROLLOUT.id)}`, ageDays: OLD_ROLLOUT.age },
      { path: rolloutRel(ZST_ROLLOUT, '.jsonl.zst'), ageDays: ZST_ROLLOUT.age },
      { path: `home/.codex/archived_sessions/${rolloutName(ARCHIVED_ROLLOUT.day, ARCHIVED_ROLLOUT.id)}`, ageDays: ARCHIVED_ROLLOUT.age },
      { path: 'home/.codex/memories/memory-a.md', ageDays: 90 },
      { path: 'home/.codex/.codex-global-state.json.bak', ageDays: 40 },
      { path: `home/.codex/${DESKTOP_TMP}`, ageDays: 40 },
      { path: 'home/.codex/state_5.sqlite', ageDays: 0 },
      { path: 'home/.codex/history.jsonl', ageDays: 0 },
    ],
    dirs: ['home/.codex/log', 'home/.codex/memories/rollout_summaries'],
    sqlite: [{ path: dbRel, rewrite: db.pathColumns }],
  };
  w.json('fixture.json', fixture);

  // ---- README.md (generated so the DDL section stays in sync with the database)
  w.write('README.md', caseReadme({ ddl, ddlLive, mode, cfg, memory, vrSkill, vrAgents, sys, db }));

  return { dir, ...w.measure(), dbBytes: db.bytes, live, cfg: cfg.counts, mode };
}

function caseReadme({ ddl, ddlLive, mode, cfg, memory, vrSkill, vrAgents, sys, db }) {
  const ddlBlock = [...STATE_TABLES.filter((t) => ddl.tables[t]).map((t) => ddl.tables[t]), ...ddl.indexes].join(';\n\n') + ';\n';
  const rows = THREAD_ROWS.map((r) => `\`${r.cwd}\``).join(', ');
  const rewrite = db.pathColumns.map((c) => `\`${c.table}.${c.column}\``).join(', ');
  return `# codex / trust-and-state

An OpenAI Codex install (CLI + desktop app sharing \`~/.codex\`) as found on a developer Mac in
2026: a user \`config.toml\` whose trust entries still name directories that no longer exist, a
\`state_5.sqlite\` thread index and the rollout files it points at, feature-flagged memories, the
three generations of skill directories, user-scope rules/hooks, desktop-app state leftovers, and
two projects under the root (one trusted, one untrusted). Generated by
\`fixtures/_capture/codex.mjs\`; every value is redacted or synthetic.

## Layout

\`home/\` (the user's home; \`$CODEX_HOME\` = \`home/.codex\`)

- \`.codex/config.toml\` — ${cfg.counts.topLevelKeys} top-level keys mirrored from the real file, every value
  \`"<redacted>"\`. The real file's ${cfg.counts.tables} tables (${cfg.counts.mcpServers} \`[mcp_servers.*]\`, ${cfg.counts.projects} \`[projects.*]\`) are
  **not** copied: \`[mcp_servers.x]\` (stdio: \`command\`, \`args\`, \`cwd\`, \`env\` sub-table, \`tools.<tool>\`
  sub-table) and \`[mcp_servers.y]\` (streamable HTTP: \`url\`, \`auth = "oauth"\`, \`http_headers\` sub-table)
  are synthetic, and the trust map is rebuilt as six \`[projects."<path>"]\` tables (below). \`[features]\`
  carries \`memories = true\` and \`hooks = true\` so the memory and hook files are live. Other tables keep
  their schema names; user-named children (\`plugins.<id>\`, \`marketplaces.<name>\`, env var names…) become
  \`entry-N\`, at most ${MAX_USER_NAMED} per parent; arrays are capped at 3 items.
- \`.codex/AGENTS.md\` (user-scope instructions; this machine has none) and an **empty**
  \`AGENTS.override.md\` next to it: Codex takes the first non-empty of the two, so \`AGENTS.md\` wins.
- \`.codex/rules/default.rules\` — synthetic Starlark \`prefix_rule(...)\` lines with the documented keys
  (\`pattern\`, \`decision\`, \`justification\`, \`match\`, \`not_match\`); nothing from the real 50-line file.
- \`.codex/hooks.json\` — documented shape (\`hooks.<Event>[].{matcher,hooks[].{type,command,timeout,statusMessage,async}}\`).
- \`.codex/state_5.sqlite\` — tiny database built from the real DDL (below), WAL header flag kept, no
  \`-wal\`/\`-shm\` sidecars committed; \`threads\` has 4 rows whose \`cwd\` are ${rows}
  and whose \`rollout_path\` values point at the four session files below (0 dangling, as observed);
  \`project_id\` is NULL everywhere; \`projects\` and \`project_roots\` exist with 0 rows. \`threads\` keeps its
  real foreign keys (one of them to \`thread_sections\`, a table outside the discovery set that is not
  created here): reads are unaffected, writes with foreign keys enforced would fail. Because the header
  says WAL, opening the copy with \`?mode=ro\` in a writable directory **creates** \`-wal\` and \`-shm\`
  next to it, while \`?immutable=1\` creates nothing — a test can assert that a scan leaves the tree
  unchanged (research 09 notes the real file needs \`immutable=1\` or an existing \`-shm\` to open).
- \`.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl\` — one synthetic \`session_meta\` line each
  (\`{timestamp,type,payload{id,timestamp,cwd,originator,cli_version,source,model_provider,git{branch,commit_hash,repository_url}}}\`),
  no transcript content. Plus: \`sessions/2025/09/01/…\` in the **pre-2025-09-16 flat format**
  (\`{git,id,instructions,timestamp}\`, **no cwd**); \`sessions/2026/03/01/….jsonl.zst\` — a zstd-compressed
  rollout (cwd \`/\`, so it carries no placeholder); \`archived_sessions/rollout-….jsonl\` (flat, cwd \`<HOME>\`).
- \`.codex/session_index.jsonl\` (\`{id,thread_name,updated_at}\`) and \`.codex/history.jsonl\`
  (\`{session_id,ts,text}\`, 0600 on the real machine): 2 synthetic lines each; neither has a cwd.
- \`.codex/memories/\` — \`MEMORY.md\` (documented name, synthetic) and \`memory-a.md\` (mirrors the line
  count and byte size of the single hand-named memory file on this machine: ${memory.lines} lines, ~${memory.bytes} bytes);
  \`rollout_summaries/\` is an empty documented directory (declared in \`fixture.json\` \`dirs\`).
- \`.codex/shell_snapshots/<uuid>.<ns>.sh\` — one synthetic line; \`.codex/version.json\` — documented keys.
- \`.codex/.codex-global-state.json\` (+ \`.bak\`, + one \`..codex-global-state.json.tmp-<ms>-<uuid>\`
  leftover) — Codex **desktop** state with the documented keys \`active-workspace-roots\`,
  \`local-projects[<id>].{createdAt,id,name,rootPaths,updatedAt}\`, \`pinned-thread-ids\`; the real file
  was never read. \`local-projects\` names \`<ROOT>/project-a\` and \`<ROOT>/gone\`.
- \`.codex/skills/\` — three generations side by side: \`find-skills\` is a **symlink** to
  \`../../.agents/skills/find-skills\` (declared in \`fixture.json\`, the Vercel \`skills\` CLI layout);
  \`vercel-react-best-practices/\` is a real copy (older layout) with \`SKILL.md\` (${vrSkill.lines} body lines,
  ~${vrSkill.bytes} bytes), a 60 KB \`AGENTS.md\` **payload** (${vrAgents.lines} lines), \`metadata.json\` (real keys),
  \`rules/rule-a.md\` and a Codex \`agents/openai.yaml\`; \`.system/skill-creator/\` is a bundled system
  skill (${sys.lines} body lines) next to the \`.codex-system-skills.marker\` file.
- \`.agents/skills/find-skills/SKILL.md\` — the symlink target (canonical store).
- Empty directories: \`.codex/log\`, \`.codex/memories/rollout_summaries\` (\`fixture.json\` \`dirs\`).
- Not present on purpose: \`auth.json\`, \`.credentials.json\`, \`secrets/\`, \`mcp-oauth-locks/\`,
  \`logs_2.sqlite\` and the other \`*_N.sqlite\`, \`sqlite/*.db\` (desktop), \`models_cache.json\`,
  \`installation_id\`, \`plugins/\`, \`.tmp/\`, \`vendor_imports/\`, \`automations/\`, \`dictation-history/\`.

\`root/\` (the projects side)

- \`project-a/\` — git repository (\`_git/HEAD\` → \`.git/HEAD\`), **trusted**. Root \`AGENTS.md\` and an
  \`AGENTS.override.md\` (Codex loads the override and ignores \`AGENTS.md\` in that directory; both are
  context files for a scanner); nested \`packages/x/AGENTS.md\` (the sub-directory a session ran in);
  \`.codex/config.toml\` (project layer: a documented top-level key and \`[mcp_servers.project-server]\`),
  \`.codex/rules/default.rules\`, \`.codex/hooks.json\`, \`.codex/skills/vercel-react-best-practices/\`
  (project copy of the user-scope skill: same SKILL.md, small \`AGENTS.md\` payload) and
  \`.agents/skills/skill-b/\` (universal location).
- \`project-b/\` — git repository, **untrusted** in \`config.toml\`: its \`.codex/config.toml\` must not be
  loaded by Codex; \`AGENTS.md\` present.
- \`gone/\` — does not exist; \`config.toml\`, the database, a rollout and the desktop state all name it.

## Trust entries (\`[projects."…"] trust_level\`)

| Key | trust_level | Represents |
|---|---|---|
| \`<ROOT>/project-a\` | trusted | live repository |
| \`<ROOT>/project-b\` | untrusted | live repository whose project layer is gated off |
| \`<ROOT>/gone\` | trusted | orphan: directory gone |
| \`<ROOT>\` | trusted | container entry (like \`~/Work\` on the real machine): not a project |
| \`<HOME>\` | trusted | home recorded as a project: stray, never a project |
| \`/\` | trusted | filesystem root (Codex desktop "projectless" threads) |

## Edge cases carried

1. Trust map with a ghost, two containers (\`<ROOT>\`, \`<HOME>\`), \`/\`, and an \`untrusted\` entry.
2. \`threads.cwd\` for a sub-directory of a repository (\`packages/x\`): must fold to \`project-a\`.
3. \`threads.cwd = "/"\` and a rollout with cwd \`/\` (43% of the real sessions), plus one with \`<HOME>\`.
4. \`rollout_path\` values that resolve to real files (0 dangling) — a test can also delete one.
5. Old-format rollout without \`cwd\`; zstd-compressed rollout; \`archived_sessions/\` flat layout.
6. \`history.jsonl\` / \`session_index.jsonl\` carry no path: not breadcrumb sources.
7. Empty \`AGENTS.override.md\` at user scope (skipped) vs. non-empty one at project scope (wins).
8. Feature-flagged memories with a documented name and a hand-named \`*.md\` side by side.
9. Three skill-directory generations (symlink into \`~/.agents/skills\`, real copy, \`.system/\` bundle)
   and the same public skill duplicated at user and project scope; \`AGENTS.md\` inside skill payloads.
10. Desktop-app state with rotating \`.bak\` and \`.tmp-*\` leftovers (harness cache candidates).
11. Ages: ghost sessions ~200 days, old-format rollout ~1 year, memory 90 days, database fresh.

## What is synthetic

Everything that is not a key name, a directory name, a line count or a byte size: all TOML values,
the \`[features]\`, \`[mcp_servers.*]\` and \`[projects.*]\` tables, both project \`.codex/config.toml\`,
rules, hooks, every Markdown body, every JSONL line, the shell snapshot, the desktop state files,
every database row, ids (\`00000000-0000-4000-8000-0000000000NN\`) and timestamps (fixed epoch
1700000000 s / 1700000000000 ms minus round day offsets). \`cli_version\` and \`version.json\` carry
\`0.0.0\`. \`agents/openai.yaml\` uses the documented \`interface\`/\`policy\` keys.

## Slug rule

Codex has no path-derived slug directories: nothing in the tree is named after a project path, so
the \`__HOME__\`/\`__ROOT__\` name tokens are unused. Paths appear verbatim (placeholders \`<ROOT>\`/\`<HOME>\`)
in \`config.toml\` \`[projects."<path>"]\` headers and \`mcp_servers.x.cwd\`, in rollout line 1
\`payload.cwd\`, in \`.codex-global-state.json\` \`local-projects[].rootPaths\` / \`active-workspace-roots\`,
and inside the database in ${rewrite}; \`fixture.json\` lists those
table/column pairs under \`sqlite[].rewrite\` because a binary file cannot be rewritten textually. The
\`.jsonl.zst\` rollout deliberately carries no placeholder. Session file names follow
\`rollout-YYYY-MM-DDThh-mm-ss-<thread_uuid>.jsonl\` with a synthetic uuid.

## Database DDL

Read from \`sqlite_master\` of the real \`state_5.sqlite\` (opened \`?${ddlLive ? mode : 'mode=ro'}\`${ddlLive ? '' : ' — snapshot `fixtures/_capture/codex.ddl.json` used at generation time'});
only \`threads\`, \`projects\`, \`project_roots\` and their indexes. Rows: \`threads\` ${THREAD_ROWS.length}
(${db.columnCount} columns), \`projects\` 0, \`project_roots\` 0.

\`\`\`sql
${ddlBlock}\`\`\`
`;
}

// ---------------------------------------------------------------- leak check + main

/** Refuse to finish if any output byte names the real home directory or user name. */
function assertNoLeak(dir, paths) {
  const needles = [HOME, basename(HOME)].filter((s) => s.length >= 4);
  for (const rel of paths) {
    const buf = readFileSync(join(dir, rel));
    for (const n of needles) if (buf.includes(n)) throw new Error(`leak check failed in ${rel}`);
    if (rel.includes(basename(HOME))) throw new Error(`leak check failed in a file name`);
  }
}

const result = caseTrustAndState();
assertNoLeak(result.dir, readdirSync(result.dir, { recursive: true }).filter((p) => statSync(join(result.dir, p)).isFile()));
const rel = relative(process.cwd(), result.dir) || result.dir;
console.log(`case ${rel}: ${result.files} files, ${result.bytes} bytes (sqlite ${result.dbBytes} bytes, ddl ${result.mode})`);
console.log(`config.toml: ${result.cfg.topLevelKeys} top-level keys, ${result.cfg.tables} tables (${result.cfg.mcpServers} mcp_servers, ${result.cfg.projects} projects) mirrored as structure only`);
console.log(`sources live: ${Object.entries(result.live).filter(([, v]) => v).length}/${Object.keys(result.live).length}`);
if (result.bytes > MAX_CASE_BYTES) throw new Error('case exceeds 300 KB');
if (result.dbBytes > MAX_DB_BYTES) throw new Error('sqlite exceeds 100 KB');
