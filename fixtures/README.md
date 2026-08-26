# Fixture trees

Anonymised copies of what the six harnesses leave on disk, one directory per case:
`fixtures/<harness>/<case>/`. Shared by `packages/core`, `packages/cli` and any future app.

The contract:

- A case is a real directory tree, committed as-is, with every value that could identify a
  person or machine replaced by `"<redacted>"`. Never commit a token, key or transcript.
- Absolute paths inside files (`~/.claude.json`, `config.toml`, …) use the placeholders
  `<HOME>` and `<ROOT>`; the test helper rewrites them when it copies the case.
- Each case carries a `fixture.json` describing what git cannot: symlinks (created at run time,
  with `"junction"` for directories on Windows) and file ages (`{ "path", "ageDays" }`, applied
  with `utimes`, so "older than 30 days" rules are testable).
- Tests never touch the real home directory: the helper copies the case into a fresh temp
  directory (`mkdtemp` + `realpath`) and the scanner receives the home directory, the
  roots, the working directory, the platform and the environment explicitly (see `CONTEXT.md`).
  Snapshot serialisers normalise `<ROOT>`, path separators and ordering.

## Extensions the captured cases rely on

- **Two subtrees.** A case holds `home/` (what the harness keeps under the user's home:
  `home/.claude/…`, `home/.config/opencode/…`, `home/Library/Application Support/Cursor/…`) and
  `root/` (the projects side: `root/project-a/…`). The helper injects `home = <tmp>/home` and
  `roots = [<tmp>/root]`. `home/` may be absent (`shared/root-tree`); the helper then creates an
  empty one.
- **Slug tokens in names.** Directory names that encode a path (Claude Code's
  `projects/-Users-x-Work-y`, Cursor's `projects/…`) use the filename-safe tokens `__HOME__` and
  `__ROOT__` for the path segments: `projects/__ROOT__-project-a` is the slug of
  `<ROOT>/project-a`, `projects/__HOME__` the slug of `<HOME>`. Each case README states the slug
  rule of its harness; the helper computes the real slug from the temp paths. The same tokens
  appear inside file contents wherever a slug path is spelled out (a transcript's `file_path`,
  `sessions-index.json`), so the helper rewrites them in contents too.
- **Nested git entries** are committed as `_git` (directory or file) and renamed at copy time
  via `"renames": [{ "from": "root/project-a/_git", "to": "root/project-a/.git" }]`. A linked
  worktree's `.git` FILE is a `_git` file holding `gitdir: <ROOT>/project-a/.git/worktrees/<name>`.
  These `_git` trees carry only `HEAD` (plus `worktrees/<name>/{gitdir,commondir,HEAD}`): enough
  for discovery, not for the git binary. Renames apply first; `symlinks`, `ages` and `dirs`
  paths name the post-rename tree.
- **Empty directories** git cannot hold are listed under `"dirs": ["home/.codex/log", …]` and
  created at copy time.
- **Symlinks** are declared, never committed: `"symlinks": [{ "path", "target", "kind" }]` where
  `target` is the link text relative to the link's parent directory (`../../.agents/skills/x`,
  what `readlink` returns and what the Vercel skills CLI writes). The helper resolves it
  against the link's directory (junctions on Windows need the absolute form) and creates the
  link without checking that the target exists, so dangling links are expressible.
- **SQLite placeholders** cannot be rewritten textually: `"sqlite": [{ "path", "rewrite":
  [{ "table", "column" }] }]` names the columns whose text values contain `<HOME>`/`<ROOT>`
  (possibly inside JSON or `file://` URIs); the helper runs a substring `REPLACE` on them after
  the copy. The `UPDATE` branches on `json_valid()`: a column holding a JSON document gets the
  JSON-escaped spelling of the temp path, so a Windows path never lands inside JSON with
  unescaped backslashes — the same rule text files get. `file://` values are rewritten first,
  to the URI form (below), and a committed `-wal`/`-shm` sidecar is restored afterwards.
