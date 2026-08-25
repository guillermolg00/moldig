# gemini-cli / from-docs

The complete Gemini CLI layout as documented, on a machine with three live projects, one gone
project and one legacy scratch directory. Nothing here was captured: Gemini CLI left no
breadcrumbs on the capture machine (research 09), so every file is synthesised from the
"Gemini CLI" section of `docs/research/02-other-harnesses-on-disk-layout.md` by
`fixtures/_capture/gemini-cli.mjs`. Values are `<redacted>`; only keys, enumerations,
filenames and path placeholders are real.

## Tree

- `home/.gemini/` user scope: `GEMINI.md` (with a legacy `## Gemini Added Memories` section),
  `settings.json` (v2 nested keys + top-level `mcpServers` with one stdio server, `hooks`,
  `context.fileName` = `["GEMINI.md","AGENTS.md"]`), `projects.json`, `trustedFolders.json`,
  `commands/**/*.toml`, `skills/`, `agents/`, `extensions/ext-a/` (+ `extension-enablement.json`),
  `tmp/<slug>/`, `history/project-a/`, `installation_id`, `keybindings.json`,
  `acknowledgments/agents.json`, and zero-byte placeholders at the secret file names
  (`oauth_creds.json`, `google_accounts.json`, `mcp-oauth-tokens.json`, `.env`).
- `home/.agents/skills/skill-d/`: target of the `~/.gemini/skills/skill-d` symlink.
- `root/project-a/`: git repo with `GEMINI.md` (one `@./docs/context-import.md` import),
  `AGENTS.md`, `.geminiignore`, `.gemini/{settings.json,.env,commands,skills,agents,extensions}`,
  `.agents/skills/`, nested `packages/sub-a/GEMINI.md`.
- `root/project-b/` (legacy flat settings keys), `root/nested/project-b/` (basename collision),
  `root/project-c/` (untrusted). `root/gone/` does not exist on purpose.

## Edge cases carried

1. Orphan breadcrumb: `projects.json` and `trustedFolders.json` name `<ROOT>/gone`; its
   `tmp/gone/` scratch exists (chat aged 120 days, legacy `memory/GEMINI.md` index) but the
   directory is gone.
2. Stray slug: `tmp/0123456789abcdef…/` (64 hex chars, the shape of a legacy `sha256(path)`
   directory; the digest of nothing) is not mapped by `projects.json` and carries no
   `.project_root` (legacy `chats/*.json`, aged 400 days).
3. Slug collision: `<ROOT>/project-b` -> `project-b`, `<ROOT>/nested/project-b` -> `project-b-1`.
4. Untrusted folder: `<ROOT>/project-c` is `DO_NOT_TRUST`, so its `.gemini/settings.json` (one MCP
   server) must be reported as ignored. `TRUST_PARENT` appears once.
5. `context.fileName` lists two names, so `AGENTS.md` is a context file for this user, at the
   project tier and for nested directories (JIT).
6. Skill precedence and duplicates: `skill-e` exists in both `.gemini/skills` and `.agents/skills`
   of project-a (`.agents` wins within the tier); `skill-c` is listed in `skills.disabled`;
   `skill-d` reaches `~/.gemini/skills` through a symlink into `~/.agents/skills`;
   `tmp/project-a/memory/skills/skill-a` is harness-owned memory, not an installed skill;
   `extensions/ext-a/skills/skill-b` is extension-tier.
7. MCP servers at four places: user `settings.json` (stdio: `command/args/env/cwd/timeout/trust`),
   project `settings.json` (`httpUrl` + `headers` + `oauth{}`, and `url` SSE with the
   service-account keys), extension manifest (`${extensionPath}` variable), legacy flat project
   settings (`server-d`).
8. Project `.gemini/extensions/legacy-ext/` is present but is NOT loaded by the extension manager
   on `main`; only `~/.gemini/extensions/` counts.
9. Legacy flat keys (`contextFileName`, `theme`, `checkpointing`) in
   `root/project-b/.gemini/settings.json`.
