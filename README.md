# moldig

CleanMyMac for your AI setup: a terminal tool that scans, shows and cleans the skills, MCP
servers, context files, memory files and harness cache that AI coding harnesses leave across
every project on a machine.

```sh
npx moldig
```

**The full page is [`packages/cli/README.md`](packages/cli/README.md)** — what moldig finds, the
four commands with their flags and exit codes, the safety promises and the six harnesses.

## Layout

| | |
|---|---|
| `packages/core` | the engine: the index, the adapters, the detectors and the graph. Published as `@moldig/core`, free of terminal concerns (ADR-0003) |
| `packages/cli` | the command-line tool. Published as `moldig`; bundles the engine into one file |
| `fixtures/` | anonymised trees of the six harnesses that every test runs against |
| `CONTEXT.md` | the vocabulary. Every user-visible string uses these words |
| `AGENTS.md` | how to work in this repository |

Bun manages the workspace, everything executes on Node: `bun install`, then `bun run check`
(typecheck, lint, format), `bun run test` (Vitest — never `bun test`) and `bun run build`.
`node packages/cli/dist/cli.mjs` runs the built CLI.

MIT © Guillermo López
