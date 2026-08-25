# gemini-cli / zero-breadcrumbs

Gemini CLI installed and signed in, but never used inside a project: the exact shape research 09
found on the capture machine (`~/.gemini` with no `projects.json`, no `trustedFolders.json`, no
`commands/`, `extensions/` or `history/`, and an empty `tmp/`). Everything is synthesised by
`fixtures/_capture/gemini-cli.mjs` from the observed-shape notes in research 09 and research 02
("On this machine", `~/.gemini/` paragraph); no real file was opened.

## Tree

- `home/.gemini/GEMINI.md`: 0 bytes (as observed).
- `home/.gemini/settings.json`: the observed key set only (`ide.hasSeenNudge`,
  `security.auth.selectedType`, `mcpServers.<name>.{type,url,headers.Authorization}`), plus
  `settings.json.orig` (rotating backup, aged 200 days).
- `home/.gemini/skills/`: three symlinks into `~/.agents/skills/` (declared in `fixture.json`),
  one of them dangling (`skill-gone`).
- `home/.agents/`: Vercel skills canonical store (`skills/<name>/SKILL.md`, `.skill-lock.json`).
- `home/.gemini/antigravity/`: Google Antigravity IDE state (`skills/`, `global_skills/`,
  zero-byte `mcp_config.json`, `installation_id`, empty `brain/<uuid>/` and `conversations/`).
- `home/.gemini/tmp/`: empty (`dirs` in `fixture.json`).
- `root/project-a/`: a git repo with `AGENTS.md` and no Gemini configuration.

## Edge cases carried

1. Zero breadcrumbs: the adapter must yield no projects and no strays, and must not treat the
   home directory or `~/.gemini` as a project.
2. Symlink fan-out: `~/.gemini/skills/<n>` -> `../../.agents/skills/<n>` must dedupe against the
   canonical store instead of reporting duplicates; the dangling `skill-gone` link is an orphan.
3. `~/.gemini/antigravity/` is not Gemini CLI: its `skills/` and `global_skills/find-skills`
   (a third copy of a public skill) belong to Antigravity; `mcp_config.json` there is not a Gemini
   MCP config.
4. The observed `settings.json` mixes v2 nested keys with top-level `mcpServers` and carries a
   remote server whose `headers.Authorization` is a secret.
5. `settings.json.orig` is a backup file next to the live one (harness cache candidate).
6. Secret files (`oauth_creds.json`, `google_accounts.json`) are zero-byte placeholders.

## Synthetic content

Everything; the real files were never opened. The `type` value of the observed MCP server is
unknown and therefore `<redacted>` rather than an enumeration. Skill names `find-skills` and
`next-best-practices` are public open-source skill names; bodies are filler lines.

## fixture.json

`renames` (one), `symlinks` (three; `target` is the link text relative to the link's parent
directory), `ages` (one), `dirs` (three empty directories).

## Slug rule

Same as `from-docs` (`basename` lowercased, non-`[a-z0-9]` -> `-`, `-1`/`-2` on collision,
mapped in `projects.json`); no slug directory exists in this case.

## Documentation this case depends on

- Research 09: "Gemini CLI has no `projects.json`, no `trustedFolders.json` and an empty `tmp/`:
  zero"; `~/.gemini/GEMINI.md` exists but is 0 bytes; `~/.gemini` is user scope, never a root.
- Research 02 "On this machine": `~/.gemini/` entries and `settings.json` key names, `skills/`
  symlinks to `../../.agents/skills/`, Antigravity subtree, `~/.agents/.skill-lock.json` shape;
  open question 12 (Antigravity is opaque app state); open question 11 (symlink dedupe).
