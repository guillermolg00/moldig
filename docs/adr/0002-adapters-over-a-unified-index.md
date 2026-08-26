---
status: accepted
date: 2026-08-25
---

# Every harness is an isolated adapter that emits into one harness-agnostic index

Each harness's on-disk formats change fast and none of them is worth coupling the product to. So each harness gets its own adapter that only knows how to locate and parse that harness's files, and everything downstream (the graph, the detectors, the terminal UI, the future app) depends only on the unified index. A new harness is a new adapter and nothing else.

## Consequences

- The index schema is the contract shared by the CLI and the app; it is the first design decision to close and the most expensive one to change later.
- Cross-harness features (duplicates across Claude Code and Codex, one view of every project) are free once two adapters exist; they never need harness-specific code.
- Community adapters (Windsurf, Cline, …) can be contributed without touching core.
