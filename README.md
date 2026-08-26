# moldig

CleanMyMac for your AI setup: a terminal tool that scans, shows and cleans the skills, MCP
servers, context files, memory files and harness cache that AI coding harnesses leave across
every project on a machine.

```sh
npx moldig
```

**The full page is [`packages/cli/README.md`](packages/cli/README.md)** — what moldig finds, the
four commands with their flags and exit codes, the six harnesses and what is read for each, the
safety promises, and where moldig keeps its own files.

## Layout

| | |
|---|---|
| `packages/core` | the engine: the index, the adapters, the detectors, the actions engine and the graph. Published as [`@moldig/core`](packages/core/README.md), free of terminal concerns (ADR-0003) |
| `packages/cli` | the commands and the interactive experience. Published as `moldig`; bundles the engine, with one runtime dependency, `trash` |
| `fixtures/` | anonymised trees of the six harnesses that every test runs against |
| `packaging/homebrew/` | the formula generator for the `guillermolg00/homebrew-tap` tap |
| `CONTEXT.md` | the vocabulary. Every user-visible string uses these words |
| `AGENTS.md` | how to work in this repository |

## Working on it

Bun manages the workspace; everything that decides whether moldig works executes on Node
(ADR-0005).

```sh
bun install
bun run check     # typecheck, lint, format check
bun run test      # Vitest on Node — never `bun test`
bun run build     # tsdown, core first
node packages/cli/dist/cli.mjs
```

Releases are lockstep across both packages and follow [`docs/release.md`](docs/release.md).

MIT © Guillermo López
