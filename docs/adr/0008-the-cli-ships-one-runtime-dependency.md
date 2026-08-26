# 8. The CLI ships one runtime dependency: `trash`

Date: 2026-08-26

## Status

Accepted.

## Context

Ticket 10 promised `npx moldig` would ship with zero runtime dependencies: everything, `@moldig/core` included, is bundled into `dist/cli.mjs`. Ticket 08 §3 then decided that every removal goes to the operating system's trash, so that nothing moldig does is unrecoverable, and named the `trash` package as the way to do it.

Those two decisions collide. `trash@10.1.1` ships `lib/macos-trash` and `lib/windows-trash.exe` — native helper binaries a JavaScript bundler cannot inline. Verified by unpacking the published tarball, 2026-08-26.

The alternatives were: reimplement the trash for three operating systems (macOS's Finder API, the XDG trash specification with its `.trashinfo` files and per-volume trash directories, and the Windows shell's recycle bin), or move deleted items to a directory moldig owns. The first is a large amount of platform code whose failure mode is losing a user's file. The second loses "Put Back" — the recovery path every user already knows — and leaves moldig holding data it promised not to hold.

## Decision

`moldig` declares exactly one runtime dependency, `trash`, and it is deliberately not bundled. `@moldig/core` keeps the executor interface and stays free of terminal and platform concerns (ADR-0003); the CLI package implements the executors. Everything else — the engine, the tokenizer, the parsers, Ink and React — is still bundled, so an install pulls `trash` and its dependencies and nothing else.

## Consequences

The install is no longer a single file. `npx moldig` fetches a small dependency tree, and the packaging tests assert the bundle's externals so nothing else creeps in.

In exchange, a removal is recoverable by the means the user already trusts, on every platform, without moldig shipping code that moves files near a recycle bin and hopes. On a volume the helper cannot reach — a network mount, a read-only volume, a mount outside the system's trash table — moldig refuses the row and says why, rather than falling back to a deletion (ticket 08 §3).
