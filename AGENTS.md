# moldig

CleanMyMac for your AI setup: a terminal tool that scans, shows and cleans the skills, MCP servers, context files and memories that AI coding harnesses leave across every project on a machine. Read `.scratch/moldig-v1/map.md` for where the effort stands (destination, decisions, open tickets) and `CONTEXT.md` for the vocabulary. `.scratch/` and `docs/research/` are local-only (gitignored): the research notes describe Guillermo's machine in detail. The decisions in `docs/adr/`, these agent conventions and `docs/release.md` are tracked. The original vision document (`moldig-plan.md`) is kept by Guillermo outside the repo.

Conventions: repo docs, tickets, specs and code comments are written in English; conversation with Guillermo is in Spanish. Keep this file minimal — moldig's own thesis is that bloated context files hurt.

## Working in the repo

Bun manages the workspace (`bun install`, `bun run <script>`) but everything executes on Node: `bun run test`, never `bun test` (ADR-0005). `bun run check` = typecheck + lint + format check; then `bun run test`, `bun run build`, and `node packages/cli/dist/cli.mjs` runs the built CLI. `packages/core` must stay free of terminal dependencies (ADR-0003); `packages/cli` bundles it.

## Agent skills

### Issue tracker

Local markdown under `.scratch/<effort>/` (current effort: `.scratch/moldig-v1/`). See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `CONTEXT.md` at the root, ADRs in `docs/adr/`. See `docs/agents/domain.md`.