10. Harness cache under `tmp/project-a/`: `chats/` (+ sub-agent `chats/<parentSessionId>/`),
    `checkpoint-<tag>.json`, `checkpoints/`, `logs.json` + `logs/`, `shell_history`,
    `<sessionId>/{plans,tasks,tracker}/` (`tasks`, `tracker` empty), `~/.gemini/tmp/bin/` (empty);
    shadow repo `~/.gemini/history/project-a/` (`.git` written as `_git`, `.gitconfig` aged 90 days).
11. Memory: `tmp/project-a/memory/MEMORY.md` index, sibling `notes-a.md`,
    `memory/.inbox/memory/0001.patch`.
12. Hooks live inside `settings.json` (`hooks.<Event>[]`) and `<ext>/hooks/hooks.json`; there is
    no `.gemini/hooks/` directory.
13. Zero-byte files at the documented secret names, so a test can assert they are never opened.

## Synthetic content

Everything. Chats, logs, checkpoints and shell history are 1-2 line JSON/JSONL/plain files with
placeholder fields (`sessionId`, `messageId`, `synthetic: true`); their real schema is not
documented in research 02 and the adapter only needs names, sizes and mtimes. Markdown bodies are
filler lines. Session ids are `00000000-0000-4000-8000-00000000000N`. No SQLite: Gemini CLI keeps none.

## fixture.json

`renames` (`_git` -> `.git`, four repositories under `root/` and the shadow repo under
`home/.gemini/history/`), `symlinks` (one; `target` is the link text relative to the link's parent
directory, as `readlink` returns it and as the Vercel skills CLI writes it), `ages` (four files),
`dirs` (three empty directories git cannot hold). No `ages` entry points inside a `_git` tree.

## Slug rule

`~/.gemini/tmp/<slug>/` and `~/.gemini/history/<slug>/` use `slug = basename(path).toLowerCase()`
with every character outside `[a-z0-9]` replaced by `-`; collisions get `-1`, `-2`; the mapping is
recorded in `~/.gemini/projects.json` (`{"projects": {"<abs path>": "<slug>"}}`) and each scratch
directory carries `.project_root`. Older installs used `sha256(path)` directories, auto-migrated.
Because the slug contains no path segment, the `__HOME__`/`__ROOT__` filename tokens are not
needed: the directory is literally `tmp/project-a`. The `projects.json` values are the slugs
themselves (documented), not opaque ids.

## Documentation this case depends on (research 02, Gemini CLI section)

- Context files table: `~/.gemini/GEMINI.md`, walk-up to `context.memoryBoundaryMarkers` (default
  `[".git"]`), JIT subdirectory loading, extension `GEMINI.md`, `tmp/<slug>/memory/MEMORY.md`
  (legacy `memory/GEMINI.md`), `memory/.inbox/<kind>/*.patch`, `memory/skills/` [39][40][42][56][57][58].
- `context.fileName` string|string[]; imports `@./rel.md` max depth 5; `.geminiignore` [43][46][56][58][66].
- Settings tiers and v2 key list; legacy flat keys; `context.*` sub-keys [45][46][54][55].
- `mcpServers.<name>` key shape and `mcp.{allowed,excluded}`; server names without `_` [46][61].
- `.env` discovery names [45][47][60].
- Extensions: only `~/.gemini/extensions/<name>/` is loaded; manifest keys;
  `.gemini-extension-install.json`; bundled dirs; `extension-enablement.json` shape [47][60].
- Skills, commands, hooks, agents tables [48][49][50][51][62][63][64][65].
- Session/state table: `projects.json` shape and slug rule, `tmp/<slug>/` contents, `history/<slug>/`,
  secret file names, `trustedFolders.json` enumeration, `acknowledgments/agents.json` [39][44][52][53][67][68].
- Open questions 7 and 8: legacy `## Gemini Added Memories` heading; v2 + top-level `mcpServers`.

Inferred, not stated in the docs: the content of `.project_root` (written as the absolute path),
the timestamp separator in `session-<ISO ts>-<id8>` filenames (`:` -> `-`), the internals of
`history/<slug>/` (`.git/` + a `.gitconfig` with `[user]`/`[commit]`), the `{"hooks": {...}}`
wrapper of `<ext>/hooks/hooks.json`, the shape of `acknowledgments/agents.json` and
`keybindings.json` (`{}`), and the `type: "git"` value in `.gemini-extension-install.json`.
