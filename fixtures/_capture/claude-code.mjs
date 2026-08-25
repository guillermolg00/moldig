#!/usr/bin/env node
// Regenerates fixtures/claude-code/<case>/ from this machine (Claude Code harness).
//
//   breadcrumbs          ~/.claude.json `projects` map (present / subdir / worktree / ghost / home /
//                        unreachable keys), the matching ~/.claude/projects/<slug>/ dirs (memory,
//                        synthetic transcripts, session dir), sweepable state (shell-snapshots,
//                        todos, tasks, backups), user settings, and one repository with a linked
//                        worktree plus every project-scope file Claude Code reads.
//   skills-and-plugins   ~/.claude/skills (real dir, Vercel symlink, dangling symlink, skills-dir
//                        plugin), the ~/.agents canonical store + lock, ~/.claude/plugins state
//                        files, one marketplace clone, the plugin cache (referenced, orphan and
//                        missing versions), and a project with a copied skill + skills-lock.json.
//
// Reproducible, dependency-free (node: built-ins only), idempotent: it deletes and recreates
// ONLY fixtures/claude-code/<case>. It reads STRUCTURE from real files named in
// docs/research/01-claude-code-on-disk-layout.md and 09-project-breadcrumbs-on-this-machine.md
// (JSON key names, Markdown line/byte counts), replaces every string value while walking, and
// prints only counts and fixture paths. Transcripts, tool results, shell snapshots, todo/task
// files and every MCP-server entry are SYNTHESISED from the documented shapes, never copied.
//
// Sources touched (read-only; nothing whose name matches the forbidden list is opened):
//   ~/.claude.json                                  parsed; every string -> "<redacted>", project keys -> placeholders
//   ~/.claude/projects/<slug of this repo>/memory/  MEMORY.md + two topic files: frontmatter keys, line + byte counts
//   ~/.claude/skills/<first real dir>/SKILL.md      and the SKILL.md behind the first Vercel symlink (~/.agents/skills)
//   ~/.agents/.skill-lock.json                      version + field names of one entry
//   ~/.claude/plugins/{installed_plugins,known_marketplaces,config,blocklist,plugin-catalog-cache}.json
//   ~/.claude/plugins/marketplaces/<one>/.claude-plugin/marketplace.json, cache/<one plugin>/.claude-plugin/plugin.json, hooks/hooks.json
//   project directories named in fixtures/_capture/sources.local.json (gitignored; see sources.example.json):
//     <contextProject>/CLAUDE.md, <nestedContextProject>/apps/web/CLAUDE.md, <skillsProject>/{skills-lock.json,.claude/skills/<first>/SKILL.md}
//
// Conventions (fixtures/README.md + ticket 15 extensions, aligned with gemini-cli.mjs / opencode.mjs):
//   - nested git entries are written as `_git` and declared in fixture.json "renames"
//   - symlinks are never committed; fixture.json "symlinks" records them, `target` = link text
//     relative to the link's parent (what the Vercel CLI writes on disk)
//   - empty directories cannot be committed; fixture.json "dirs" lists them
//   - absolute paths inside file contents use <HOME> / <ROOT>; slug directory NAMES use the
//     tokens __HOME__ / __ROOT__ (also inside contents that spell a slug path, see README)

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSources, sourceNeedles, sourcePath } from './_sources.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const OUT = join(REPO, 'fixtures', 'claude-code');
const HOME = homedir();
const CLAUDE = join(HOME, '.claude');
const AGENTS = join(HOME, '.agents');
const SOURCES = loadSources();
const SRC_CONTEXT_PROJECT = sourcePath(SOURCES.claudeCode?.contextProject); // '' when undeclared: fall back to documented shapes
const SRC_NESTED_PROJECT = sourcePath(SOURCES.claudeCode?.nestedContextProject);
const SRC_SKILLS_PROJECT = sourcePath(SOURCES.claudeCode?.skillsProject);
const srcOr = (root, ...parts) => (root ? join(root, ...parts) : '');

const REDACTED = '<redacted>';
const HASH = '<redacted-hash>';
const EPOCH_MS = 1_700_000_000_000; // fixed synthetic timestamp (2023-11-14T22:13:20Z)
const ISO = '2023-11-14T22:13:20.000Z';
const VERSION = '2.1.245'; // Claude Code version observed on the source machine
const IDENT = /^\$?[A-Za-z][A-Za-z0-9]*$/; // structural field names survive; anything else is a value in disguise
const OPAQUE_KEY = /^[0-9a-f]{16,}$|^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[0-9]{8,}$/i; // hashes, uuids, timestamps used as keys are values in disguise
const FORBIDDEN = /mcp|auth|oauth|cred|secret|token|key|\.env|google_accounts/i;
const MAX_CASE_BYTES = 300 * 1024;

// Synthetic session ids (RFC-4122 shaped, repeated digits; never a real id).
const UUID_A = '11111111-1111-4111-8111-111111111111'; // <ROOT>/project-a session (transcript exists)
const UUID_B = '22222222-2222-4222-8222-222222222222'; // <ROOT>/project-a/apps/web session (transcript in the subdir slug)
const UUID_C = '33333333-3333-4333-8333-333333333333'; // <ROOT>/gone: named by ~/.claude.json, exists in no slug dir
const UUID_D = '44444444-4444-4444-8444-444444444444'; // <ROOT>/project-a-wt session (transcript only, no key names it)

// ---------------------------------------------------------------- helpers

/** Claude Code slug: every non-alphanumeric character of the absolute path becomes `-`. */
const slug = (p) => p.replace(/[^A-Za-z0-9]/g, '-');

function readable(path) {
  if (FORBIDDEN.test(relative(HOME, path))) throw new Error('refusing to open a path matching the forbidden name list');
  return path;
}

/**
 * Walk parsed JSON keeping booleans, null and small integers; strings -> <redacted>.
 * Field names survive only at the document's top level (depth 0) and only when they look like
 * identifiers; every deeper key becomes `<redacted>-N` (skill, plugin, model and server names
 * live as keys in these files) and deeper maps/arrays are capped at 3 entries.
 */
function redact(v, depth = 0) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return 0;
    if (!Number.isInteger(v)) return 0.5;
    if (Math.abs(v) < 1000) return v;
    return v >= 1e11 ? EPOCH_MS : 1000;
  }
  if (typeof v === 'string') return REDACTED;
  if (Array.isArray(v)) return v.slice(0, 3).map((x) => redact(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    let n = 0;
    let kept = 0;
    for (const [k, x] of Object.entries(v)) {
      if (depth >= 1 && kept >= 3) break;
      out[depth === 0 && IDENT.test(k) && !OPAQUE_KEY.test(k) ? k : `${REDACTED}-${++n}`] = redact(x, depth + 1);
      kept++;
    }
    return out;
  }
  return REDACTED;
}