- **Synthetic transcripts.** No transcript, session log, tool result or shell snapshot is ever
  copied. Each case writes one tiny synthetic file per needed item (a 2-line JSONL with only
  the fields an adapter reads: `cwd`, `sessionId`, one `tool_use`) and its README says so.
- **Tiny SQLite files.** Never a copy of a real database: each is built with `node:sqlite` from
  the real DDL read from `sqlite_master` (opened `?mode=ro`, `readOnly: true`) or, when the real
  file may not be opened (Cursor's `state.vscdb`), from the public schema, with 2–4 synthetic
  rows. Every case README lists the DDL. A WAL-flagged fixture opened `?mode=ro` in a writable
  copy creates `-wal`/`-shm` sidecars; open with `?immutable=1` when the tree must stay untouched.
- **MCP and auth material.** Files whose name matches `mcp|auth|oauth|cred|secret|token|key|
  .env|google_accounts` are never opened by the capture scripts; every MCP-server entry in a
  fixture is synthesised from the documented key and transport enumerations. Some cases commit
  **zero-byte files at those names** (`oauth_creds.json`, `.env`, …) so "the adapter never opens
  them" is testable; adapters must treat an empty file as present-but-unreadable.
- **Placeholders in URIs.** A placeholder directly after `file://` is rewritten to the *URI* form
  of the temp path, not to the path: percent-encoded, forward-slashed, and `/C:/Temp/…` on
  Windows. So `file://<ROOT>/project-a` becomes `file:///tmp/…/root/project-a` on POSIX and
  `file:///C:/Temp/…/root/project-a` on win32 — a URI `fileURLToPath` decodes back to
  `tree.path("root/project-a")` on either. Write the placeholder immediately after `file://`
  (never `file:///<ROOT>`), and keep any encoding the fixture already carries
  (`Application%20Support`).
- **Deliberate prune targets.** `node_modules/` and `dist/` marker files (a 40-byte
  `node_modules/pkg/CLAUDE.md` or `package.json`) are committed on purpose in `shared/root-tree`
  and `claude-code/skills-and-plugins` so "scanner skips them" is testable; nothing else under
  `node_modules` is allowed, and the root `.gitignore` anchors its patterns for that reason.
- **Identifiers.** Ids are visibly fake and stable: UUIDs `00000000-0000-4000-8000-00000000000N`,
  same-digit 40-hex ids, epoch `1700000000000` ms with round day offsets, md5 of a placeholder
  URI where a harness hashes a path. `<redacted>` never appears in a file or directory NAME
  (`<`/`>` are illegal on Windows). Absolute paths that must never exist keep a literal form
  (`/Volumes/Backup/old`); the helper rewrites placeholders textually and never validates them.
- **Size.** Per case < 300 KB of file bytes (disk blocks are larger: many tiny files). No
  binaries other than the SQLite files. Markdown bodies are filler lines that mirror the line
  count and byte size of a real file where one existed; no sentence of an original survives.
  Redaction keeps JSON/TOML/YAML keys only when they are schema names: hashes, uuids, timestamps
  or paths used as keys become `<redacted>-N`, nested maps of user-named entries are capped at
  3 entries and renamed `entry-N` (TOML) or anonymised.

- **Ignored names.** A case may carry files whose names match a `.gitignore` inside the case
  (`claude-code/breadcrumbs/root/project-a/.gitignore` ignores `CLAUDE.local.md` and
  `.claude/settings.local.json`) or the machine's global git ignore; a plain `git add` then drops them
  silently (the first capture commit lost three). They are force-added: after regenerating a case run
  `git add -f fixtures/<harness>/<case>` and check `git status --ignored` for the case. A later
  contract change may commit such files as `_gitignore` and rename them at copy time, like `_git`.

## Regenerating a case

Every case is produced by `fixtures/_capture/<harness>.mjs` (dependency-free, Node 24, idempotent:
it deletes and recreates only its own case directories). Re-run with
`node fixtures/_capture/<harness>.mjs`. The scripts read structure from the local machine where a
source exists (key names, line and byte counts, DDL) and fall back to the documented shapes
otherwise; they print counts and paths only and end with a leak check. The few real project
directories they mirror are named in `fixtures/_capture/sources.local.json` (gitignored; copy
`sources.example.json`) — without it every mirror uses the documented fallback.
`fixtures/_capture/codex.ddl.json` is the committed DDL snapshot that lets the Codex case
regenerate on a machine without `~/.codex/state_5.sqlite`.

## Cases

| Case | Represents | Edge cases | Synthetic |
|---|---|---|---|
| `claude-code/breadcrumbs` | `~/.claude.json` + `~/.claude/` of a user with live, moved, nested and gone projects | six `projects` key kinds (repo, subdirectory, linked worktree, ghost with local MCP, bare `<HOME>`, unreachable volume); slug dirs with memory/transcript/orphan/stray combinations; user + local + project MCP shapes incl. an invalid entry; `githubRepoPaths` naming an unknown path; retention ages vs `cleanupPeriodDays`; hooks/plugins/permissions settings; `.git` worktree registrations (live + stale); context hierarchy (`CLAUDE.md`, `CLAUDE.local.md` import, nested, rules with/without `paths:`, agents with memory, commands) | transcripts (2 JSONL lines), tool results, sessions index, history, shell snapshot, todos/tasks, backup, all MCP entries, all settings; mirrored structure only: `~/.claude.json` top-level keys, per-project field union, memory + CLAUDE.md line/byte counts |
| `claude-code/skills-and-plugins` | skills, Vercel `~/.agents` store, plugins and marketplaces | `~/.claude/skills` with real dir, relative symlink, dangling symlink and skills-dir plugin; `.skill-lock.json` v3 with linked/orphan/dangling entries; `installed_plugins.json` v2 with present and missing caches, unreferenced 60-day cache, `.in_use` PID marker; marketplace clone present vs missing, `.bak` leftover, `node_modules` prune marker; plugin root that looks like project config; project skills real copy + symlink, `skills-lock.json` v1 with missing entry | every Markdown body, lock values, plugin/marketplace manifests, hooks, plugin `.mcp.json`; mirrored: frontmatter keys and counts of one real skill per layout, top-level keys of the plugin JSON files |
| `codex/trust-and-state` | `~/.codex` with `config.toml` trust map, `state_5.sqlite`, rollouts, skills, desktop-app state | trust entries for live/untrusted/gone/container/`<HOME>`/`/`; `threads.cwd` incl. a subdirectory and `/`, `project_id` NULL, FK to a missing table; WAL header without sidecars; old flat-format rollout, `.jsonl.zst` rollout, archived layout; empty `AGENTS.override.md` at user scope vs non-empty at project scope, nested `AGENTS.md`; feature-flagged memories; three skill generations (symlink, real copy with 60 KB payload, bundled `.system`); Starlark rules and hooks at two scopes; desktop `.codex-global-state.json` + `.bak` + `.tmp-*` leftovers | every config value (keys mirrored), all `[mcp_servers.*]`/`[projects.*]` tables, project configs, rules, hooks, every Markdown body and JSONL line, `state_5.sqlite` (real DDL, 4 rows), desktop state |
| `copilot/trust-and-sessions` | Copilot CLI `~/.copilot` + VS Code Copilot state and project `.github/` | `trusted_folders` live/ghost/`<HOME>`; sessions with full, minimal (ghost, no events) and fold-to-git-root key sets, aged directories; Markdown inside session state that is not context; `session.db` with no path column; VS Code workspaceStorage duplicates, `<HOME>` workspace, ghost workspace; `recentlyOpenedPathsList` folder/file/workspace shapes, trust model; two MCP schemas side by side; `.github` instructions/skills/agents/prompts next to non-Copilot files; a repo whose `.github` never qualifies; settings widening discovery to `.claude/skills` | all MCP files, `workspace.yaml`, `events.jsonl`, checkpoints, logs, Markdown bodies, all ids; `session.db` and `state.vscdb` rows (real DDL); `config.json`/`settings.json`/`storage.json` keys kept, values redacted, opaque keys dropped |
| `cursor/workspaces` | Cursor `workspaceStorage`, `~/.cursor/projects`, worktrees, rules | case-only pair `API-NESTJS`/`api-nestjs` (platform-dependent folding); ghost folder with stale worktree; duplicate storage dirs for one folder; subdirectory workspace; home as workspace; `{"workspace"}` entry with missing target; bare numeric slug; live linked worktree carrying rules; all four `.mdc` rule types + legacy `.cursorrules`; `mcp.json.backup`, `state.vscdb.backup`, empty `-wal`; skills real dir + symlink + built-ins; project `.cursor` extras | all MCP files, every `~/.cursor/projects` file, all 11 SQLite files (public schema), all Markdown (rule frontmatter/counts mirrored), storage ids = md5 of placeholder URIs, `cli-config.json`/`ide_state.json` keys only |
| `gemini-cli/from-docs` | a Gemini CLI home and projects built entirely from the documentation | orphan breadcrumb in `projects.json`/`trustedFolders.json`; stray legacy 64-hex slug; slug collision `project-b`/`project-b-1`; `DO_NOT_TRUST` folder whose settings must be ignored; `context.fileName` naming `AGENTS.md`; `@import` in `GEMINI.md`; skill precedence across `.gemini/skills`, `.agents/skills`, `skills.disabled`, symlink, extension tier; MCP servers at four places; unloaded project extension; legacy flat settings keys; harness cache tree; zero-byte secret-named files; commands namespaces; agents at three tiers | everything (no Gemini breadcrumbs existed on the capture machine) |
| `gemini-cli/zero-breadcrumbs` | `~/.gemini` with no projects, plus Antigravity IDE leftovers | no `projects.json`/`trustedFolders.json`, empty `tmp/`; skill symlink fan-out into `~/.agents/skills` + dangling link; `~/.gemini/antigravity/` must not be read as Gemini config; observed settings key set only; `settings.json.orig` backup; zero-byte `GEMINI.md` | everything |
| `opencode/db-and-config` | OpenCode `opencode.db`, config, both skill-dir generations, legacy JSON store | `project.worktree` rows for live/ghost/`<HOME>`/`/`; child session in a subdirectory, archived session; legacy `storage/` next to the database; `skill/` (real copies, 2249-line `AGENTS.md` payload) and `skills/` (symlink) side by side; `AGENTS.md`/`README.md` inside a skill; same skill in `.opencode/skill` and `.claude/skills`; package files in `~/.config/opencode` and `.opencode`; `opencode.json` with relative + absolute instructions, `opencode.jsonc`; `CLAUDE.md`-only fallback project | `opencode.db` (real DDL, synthetic rows), user config (keys mirrored, MCP synthesised), legacy store (documented shape, no real file opened), all Markdown (payload counts mirrored, `rules/` trimmed to 2 files), everything under `root/` |
| `shared/root-tree` | a projects root exercising discovery rules, harness-independent | monorepo with two root context files and nested ones; `node_modules`/`dist` prune markers; nested `vendor/lib/.git` under the pruned `vendor/` (a Project only through a breadcrumb, D26); `AGENTS.md` inside a skill payload; project by markers only; non-project; worktree registrations live + dead; linked worktree `.git` file; detached worktree with no marker (a breadcrumb reaches it, D27); depth-7 context file; directory symlink the walk never follows; no `home/` | everything |
| `shared/skill-layouts` | the Vercel skills store and its per-agent links | canonical `~/.agents/skills` + symlink in `~/.claude/skills`; real copy without lock entry; `.skill-lock.json` v3 with a gone entry; project-scope duplicate with drift; `skills-lock.json` v1 with an absent entry; project without `.git` | everything |
