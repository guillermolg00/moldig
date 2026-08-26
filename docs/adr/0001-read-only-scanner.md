---
status: accepted
date: 2026-08-25
---

# The scanner only reads the filesystem; it never executes a harness, agent or MCP server

Starting an MCP server would detect broken ones far more reliably than static checks, and invoking a harness would tell us exactly what context it loads. We still decided the scan is strictly read-only: a tool that touches AI configuration is only adoptable if it is trivially auditable and safe to run on any machine, and read-only adapters are pure functions over file contents, testable against fixture directories without a live harness.

## Consequences

- "Orphan MCP server" detection relies on static evidence only (command on `PATH`, package resolvable, referenced path exists), never on launching the server.
- What a harness "loads per session" is modelled from its documented rules, not observed at runtime.
- Only `clean` (and later `update`/`migrate`) write to disk, and only after a preview the user confirmed.
