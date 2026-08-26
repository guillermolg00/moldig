---
status: accepted
date: 2026-08-25
---

# One monorepo: open-source CLI (MIT) and paid desktop app share the same core

The engine (index, graph, detectors, adapters) and the CLI are open source; the paid app only adds UX and convenience features (bulk operations, background watch, rollback, a richer graph than the terminal's) on top of the same core packages from the same repository. Alternatives were a closed CLI (kills organic distribution and community adapters) or separate repos for CLI and app (the core would drift). The moat is the index format becoming a de-facto standard plus execution speed, not a secret algorithm.

## Consequences

- Core packages must stay free of terminal- or app-specific dependencies so both consumers can use them unchanged.
- Anything the app needs from the engine is added to the open core, not kept private.

## Amendment (2026-08-25, grilling round 1)

The terminal UI ships its own dependency-graph view in v1. The app's graph is a richer version of it, not an exclusive feature.
