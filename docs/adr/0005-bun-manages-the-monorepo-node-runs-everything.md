---
status: accepted
date: 2026-08-25
---

# Bun manages the monorepo; everything executes on Node

Bun is the package manager and script runner of the repository (`bun install`, `bun run <script>`, workspaces, `bun.lock`, `bun pm pack`), but nothing that decides whether moldig works runs on Bun's runtime: the type-checker, the bundler, the linter, the tests and the CLI itself all run on Node, through the `#!/usr/bin/env node` shebang that Bun honours for package binaries. End users run `npx moldig` on Node (floor `>=22.18`), and every open Bun-vs-Node divergence found during research sits in `node:fs`, `node:path` and `node:os` — the scanner's whole surface (`os.homedir()` ignoring a mutated `HOME` under Bun 1.3.14 was reproduced locally). Alternatives were pnpm workspaces end to end (safer on Windows CI and with trusted publishing, but Guillermo prefers Bun's speed and the dependencies it replaces) and Bun end to end (`bun test`, `bun build`), rejected because tests would pass on a runtime the users never run and `bun build` cannot emit `.d.ts`. Facts: `docs/research/07-toolchain-facts.md`, `docs/research/08-bun-vite-tanstack-facts.md`.

## Consequences

- `bun run test`, never `bun test`; `--bun` is never passed to a script. CI installs Bun only to run scripts and pins Node per job (22.18, 24 and 26 on Linux; 24 on macOS and Windows).
- Bundling is tsdown (Rolldown), pinned exactly because it is 0.x with breaking minors; `.d.ts` come from oxc through `isolatedDeclarations`; type-checking is TypeScript 7's native `tsc --noEmit` per package, with no project references.
- `moldig` bundles `@moldig/core` (declared as a devDependency) into one file, so `npx moldig` ships zero runtime dependencies and the `workspace:*` link never reaches npm. `@moldig/core` is published on its own for the app and third parties.
- Publishing uses the npm CLI under trusted publishing (`bun pm pack`, then `npm publish` of the tarball), because `bun publish` has neither OIDC nor provenance yet. Releases are lockstep (`bumpp -r` + `changelogithub` on `v*` tags).
- Lint and format are oxlint (type-aware, which needs TypeScript 7) and oxfmt, pinned exactly; oxfmt is still 0.x, so bumps may reformat files.
- Packages import each other from source through the `@moldig/source` export condition (TypeScript `customConditions`, Vitest `resolve.conditions`, tsdown `inputOptions.resolve.conditionNames`), so type-check, tests and the CLI bundle all read the same code and `tsdown --watch` in the CLI follows core edits; published `exports` point at `dist`.
- Bun 1.4.0 is pinned while only days old (Guillermo's call, for what it replaces); `bun.lock` is lockfileVersion 2, unreadable by Bun 1.3.