function readJson(path) {
  try {
    readable(path);
    if (!existsSync(path)) return { raw: null, value: null, live: false };
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    return { raw, value: redact(raw), live: true };
  } catch {
    return { raw: null, value: null, live: false };
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
 * Mirror a Markdown file: frontmatter KEYS survive (boolean values kept, `name` set to the
 * fixture's own name, everything else `<redacted>`), the body becomes filler with the same
 * line count and roughly the same byte size. `fallback` = {keys, lines, bytes} when absent.
 */
function mirrorMarkdown(srcPath, { fallback, name } = {}) {
  let keys = (fallback?.keys ?? []).map((k) => [k, null]);
  let bodyLines = fallback?.lines ?? 20;
  let bodyBytes = fallback?.bytes ?? 600;
  let live = false;
  try {
    readable(srcPath);
    if (existsSync(srcPath) && statSync(srcPath).isFile()) {
      const text = readFileSync(srcPath, 'utf8');
      const lines = text.split('\n');
      let bodyStart = 0;
      if (lines[0] === '---') {
        const end = lines.indexOf('---', 1);
        if (end > 0) {
          keys = lines
            .slice(1, end)
            .map((l) => l.match(/^([A-Za-z0-9_-]+):\s*(true|false)?\s*$/) ?? l.match(/^([A-Za-z0-9_-]+):/))
            .filter(Boolean)
            .map((m) => [m[1], m[2] ?? null]);
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
    for (const [k, bool] of keys) fm += `${k}: ${k === 'name' && name ? name : bool ?? REDACTED}\n`;
    fm += '---\n';
  }
  return { text: fm + filler(bodyLines, bodyBytes), live, lines: bodyLines };
}

const fm = (pairs, body) => `---\n${pairs.map(([k, v]) => `${k}: ${v}`).join('\n')}\n---\n${body}`;
const skillMd = (name, lines, bytes) => fm([['name', name], ['description', REDACTED]], filler(lines, bytes));

class CaseWriter {
  constructor(name) {
    this.name = name;
    this.dir = join(OUT, name);
    this.files = 0;
    this.bytes = 0;
    this.renames = [];
    this.symlinks = [];
    this.ages = [];
    this.dirs = [];
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }
  write(rel, content) {
    const abs = join(this.dir, ...rel.split('/'));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.files++;
    this.bytes += statSync(abs).size;
    if (/(^|\/)_git(\/|$)/.test(rel)) {
      const from = rel.replace(/(^|\/)_git(\/.*)?$/, '$1_git');
      if (!this.renames.some((r) => r.from === from)) this.renames.push({ from, to: from.replace(/_git$/, '.git') });
    }
  }
  json(rel, value) {
    this.write(rel, JSON.stringify(value, null, 2) + '\n');
  }
  jsonl(rel, rows) {
    this.write(rel, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  symlink(path, target, kind) {
    this.symlinks.push({ path, target, kind });
  }
  age(path, ageDays) {
    this.ages.push({ path, ageDays });
  }
  emptyDir(path) {
    this.dirs.push(path);
  }
  finish(readme) {
    this.json('fixture.json', { renames: this.renames, symlinks: this.symlinks, ages: this.ages, dirs: this.dirs });
    this.write('README.md', readme());
    if (this.bytes > MAX_CASE_BYTES) throw new Error(`${this.name}: ${this.bytes} bytes exceeds ${MAX_CASE_BYTES}`);
    const rel = relative(REPO, this.dir).split(sep).join('/');
    console.log(
      `${rel}: ${this.files} files, ${this.bytes} bytes, ${this.renames.length} renames, ${this.symlinks.length} symlinks, ${this.ages.length} ages, ${this.dirs.length} dirs`,
    );
  }
}

/** First directory entry (sorted) under `dir` matching `pred`, skipping names on the forbidden list. */
function firstEntry(dir, pred) {
  try {
    if (!existsSync(dir)) return null;
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (FORBIDDEN.test(e.name)) continue;
      if (pred(e)) return e;
    }
  } catch {
    /* unreadable */
  }
  return null;
}

/** Refuse to ship anything that names this machine, its user, a URL or an e-mail. */
function leakCheck(dir, needles) {
  const bad = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const text = readFileSync(p, 'utf8');
        for (const n of needles) if (n.test(text)) bad.push(relative(dir, p));
      }
    }
  };
  walk(dir);
  if (bad.length) throw new Error(`leak check failed in ${bad.length} file(s): ${[...new Set(bad)].join(', ')}`);
}

// ---------------------------------------------------------------- synthetic MCP shapes (documented; never captured)

const MCP_STDIO = { type: 'stdio', command: REDACTED, args: [REDACTED], env: { X: REDACTED } };
const MCP_HTTP = { type: 'http', url: REDACTED };
const mcpPair = () => ({ 'server-stdio': structuredClone(MCP_STDIO), 'server-http': structuredClone(MCP_HTTP) });

const PROJECT_MCP_JSON = {
  mcpServers: {
    'server-stdio-implicit': { command: REDACTED, args: [REDACTED] }, // no `type` => stdio (as observed in a committed .mcp.json)
    'server-http': { type: 'http', url: REDACTED, headers: { Authorization: '${EXAMPLE_VAR}' } },
    'server-sse': { type: 'sse', url: REDACTED },
    'server-broken': { url: REDACTED }, // url without type: Claude Code skips it (lint target)
  },
};

// ---------------------------------------------------------------- transcripts (synthetic)

function transcript(sessionId, cwd, readPath) {
  const rows = [
    {
      type: 'user',
      cwd,
      sessionId,
      version: VERSION,
      gitBranch: 'main',
      uuid: sessionId.replace(/^.{8}/, 'aaaaaaaa'),
      parentUuid: null,
      timestamp: ISO,
      message: { role: 'user', content: REDACTED },
    },
  ];
  if (readPath) {
    rows.push({
      type: 'assistant',
      cwd,
      sessionId,
      version: VERSION,
      gitBranch: 'main',
      uuid: sessionId.replace(/^.{8}/, 'bbbbbbbb'),
      parentUuid: rows[0].uuid,
      timestamp: ISO,
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_synthetic01', name: 'Read', input: { file_path: readPath } }],
      },
    });
  }
  return rows;
}

// ---------------------------------------------------------------- ~/.claude.json

const DOC_ALWAYS = [
  'allowedTools',
  'disabledMcpjsonServers',
  'enabledMcpjsonServers',
  'hasClaudeMdExternalIncludesApproved',
  'hasClaudeMdExternalIncludesWarningShown',
  'hasTrustDialogAccepted',
  'mcpContextUris',
  'projectOnboardingSeenCount',
];
const DOC_PROJECT = {
  allowedTools: [],
  disabledMcpjsonServers: [],
  enabledMcpjsonServers: [],
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
  hasTrustDialogAccepted: true,
  mcpContextUris: [],
  projectOnboardingSeenCount: 1,
  hasCompletedProjectOnboarding: true,
  lastSessionId: REDACTED,
  lastCost: 0.5,
  lastDuration: 1000,
  lastTotalInputTokens: 1000,
  lastTotalOutputTokens: 1000,
};

function claudeJson() {
  const src = join(HOME, '.claude.json');
  let top = null;
  let entries = [];
  let projectCount = 0;
  try {
    readable(src);
    if (existsSync(src)) {
      const raw = JSON.parse(readFileSync(src, 'utf8'));
      const { projects, ...rest } = raw;
      entries = Object.values(projects ?? {}).filter((e) => e && typeof e === 'object' && !Array.isArray(e));
      projectCount = entries.length;
      top = redact(rest, 0);
    }
  } catch {
    top = null;
  }
  const live = top !== null;
  if (!live) {
    top = {
      numStartups: 1,
      installMethod: REDACTED,
      autoUpdates: true,
      hasCompletedOnboarding: true,
      oauthAccount: { accountUuid: REDACTED, emailAddress: REDACTED, organizationUuid: REDACTED },
      userID: REDACTED,
      cachedStatsigGates: {},
      tipsHistory: {},
      claudeAiMcpEverConnected: [],
    };
  }

  // union of per-project field names (first value seen, redacted) and the always-present set
  let union = {};
  let always = null;
  for (const e of entries) {
    const r = redact(e, 0);
    for (const [k, v] of Object.entries(r)) if (IDENT.test(k) && !(k in union)) union[k] = v;
    const ks = new Set(Object.keys(r).filter((k) => IDENT.test(k)));
    always = always ? new Set([...always].filter((k) => ks.has(k))) : ks;
  }
  if (!entries.length) {
    union = { ...DOC_PROJECT };
    always = new Set(DOC_ALWAYS);
  }
  const pick = (keys) => Object.fromEntries(Object.entries(union).filter(([k]) => keys.has(k)));
  const rich = (o) => ({ ...union, ...o });
  const bare = (o) => ({ ...pick(always), ...o });

  const projects = {
    '<ROOT>/project-a': rich({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      lastSessionId: UUID_A,
      mcpServers: mcpPair(),
      enabledMcpjsonServers: ['server-http'],
      disabledMcpjsonServers: ['server-sse'],
      enabledMcpServers: [],
      disabledMcpServers: ['server-stdio'],
    }),
    '<ROOT>/project-a/apps/web': bare({ hasTrustDialogAccepted: true, lastSessionId: UUID_B }),
    '<ROOT>/project-a-wt': bare({ hasTrustDialogAccepted: true }),
    '<ROOT>/gone': rich({ hasTrustDialogAccepted: true, lastSessionId: UUID_C, mcpServers: mcpPair() }),
    '<HOME>': bare({ hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true }),
    '/Volumes/Backup/old': bare({ hasTrustDialogAccepted: false }),
  };

  const out = { ...top };
  out.mcpServers = mcpPair();
  out.projects = projects;
  out.githubRepoPaths = { [`${REDACTED}-1`]: ['<ROOT>/project-a', '<ROOT>/project-a-wt'], [`${REDACTED}-2`]: ['<ROOT>/moved'] };
  if ('claudeAiMcpEverConnected' in out) out.claudeAiMcpEverConnected = [];
  return { value: out, live, topKeys: Object.keys(out).length, projectCount, unionKeys: Object.keys(union).length, alwaysKeys: always.size };
}

// ---------------------------------------------------------------- case: breadcrumbs

function caseBreadcrumbs() {
  const w = new CaseWriter('breadcrumbs');
  const live = {};

  // ---- home/.claude.json
  const cj = claudeJson();
  live.claudeJson = cj.live;
  w.json('home/.claude.json', cj.value);

  // ---- home/.claude/settings*.json (documented keys; nothing read from the real settings files)
  w.json('home/.claude/settings.json', {
    model: REDACTED,
    effortLevel: REDACTED,
    outputStyle: REDACTED,
    language: REDACTED,
    cleanupPeriodDays: 20,
    autoMemoryEnabled: true,
    permissions: { allow: [REDACTED], ask: [], deny: [], additionalDirectories: [], defaultMode: 'acceptEdits' },
    hooks: {
      SessionStart: [{ matcher: REDACTED, hooks: [{ type: 'command', command: REDACTED, timeout: 60 }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'prompt', prompt: REDACTED }] }],
    },
    env: { EXAMPLE_VAR: REDACTED },
    enabledPlugins: { 'plugin-a@marketplace-a': true, 'plugin-b@marketplace-a': false },
    extraKnownMarketplaces: { 'marketplace-a': { source: { source: 'github', repo: REDACTED } } },
    modelSettings: { [`${REDACTED}-1`]: { effortLevel: REDACTED } },
    statusLine: { type: 'command', command: REDACTED },
    tui: REDACTED,
    voice: { enabled: false, mode: REDACTED },
    voiceEnabled: false,
    skipWorkflowUsageWarning: true,
    verbose: false,
    agentPushNotifEnabled: false,
    autoMode: { environment: [REDACTED] },
  });
  w.json('home/.claude/settings.local.json', { permissions: { allow: [REDACTED, REDACTED] } });
  w.write('home/.claude/CLAUDE.md', filler(10, 400));

  // ---- home/.claude/projects/<slug>/ : memory mirrored from this repo's own slug, transcripts synthetic
  const memDir = join(CLAUDE, 'projects', slug(REPO), 'memory');
  const memIndex = mirrorMarkdown(join(memDir, 'MEMORY.md'), { fallback: { keys: [], lines: 6, bytes: 300 } });
  live.memoryIndex = memIndex.live;
  let topics = [];
  try {
    if (existsSync(memDir)) {
      topics = readdirSync(memDir)
        .filter((n) => n.endsWith('.md') && n !== 'MEMORY.md' && !FORBIDDEN.test(n))
        .sort()
        .slice(0, 2)
        .map((n) => mirrorMarkdown(join(memDir, n), { fallback: { keys: ['name', 'description', 'type'], lines: 12, bytes: 600 } }));
    }
  } catch {
    topics = [];
  }
  while (topics.length < 2) topics.push(mirrorMarkdown('', { fallback: { keys: ['name', 'description', 'type'], lines: 12 + topics.length * 4, bytes: 600 } }));
  live.memoryTopics = topics.every((t) => t.live);

  const slugA = 'home/.claude/projects/__ROOT__-project-a';
  w.write(`${slugA}/memory/MEMORY.md`, memIndex.text);
  w.write(`${slugA}/memory/topic-a.md`, topics[0].text);
  w.write(`${slugA}/memory/topic-b.md`, topics[1].text);
  w.jsonl(`${slugA}/${UUID_A}.jsonl`, transcript(UUID_A, '<ROOT>/project-a', '<HOME>/.claude/projects/__ROOT__-project-a/memory/MEMORY.md'));
  w.write(`${slugA}/${UUID_A}/tool-results/synthetic01.txt`, filler(4, 160));
  w.json(`${slugA}/sessions-index.json`, {
    version: 1,
    entries: [
      {
        sessionId: UUID_A,
        fullPath: `<HOME>/.claude/projects/__ROOT__-project-a/${UUID_A}.jsonl`,
        projectPath: '<ROOT>/project-a',
        created: ISO,
        modified: ISO,
        fileMtime: EPOCH_MS,
        firstPrompt: REDACTED,
        gitBranch: 'main',
        isSidechain: false,
        messageCount: 2,
      },
    ],
  });

  // subdirectory session: its own slug, transcript only, no memory (observed)
  w.jsonl(`home/.claude/projects/__ROOT__-project-a-apps-web/${UUID_B}.jsonl`, transcript(UUID_B, '<ROOT>/project-a/apps/web', '<ROOT>/project-a/apps/web/CLAUDE.md'));
  // aged past cleanupPeriodDays with no other member: the session-preselect candidate (research 10 Open 23)
  w.age(`home/.claude/projects/__ROOT__-project-a-apps-web/${UUID_B}.jsonl`, 45);
  // worktree session: transcript only, no memory, and no `projects` key carries its id (observed)
  w.jsonl(`home/.claude/projects/__ROOT__-project-a-wt/${UUID_D}.jsonl`, transcript(UUID_D, '<ROOT>/project-a-wt'));
  // ghost: the directory is gone, memory survived (orphan state)
  w.write('home/.claude/projects/__ROOT__-gone/memory/MEMORY.md', filler(5, 240));
  w.write('home/.claude/projects/__ROOT__-gone/memory/topic-gone.md', fm([['type', 'project'], ['modified', ISO]], filler(8, 400)));
  // stray: the home directory itself recorded as a project, with memory
  w.write('home/.claude/projects/__HOME__/memory/MEMORY.md', filler(4, 200));
  w.write('home/.claude/projects/__HOME__/memory/topic-home.md', fm([['name', REDACTED], ['description', REDACTED], ['type', 'user']], filler(6, 300)));

  // ---- sweepable / kept state (all synthetic, small)
  w.write('home/.claude/shell-snapshots/snapshot-zsh-1700000000000-synth1.sh', '# synthetic shell snapshot (the real ones are ~270 KB)\n' + filler(20, 1400));
  w.age('home/.claude/shell-snapshots/snapshot-zsh-1700000000000-synth1.sh', 45);
  w.json(`home/.claude/todos/${UUID_A}-agent-${UUID_A}.json`, [{ content: REDACTED, status: 'pending', priority: 'medium', id: '1' }]);
  w.age(`home/.claude/todos/${UUID_A}-agent-${UUID_A}.json`, 45);
  w.write(`home/.claude/tasks/${UUID_A}/.lock`, '');
  w.write(`home/.claude/tasks/${UUID_A}/.highwatermark`, '1\n');
  w.json(`home/.claude/tasks/${UUID_A}/1.json`, { id: '1', subject: REDACTED, description: REDACTED, status: 'pending', activeForm: REDACTED, blockedBy: [], blocks: [] });
  w.age(`home/.claude/tasks/${UUID_A}/1.json`, 5);
  w.json('home/.claude/backups/.claude.json.backup.1700000000000', { numStartups: 1, oauthAccount: { accountUuid: REDACTED }, projects: {} });
  w.age('home/.claude/backups/.claude.json.backup.1700000000000', 5);
  w.jsonl('home/.claude/history.jsonl', [
    { display: REDACTED, pastedContents: {}, project: '<ROOT>/project-a', sessionId: UUID_A, timestamp: EPOCH_MS },
    { display: REDACTED, pastedContents: {}, project: '<ROOT>/gone', sessionId: UUID_C, timestamp: EPOCH_MS - 86_400_000 * 100 },
  ]);

  // ---- root/project-a (repository) + root/project-a-wt (linked worktree)
  const claudeMd = mirrorMarkdown(srcOr(SRC_CONTEXT_PROJECT, 'CLAUDE.md'), { fallback: { keys: [], lines: 40, bytes: 2000 } });
  live.projectClaudeMd = claudeMd.live;
  const nestedMd = mirrorMarkdown(srcOr(SRC_NESTED_PROJECT, 'apps', 'web', 'CLAUDE.md'), { fallback: { keys: [], lines: 15, bytes: 700 } });
  live.nestedClaudeMd = nestedMd.live;

  w.write('root/project-a/_git/HEAD', 'ref: refs/heads/main\n');
  w.write('root/project-a/_git/worktrees/project-a-wt/gitdir', '<ROOT>/project-a-wt/.git\n');
  w.write('root/project-a/_git/worktrees/project-a-wt/commondir', '../..\n');
  w.write('root/project-a/_git/worktrees/project-a-wt/HEAD', 'ref: refs/heads/feature\n');
  w.write('root/project-a/_git/worktrees/dead/gitdir', '<ROOT>/dead-wt/.git\n');
  w.write('root/project-a/_git/worktrees/dead/commondir', '../..\n');
  w.write('root/project-a/_git/worktrees/dead/HEAD', 'ref: refs/heads/dead\n');
  w.write('root/project-a/CLAUDE.md', claudeMd.text);
  w.write('root/project-a/CLAUDE.local.md', '@docs/notes.md\n' + filler(3, 120));
  w.write('root/project-a/docs/notes.md', filler(3, 120));
  w.write('root/project-a/apps/web/CLAUDE.md', nestedMd.text);
  w.json('root/project-a/.claude/settings.json', { enabledPlugins: { 'plugin-a@marketplace-a': true }, permissions: { allow: [REDACTED] } });
  w.json('root/project-a/.claude/settings.local.json', {
    permissions: { allow: [REDACTED, REDACTED] },
    enableAllProjectMcpServers: false,
    enabledMcpjsonServers: ['server-http'],
    disabledMcpjsonServers: ['server-sse'],
  });
  w.write('root/project-a/.claude/agents/reviewer.md', fm([['name', 'reviewer'], ['description', REDACTED], ['tools', REDACTED], ['model', 'inherit'], ['memory', 'project']], filler(8, 360)));
  w.write('root/project-a/.claude/agent-memory/reviewer/MEMORY.md', filler(4, 180));
  w.write('root/project-a/.claude/commands/x.md', fm([['description', REDACTED]], filler(5, 220)));
  w.write('root/project-a/.claude/rules/rule-a.md', '---\npaths:\n  - "apps/web/**"\n---\n' + filler(6, 260));
  w.write('root/project-a/.claude/rules/nested/rule-b.md', filler(4, 160));
  w.json('root/project-a/.mcp.json', PROJECT_MCP_JSON);
  w.write('root/project-a/.gitignore', 'CLAUDE.local.md\n.claude/settings.local.json\n');

  w.write('root/project-a-wt/_git', 'gitdir: <ROOT>/project-a/.git/worktrees/project-a-wt\n');
  w.write('root/project-a-wt/CLAUDE.md', claudeMd.text);

  w.finish(() => readmeBreadcrumbs(live, cj, { memLines: memIndex.lines, claudeLines: claudeMd.lines, nestedLines: nestedMd.lines }));
  return live;
}

function readmeBreadcrumbs(live, cj, n) {
  const src = (ok) => (ok ? 'mirrored from this machine' : 'synthetic fallback (source absent at generation time)');
  return `# claude-code / breadcrumbs

What Claude Code 2.1.x leaves behind for one repository, its subdirectory, its linked worktree,
a project that no longer exists, the home directory and an unreachable volume: the \`projects\`
map of \`~/.claude.json\`, the slug directories of \`~/.claude/projects/\`, the sweepable state under
\`~/.claude/\`, the user settings, and the project side with every project-scope file Claude Code
reads. Generated by \`fixtures/_capture/claude-code.mjs\`; every value is redacted or synthetic.

## Layout

\`home/\` (the user's home)

- \`.claude.json\` — top-level keys ${cj.live ? `taken from the real file (${cj.topKeys} keys, every string \`<redacted>\`, nested maps truncated to 3 entries)` : 'from the documented list (synthetic fallback)'}.
  \`projects\` is synthetic: six keys (below). The rich entries carry the union of per-project field
  names ${cj.live ? `seen across ${cj.projectCount} real entries (${cj.unionKeys} names)` : 'from research 01 §3'}; the bare entries carry only the
  ${cj.alwaysKeys} always-present fields (trust / onboarding / MCP-approval lists), the shape observed for
  worktree and ghost keys. \`mcpServers\` (top level = user scope, inside an entry = local scope) is the
  synthetic pair \`server-stdio\` (\`type: stdio\`, \`command\`, \`args\`, \`env\`) + \`server-http\` (\`type: http\`, \`url\`).
  \`githubRepoPaths\` is synthetic: two redacted repo ids mapping to \`<ROOT>\` paths, one of which
  (\`<ROOT>/moved\`) appears nowhere else.
- \`.claude/settings.json\` — documented key set (research 01 §3) with \`cleanupPeriodDays: 20\`, a \`hooks\`
  map (\`SessionStart\` command hook, \`PreToolUse\` prompt hook), \`enabledPlugins\`, \`extraKnownMarketplaces\`,
  \`permissions\`, an \`env\` map (redacted: settings \`env\` may hold secrets) and the UI/model keys observed here.
  Nothing was read from the real settings files. \`.claude/settings.local.json\` = \`permissions.allow\` (a
  project-scope filename living at user scope, as on this machine). \`.claude/CLAUDE.md\` = user context file.
- \`.claude/projects/__ROOT__-project-a/\` — \`memory/MEMORY.md\` (${n.memLines} body lines, ${src(live.memoryIndex)}) and
  two topic files \`topic-a.md\`, \`topic-b.md\` (frontmatter keys ${src(live.memoryTopics)}); one synthetic
  transcript \`${UUID_A}.jsonl\` (2 lines: a \`user\` line and an \`assistant\` line whose \`tool_use\` is a
  \`Read\` of \`<HOME>/.claude/projects/__ROOT__-project-a/memory/MEMORY.md\`, both carrying \`cwd\` and \`sessionId\`);
  a session directory \`${UUID_A}/tool-results/synthetic01.txt\`; and \`sessions-index.json\` (documented keys).
- \`.claude/projects/__ROOT__-project-a-apps-web/\` — subdirectory session: one transcript (45 days old, the only
  member of its session unit), **no** \`memory/\`.
- \`.claude/projects/__ROOT__-project-a-wt/\` — worktree session: one transcript, no \`memory/\`; no \`projects\`
  key names its session id (only the transcript's \`cwd\` resolves it).
- \`.claude/projects/__ROOT__-gone/\` — memory only (orphan: the directory is gone, the key survives).
- \`.claude/projects/__HOME__/\` — memory only (stray: the home directory recorded as a project).
- \`.claude/shell-snapshots/\` (45 days old), \`todos/\` (legacy, 45 days old), \`tasks/<session>/\` (documented
  replacement, 5 days old), \`backups/.claude.json.backup.<ms>\` (5 days old, carries an \`oauthAccount\` key),
  \`history.jsonl\` (2 lines, \`project\` = \`<ROOT>/project-a\` and \`<ROOT>/gone\`). All synthetic and tiny.

\`root/\` (the projects side)

- \`project-a/\` — repository (\`_git/HEAD\` → \`.git/HEAD\`) registering two worktrees: \`project-a-wt\` (live,
  \`gitdir\` → \`<ROOT>/project-a-wt/.git\`) and \`dead\` (\`gitdir\` → \`<ROOT>/dead-wt/.git\`, missing).
  \`CLAUDE.md\` (${n.claudeLines} body lines, ${src(live.projectClaudeMd)}), \`CLAUDE.local.md\` (its first line is the
  import \`@docs/notes.md\`, which resolves to \`docs/notes.md\`), \`.gitignore\`,
  \`apps/web/CLAUDE.md\` (${n.nestedLines} body line${n.nestedLines === 1 ? '' : 's'}, ${src(live.nestedClaudeMd)}; the source files on this
  machine are tiny, the nested one a single line), \`.claude/settings.json\`
  (\`enabledPlugins\` + \`permissions\`), \`.claude/settings.local.json\` (\`permissions\`, \`enableAllProjectMcpServers\`,
  \`enabledMcpjsonServers\`, \`disabledMcpjsonServers\`), \`.claude/agents/reviewer.md\` (\`memory: project\` →
  \`.claude/agent-memory/reviewer/MEMORY.md\`), \`.claude/commands/x.md\`, \`.claude/rules/rule-a.md\` (\`paths:\`
  scoped) + \`.claude/rules/nested/rule-b.md\`, and a synthetic \`.mcp.json\` with four servers: implicit stdio
  (no \`type\`), \`http\` with a \`\${EXAMPLE_VAR}\` header, \`sse\`, and a \`url\` without \`type\` (invalid).
- \`project-a-wt/\` — linked worktree: \`_git\` **file** \`gitdir: <ROOT>/project-a/.git/worktrees/project-a-wt\`
  and a copy of \`CLAUDE.md\`.
- \`gone/\`, \`dead-wt/\`, \`moved/\` — do not exist; only breadcrumbs name them.

## Edge cases carried

1. Six kinds of \`projects\` key: present repository, subdirectory of that repository, linked worktree,
   ghost, bare home, unreachable volume (\`/Volumes/Backup/old\`, no placeholder: must never be created).
2. Slug ↔ key resolution: \`__ROOT__-project-a-apps-web\` and \`__ROOT__-project-a-wt\` are lossy (the latter
   is also the slug of \`<ROOT>/project-a/wt\`); \`__ROOT__-gone\` resolves to a ghost key; \`__HOME__\` to home.
3. Memory lives only in the git-root slug (project-a), the ghost slug and the home slug; the subdirectory
   and worktree slugs hold transcripts only (research 09 §2).
4. \`lastSessionId\` of \`<ROOT>/gone\` names a transcript that exists in no slug dir; the worktree key has none.
5. Local-scope MCP servers on a ghost key; \`enabledMcpjsonServers\` / \`disabledMcpjsonServers\` in both
   \`~/.claude.json\` and \`.claude/settings.local.json\` naming servers defined in \`.mcp.json\`.
6. Stale worktree registration (\`dead\`) next to a live one; worktree \`CLAUDE.md\` duplicates the main copy.
7. Retention: 45-day-old snapshot/todo vs 5-day-old task/backup under \`cleanupPeriodDays: 20\`; the \`apps/web\`
   session (\`2222…\`) is 45 days old and has no other member, so under \`cleanupPeriodDays: 20\` it is the
   preselect candidate; session \`1111…\` stays recent because its \`tasks/\` member is 5 days old.
8. Context-file hierarchy: user \`CLAUDE.md\`, project \`CLAUDE.md\` + \`CLAUDE.local.md\` (with one \`@\` import),
   nested \`apps/web/CLAUDE.md\`, \`.claude/rules/**\` with and without \`paths:\`, agent memory.
9. \`.claude.json\` carries an \`oauthAccount\` key (must-keep + sensitive), as does the backup copy.

## What is synthetic

Everything except key names, line counts and byte sizes: both transcripts and the tool-result file
(no real transcript line was read), \`sessions-index.json\`, \`history.jsonl\`, the shell snapshot (~1.5 KB
where real ones are ~270 KB), the todo/task files, the backup, every Markdown body (filler lines), every
MCP entry, \`githubRepoPaths\`, the \`projects\` keys, session ids (\`1111…\`, \`2222…\`, \`3333…\`, \`4444…\`) and
timestamps (fixed epoch 1700000000000 ms / 2023-11-14T22:13:20Z). \`version: "${VERSION}"\` in the transcripts
is the Claude Code version observed on the source machine. The legacy \`todos/\` file name
(\`<session>-agent-<session>.json\`) and item keys are not documented in research 01 (the directory is absent
here); the \`.highwatermark\` content and the \`sessions-index.json\` \`version\` value are guesses.

## Slug rule

\`~/.claude/projects/<slug>\`: the absolute working directory with every character outside
\`[A-Za-z0-9]\` replaced by \`-\`, case kept (\`/home/x/Work/y.z\` → \`-home-x-Work-y-z\`). Hence
\`__ROOT__-project-a\` = slug(\`<ROOT>\`) + \`-project-a\`, \`__ROOT__-project-a-apps-web\` = slug of
\`<ROOT>/project-a/apps/web\`, and \`__HOME__\` = slug(\`<HOME>\`). The same tokens appear **inside file
contents** where a slug path is spelled out (\`file_path\` of the \`Read\` tool_use, \`fullPath\` in
\`sessions-index.json\`): the helper must rewrite \`__ROOT__\`/\`__HOME__\` in contents with the computed slugs
as well as \`<ROOT>\`/\`<HOME>\` with the real paths. Auto-memory is keyed by the git root, so worktrees
and subdirectories of one repository share the main slug's \`memory/\`.
`;
}

// ---------------------------------------------------------------- case: skills-and-plugins

function caseSkillsAndPlugins() {
  const w = new CaseWriter('skills-and-plugins');
  const live = {};

  // ---- home/.claude/skills: one real dir, one Vercel symlink, one dangling symlink, one skills-dir plugin
  const skillsDir = join(CLAUDE, 'skills');
  const realDir = firstEntry(skillsDir, (e) => e.isDirectory() && existsSync(join(skillsDir, e.name, 'SKILL.md')));
  const realSkill = mirrorMarkdown(realDir ? join(skillsDir, realDir.name, 'SKILL.md') : '', { name: 'skill-user', fallback: { keys: ['name', 'description'], lines: 30, bytes: 1500 } });
  live.userSkill = realSkill.live;
  w.write('home/.claude/skills/skill-user/SKILL.md', realSkill.text);
  w.write('home/.claude/skills/skill-user/references/ref-a.md', filler(6, 260));

  let linkTarget = '';
  let relativeLinks = 0;
  let totalLinks = 0;
  try {
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isSymbolicLink()) continue;
      totalLinks++;
      const text = readlinkSync(join(skillsDir, e.name));
      if (!text.startsWith('/')) relativeLinks++;
      if (!linkTarget && !FORBIDDEN.test(e.name) && !FORBIDDEN.test(text)) {
        const abs = resolve(skillsDir, text);
        if (existsSync(join(abs, 'SKILL.md'))) linkTarget = join(abs, 'SKILL.md');
      }
    }
  } catch {
    /* no skills dir */
  }
  const linkedSkill = mirrorMarkdown(linkTarget, { name: 'skill-a', fallback: { keys: ['name', 'description'], lines: 40, bytes: 2200 } });
  live.linkedSkill = linkedSkill.live;
  w.write('home/.agents/skills/skill-a/SKILL.md', linkedSkill.text);
  w.symlink('home/.claude/skills/skill-a', '../../.agents/skills/skill-a', 'dir');
  w.symlink('home/.claude/skills/skill-dangling', '../../.agents/skills/skill-dangling', 'dir');
  w.write('home/.agents/skills/skill-orphan/SKILL.md', skillMd('skill-orphan', 12, 500));
  w.json('home/.claude/skills/skill-plugin/.claude-plugin/plugin.json', { name: 'skill-plugin', description: REDACTED, version: '0.1.0' });
  w.write('home/.claude/skills/skill-plugin/SKILL.md', skillMd('skill-plugin', 8, 320));
  w.write('home/.claude/commands/cmd-user.md', fm([['description', REDACTED]], filler(6, 260)));

  // ---- home/.agents/.skill-lock.json (v3; field names from the real file, values replaced)
  const lock = readJson(join(AGENTS, '.skill-lock.json'));
  live.skillLock = lock.live;
  const lockEntryKeys = Object.keys(Object.values(lock.raw?.skills ?? {}).find((e) => e && typeof e === 'object') ?? {}).filter((k) => IDENT.test(k));
  const lockKeys = lockEntryKeys.length ? lockEntryKeys : ['source', 'sourceType', 'sourceUrl', 'skillPath', 'skillFolderHash', 'installedAt', 'updatedAt'];
  const lockEntry = () =>
    Object.fromEntries(
      lockKeys.map((k) => [
        k,
        k === 'sourceType' ? 'github' : k === 'skillFolderHash' ? HASH : /At$/.test(k) ? ISO : REDACTED,
      ]),
    );
  const lockOut = { ...(lock.value ?? { version: 3, dismissed: {}, lastSelectedAgents: [], skills: {} }) };
  lockOut.version = typeof lock.raw?.version === 'number' ? lock.raw.version : 3;
  lockOut.lastSelectedAgents = ['claude-code', 'cursor'];
  lockOut.skills = { 'skill-a': lockEntry(), 'skill-orphan': lockEntry(), 'skill-dangling': lockEntry() };
  w.json('home/.agents/.skill-lock.json', lockOut);

  // ---- home/.claude/plugins: state files (key names from the real files, values replaced)
  const P = join(CLAUDE, 'plugins');
  const installed = readJson(join(P, 'installed_plugins.json'));
  live.installedPlugins = installed.live;
  const firstInstall = Object.values(installed.raw?.plugins ?? {}).flat().find((e) => e && typeof e === 'object') ?? {};
  const installKeys = Object.keys(firstInstall).filter((k) => IDENT.test(k));
  const keys = installKeys.length ? installKeys : ['scope', 'installPath', 'version', 'installedAt', 'lastUpdated', 'gitCommitSha'];
  const installEntry = (scope, plugin, version, extra = {}) => {
    const e = {};
    for (const k of keys) {
      if (k === 'projectPath' && scope === 'user') continue; // only project/local entries carry it
      e[k] =
        k === 'scope' ? scope
        : k === 'installPath' ? `<HOME>/.claude/plugins/cache/marketplace-a/${plugin}/${version}`
        : k === 'version' ? version
        : k === 'gitCommitSha' ? HASH
        : /At$|Updated$/.test(k) ? ISO
        : k === 'projectPath' ? (extra.projectPath ?? REDACTED)
        : REDACTED;
    }
    return { ...e, ...extra };
  };
  w.json('home/.claude/plugins/installed_plugins.json', {
    version: typeof installed.raw?.version === 'number' ? installed.raw.version : 2,
    plugins: {
      'plugin-a@marketplace-a': [installEntry('user', 'plugin-a', '1.0.0')],
      'plugin-b@marketplace-a': [installEntry('project', 'plugin-b', '2.0.0', { projectPath: '<ROOT>/project-b' })],
    },
  });

  const known = readJson(join(P, 'known_marketplaces.json'));
  live.knownMarketplaces = known.live;
  const knownKeys = Object.keys(Object.values(known.raw ?? {}).find((e) => e && typeof e === 'object') ?? {}).filter((k) => IDENT.test(k));
  const mkKnown = (name) =>
    Object.fromEntries(
      (knownKeys.length ? knownKeys : ['source', 'installLocation', 'lastUpdated']).map((k) => [
        k,
        k === 'source' ? { source: 'github', repo: REDACTED } : k === 'installLocation' ? `<HOME>/.claude/plugins/marketplaces/${name}` : /Updated$|At$/.test(k) ? ISO : REDACTED,
      ]),
    );
  w.json('home/.claude/plugins/known_marketplaces.json', { 'marketplace-a': mkKnown('marketplace-a'), 'marketplace-gone': mkKnown('marketplace-gone') });

  const cfg = readJson(join(P, 'config.json'));
  live.pluginsConfig = cfg.live;
  w.json('home/.claude/plugins/config.json', cfg.value ?? { repositories: {} });
  const block = readJson(join(P, 'blocklist.json'));
  live.blocklist = block.live;
  w.json('home/.claude/plugins/blocklist.json', { ...(block.value ?? { fetchedAt: EPOCH_MS }), plugins: [] });
  const catalog = readJson(join(P, 'plugin-catalog-cache.json'));
  live.catalogCache = catalog.live;
  w.json('home/.claude/plugins/plugin-catalog-cache.json', catalog.value ?? { version: 1, fetchedAt: EPOCH_MS, catalog: {} });
  w.write('home/.claude/plugins/.last_inuse_sweep', ISO + '\n');
  w.emptyDir('home/.claude/plugins/repos');
  w.emptyDir('home/.claude/plugins/data/plugin-a-marketplace-a');

  // ---- one marketplace clone (+ a leftover .bak copy) and the plugin cache
  const mkDir = join(P, 'marketplaces');
  const mkName = firstEntry(mkDir, (e) => e.isDirectory() && !e.name.endsWith('.bak') && existsSync(join(mkDir, e.name, '.claude-plugin', 'marketplace.json')));
  const marketplace = readJson(mkName ? join(mkDir, mkName.name, '.claude-plugin', 'marketplace.json') : '');
  live.marketplaceJson = marketplace.live;
  const mpOut = { ...(marketplace.value ?? { name: REDACTED, owner: { name: REDACTED }, plugins: [] }) };
  mpOut.name = 'marketplace-a';
  if ('owner' in mpOut) mpOut.owner = { name: REDACTED };
  if ('metadata' in mpOut) mpOut.metadata = { description: REDACTED, version: '1.0.0' };
  mpOut.plugins = [
    { name: 'plugin-a', source: './plugins/plugin-a', description: REDACTED, version: '1.0.0' },
    { name: 'plugin-b', source: { source: 'github', repo: REDACTED }, description: REDACTED, version: '2.0.0' },
  ];
  w.json('home/.claude/plugins/marketplaces/marketplace-a/.claude-plugin/marketplace.json', mpOut);
  w.write('home/.claude/plugins/marketplaces/marketplace-a/_git/HEAD', 'ref: refs/heads/main\n');
  w.write('home/.claude/plugins/marketplaces/marketplace-a/README.md', filler(6, 240));
  w.json('home/.claude/plugins/marketplaces/marketplace-a/node_modules/pkg/package.json', { name: 'pkg', version: '0.0.0' });
  w.json('home/.claude/plugins/marketplaces/marketplace-a.bak/.claude-plugin/marketplace.json', { ...mpOut, plugins: mpOut.plugins.slice(0, 1) });
  w.age('home/.claude/plugins/marketplaces/marketplace-a.bak/.claude-plugin/marketplace.json', 90);

  // first plugin root in the cache (cache/<marketplace>/<plugin>/<version>/) carrying a
  // .claude-plugin/plugin.json, and the first one carrying hooks/hooks.json (may differ)
  const cacheRoot = join(P, 'cache');
  let pluginJsonPath = '';
  let hooksJsonPath = '';
  const subdirs = (d) => {
    try {
      return readdirSync(d, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !FORBIDDEN.test(e.name))
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => join(d, e.name));
    } catch {
      return [];
    }
  };
  for (const mk of existsSync(cacheRoot) ? subdirs(cacheRoot) : []) {
    for (const plugin of subdirs(mk)) {
      for (const ver of subdirs(plugin)) {
        const pjPath = join(ver, '.claude-plugin', 'plugin.json');
        const hPath = join(ver, 'hooks', 'hooks.json');
        if (!pluginJsonPath && existsSync(pjPath)) pluginJsonPath = pjPath;
        if (!hooksJsonPath && existsSync(hPath)) hooksJsonPath = hPath;
      }
    }
  }
  const pluginJson = readJson(pluginJsonPath);
  live.pluginJson = pluginJson.live;
  const pj = (name, version) => {
    const out = { ...(pluginJson.value ?? { name: REDACTED, description: REDACTED, version: REDACTED, author: { name: REDACTED } }) };
    out.name = name;
    out.version = version;
    if ('author' in out) out.author = { name: REDACTED };
    if ('mcpServers' in out) out.mcpServers = { 'server-plugin': { transport: 'http', url: REDACTED } };
    for (const k of ['homepage', 'repository', 'license']) if (k in out) out[k] = REDACTED;
    return out;
  };
  const hooksJson = readJson(hooksJsonPath);
  live.hooksJson = hooksJson.live;
  const hooksOut = { ...(hooksJson.value ?? { hooks: {} }) };
  for (const k of Object.keys(hooksOut)) if (k !== 'hooks') hooksOut[k] = REDACTED;
  hooksOut.hooks = { SessionStart: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/scripts/start.sh' }] }] };

  const marketplaceSkill = { keys: ['name', 'description'], lines: 20, bytes: 900 };
  w.json('home/.claude/plugins/marketplaces/marketplace-a/plugins/plugin-a/.claude-plugin/plugin.json', pj('plugin-a', '1.0.0'));
  w.write('home/.claude/plugins/marketplaces/marketplace-a/plugins/plugin-a/skills/skill-p/SKILL.md', skillMd('skill-p', marketplaceSkill.lines, marketplaceSkill.bytes));

  const v1 = 'home/.claude/plugins/cache/marketplace-a/plugin-a/1.0.0';
  w.json(`${v1}/.claude-plugin/plugin.json`, pj('plugin-a', '1.0.0'));
  w.write(`${v1}/skills/skill-p/SKILL.md`, skillMd('skill-p', marketplaceSkill.lines, marketplaceSkill.bytes));
  w.write(`${v1}/commands/cmd-p.md`, fm([['description', REDACTED]], filler(4, 180)));
  w.write(`${v1}/agents/agent-p.md`, fm([['name', 'agent-p'], ['description', REDACTED]], filler(6, 260)));
  w.json(`${v1}/hooks/hooks.json`, hooksOut);
  w.write(`${v1}/scripts/start.sh`, '#!/bin/sh\n# synthetic hook script\nexit 0\n');
  w.json(`${v1}/.mcp.json`, { mcpServers: { 'server-plugin': { type: 'stdio', command: '${CLAUDE_PLUGIN_ROOT}/bin/server', args: [] } } });
  w.write(`${v1}/CLAUDE.md`, filler(8, 320));
  w.write(`${v1}/.in_use/12345`, '');
  const v0 = 'home/.claude/plugins/cache/marketplace-a/plugin-a/0.9.0';
  w.json(`${v0}/.claude-plugin/plugin.json`, pj('plugin-a', '0.9.0'));
  w.write(`${v0}/skills/skill-p/SKILL.md`, skillMd('skill-p', 18, 800));
  w.age(`${v0}/.claude-plugin/plugin.json`, 60);

  // ---- root/project-b: a copied project skill + skills-lock.json v1 + project-scope plugin enablement
  // On this machine every entry of the project's .claude/skills is a relative symlink into the
  // project's own .agents/skills (Vercel layout at project scope, committed as symlinks); the
  // mirror follows the link. project-b carries both layouts: a real copy (skill-b) and a link (skill-c).
  const projSkillsDir = srcOr(SRC_SKILLS_PROJECT, '.claude', 'skills');
  const projSkill = firstEntry(projSkillsDir, (e) => (e.isDirectory() || e.isSymbolicLink()) && existsSync(join(projSkillsDir, e.name, 'SKILL.md')));
  let projLinks = 0;
  let projEntries = 0;
  try {
    for (const e of readdirSync(projSkillsDir, { withFileTypes: true })) {
      projEntries++;
      if (e.isSymbolicLink()) projLinks++;
    }
  } catch {
    /* absent */
  }
  const skillB = mirrorMarkdown(projSkill ? join(projSkillsDir, projSkill.name, 'SKILL.md') : '', { name: 'skill-b', fallback: { keys: ['name', 'description'], lines: 25, bytes: 1200 } });
  live.projectSkill = skillB.live;
  w.write('root/project-b/_git/HEAD', 'ref: refs/heads/main\n');
  w.write('root/project-b/.claude/skills/skill-b/SKILL.md', skillB.text);
  w.write('root/project-b/.agents/skills/skill-c/SKILL.md', skillMd('skill-c', 14, 600));
  w.symlink('root/project-b/.claude/skills/skill-c', '../../.agents/skills/skill-c', 'dir');
  w.json('root/project-b/.claude/settings.json', { enabledPlugins: { 'plugin-b@marketplace-a': true } });

  const projLock = readJson(srcOr(SRC_SKILLS_PROJECT, 'skills-lock.json'));
  live.projectLock = projLock.live;
  live.projectLockIsV1 = projLock.raw?.version === 1;
  const v1Keys = live.projectLockIsV1
    ? Object.keys(Object.values(projLock.raw?.skills ?? {}).find((e) => e && typeof e === 'object') ?? {}).filter((k) => IDENT.test(k))
    : [];
  const lockV1Keys = v1Keys.length ? v1Keys : ['source', 'sourceUrl', 'sourceType', 'skillPath', 'computedHash'];
  const v1Entry = () => Object.fromEntries(lockV1Keys.map((k) => [k, k === 'sourceType' ? 'github' : /Hash$/.test(k) ? HASH : /At$/.test(k) ? ISO : REDACTED]));
  w.json('root/project-b/skills-lock.json', { version: 1, skills: { 'skill-b': v1Entry(), 'skill-c': v1Entry(), 'skill-missing': v1Entry() } });

  w.finish(() => readmeSkills(live, { relativeLinks, totalLinks, projLinks, projEntries, lockVersion: lockOut.version, lockKeys, keys, lockV1Keys }));
  return live;
}

function readmeSkills(live, n) {
  const src = (ok) => (ok ? 'mirrored from this machine' : 'synthetic fallback');
  return `# claude-code / skills-and-plugins

Where Claude Code finds skills, commands and plugins at user scope and in one project, as laid out
on a 2026 developer Mac that installs skills with Vercel's \`skills\` CLI: \`~/.claude/skills/\` mixing
real directories with relative symlinks into \`~/.agents/skills/\`, the global lock file, the
\`~/.claude/plugins/\` state files, one marketplace clone, the plugin cache with a referenced, an
orphan and a missing version, and a project carrying a copied skill with a \`skills-lock.json\`.
Generated by \`fixtures/_capture/claude-code.mjs\`; every value is redacted or synthetic.

## Layout

\`home/\` (the user's home)

- \`.claude/skills/skill-user/\` — a real skill directory (\`SKILL.md\` frontmatter keys and line/byte
  counts ${src(live.userSkill)}; \`references/ref-a.md\` is payload).
- \`.claude/skills/skill-a\` — **symlink** \`../../.agents/skills/skill-a\` (declared in \`fixture.json\`;
  \`~/.claude/skills\` on this machine holds ${n.totalLinks} symlinks, ${n.relativeLinks} of them relative links of exactly this
  form). The canonical copy \`home/.agents/skills/skill-a/SKILL.md\` is ${src(live.linkedSkill)}.
- \`.claude/skills/skill-dangling\` — symlink whose target \`home/.agents/skills/skill-dangling\` does not exist.
- \`.claude/skills/skill-plugin/\` — a skills-dir plugin (\`.claude-plugin/plugin.json\` next to \`SKILL.md\`;
  loads as \`skill-plugin@skills-dir\`).
- \`.claude/commands/cmd-user.md\` — user command (frontmatter \`description\` only, as observed).
- \`.agents/skills/skill-orphan/\` — canonical copy linked from no agent directory.
- \`.agents/.skill-lock.json\` — \`version: ${n.lockVersion}\`, top-level keys ${src(live.skillLock)}, entries
  \`skill-a\`, \`skill-orphan\`, \`skill-dangling\` with the field names \`${n.lockKeys.join('`, `')}\`
  (\`sourceType: github\`, ISO timestamps, \`<redacted-hash>\`); \`lastSelectedAgents\` = public agent ids.
- \`.claude/plugins/installed_plugins.json\` — \`version: 2\`; \`plugin-a@marketplace-a\` (scope \`user\`, \`installPath\`
  → \`cache/marketplace-a/plugin-a/1.0.0\`, present) and \`plugin-b@marketplace-a\` (scope \`project\`, \`projectPath\`
  \`<ROOT>/project-b\`, \`installPath\` → \`cache/marketplace-a/plugin-b/2.0.0\`, **missing**). Entry field names
  ${src(live.installedPlugins)}: \`${n.keys.join('`, `')}\`.
- \`.claude/plugins/known_marketplaces.json\` — \`marketplace-a\` (clone present) and \`marketplace-gone\` (clone
  missing); field names ${src(live.knownMarketplaces)}. \`config.json\` (${src(live.pluginsConfig)}),
  \`blocklist.json\` (${src(live.blocklist)}, empty list), \`plugin-catalog-cache.json\` (${src(live.catalogCache)},
  nested maps truncated), \`.last_inuse_sweep\` (ISO timestamp). \`repos/\` and \`data/plugin-a-marketplace-a/\`
  are empty (\`dirs\` in \`fixture.json\`).
- \`.claude/plugins/marketplaces/marketplace-a/\` — a git clone (\`_git/HEAD\`) with \`.claude-plugin/marketplace.json\`
  (top-level keys ${src(live.marketplaceJson)}; two plugins, one relative source, one \`github\` source), the
  plugin source \`plugins/plugin-a/{.claude-plugin/plugin.json,skills/skill-p/SKILL.md}\`, a \`README.md\` and a
  \`node_modules/\` (prune target). \`marketplace-a.bak/\` is a leftover copy, 90 days old.
- \`.claude/plugins/cache/marketplace-a/plugin-a/1.0.0/\` — the installed plugin root: \`.claude-plugin/plugin.json\`
  (keys ${src(live.pluginJson)}), \`skills/skill-p/SKILL.md\`, \`commands/cmd-p.md\`, \`agents/agent-p.md\`,
  \`hooks/hooks.json\` (top-level keys ${src(live.hooksJson)}; one synthetic \`SessionStart\` command hook using
  \`\${CLAUDE_PLUGIN_ROOT}\`), \`scripts/start.sh\`, a synthetic \`.mcp.json\` (\`type: stdio\`), \`CLAUDE.md\` and an
  \`.in_use/12345\` PID marker. \`0.9.0/\` is a second version referenced by nothing, 60 days old.

\`root/\` (the projects side)

- \`project-b/\` — repository with \`.claude/skills/skill-b/SKILL.md\` (a real copy; frontmatter keys and
  counts ${src(live.projectSkill)}), \`.claude/skills/skill-c\` → \`../../.agents/skills/skill-c\` (a **symlink**
  into the project's own canonical store \`.agents/skills/\`, declared in \`fixture.json\`: on this machine the
  source project's \`.claude/skills\` holds ${n.projEntries} entries and ${n.projLinks} of them are such relative links, committed
  to git as symlinks), \`.claude/settings.json\` enabling \`plugin-b@marketplace-a\` at project scope, and
  \`skills-lock.json\` \`version: 1\` (field names \`${n.lockV1Keys.join('`, `')}\`${live.projectLockIsV1 ? ', from the real project lock' : '; the real project lock on this machine is not v1, so the documented v1 names are used'})
  with entries \`skill-b\` (real copy), \`skill-c\` (link) and \`skill-missing\` (no directory).

## Edge cases carried

1. Three kinds of entry in \`~/.claude/skills\`: real directory, relative symlink into the canonical store,
   dangling symlink; plus a skills-dir plugin that is a plugin, not a skill. The same real-copy vs
   symlink split at project scope (\`skill-b\` vs \`skill-c\`), with the project's own \`.agents/skills/\`.
2. Canonical copy with no agent link (\`skill-orphan\`); lock entries for a linked, an orphan and a dangling skill.
3. \`installed_plugins.json\` v2 with a user-scope entry whose cache exists and a project-scope entry whose cache
   is gone; a cache version (\`0.9.0\`) referenced by no entry; an \`.in_use\` marker on the live version.
4. \`known_marketplaces.json\` naming a clone that exists and one that does not; a \`.bak\` leftover; a marketplace
   \`node_modules/\`.
5. Plugin payload that looks like project config (\`CLAUDE.md\`, \`.mcp.json\`, \`hooks.json\`, \`agents/\`, \`commands/\`)
   inside the cache: belongs to the plugin, not to a project.
6. The same skill name (\`skill-p\`) in the marketplace source tree and in two cache versions.
7. Project-scope plugin enablement (\`.claude/settings.json\`) cross-referencing \`installed_plugins.json\`.
8. Two lock schemas: global v3 (\`skillFolderHash\`, timestamps) and project v1 (\`computedHash\`).

## What is synthetic

Everything except key names, line counts and byte sizes: every Markdown body, every lock value,
\`installPath\` / \`installLocation\` / \`projectPath\` placeholders, marketplace and plugin names, the hook,
the script, the MCP entry, the PID marker, timestamps (2023-11-14T22:13:20Z) and hashes
(\`<redacted-hash>\`). No file under a real plugin's \`.mcp.json\` was opened.

## Slug rule

Not used: this case has no \`~/.claude/projects/\` slug directories and no \`.claude.json\`, so the
\`__HOME__\` / \`__ROOT__\` name tokens do not appear. Absolute paths inside file contents use \`<HOME>\`
(\`installPath\`, \`installLocation\`) and \`<ROOT>\` (\`projectPath\`). The Claude Code slug rule itself is
documented in \`../breadcrumbs/README.md\`.
`;
}

// ---------------------------------------------------------------- main

mkdirSync(OUT, { recursive: true });
const results = { breadcrumbs: caseBreadcrumbs(), 'skills-and-plugins': caseSkillsAndPlugins() };

const user = userInfo().username;
const needles = [new RegExp(HOME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), /https?:\/\//, /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/];
if (user && user.length > 2) needles.push(new RegExp(`(^|[^A-Za-z])${user}([^A-Za-z]|$)`, 'i'));
// names of the source projects whose Markdown was mirrored, and this repository's own name
for (const re of sourceNeedles(SOURCES)) needles.push(re);
needles.push(new RegExp(basename(REPO), 'i'));
leakCheck(OUT, needles);
console.log('leak check: ok (home path, user name, URLs, e-mails absent)');

for (const [name, live] of Object.entries(results)) {
  const ok = Object.values(live).filter(Boolean).length;
  console.log(`${name}: sources live ${ok}/${Object.keys(live).length}`);
}
