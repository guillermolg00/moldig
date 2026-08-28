---
status: accepted
date: 2026-08-25
revised: 2026-08-27 (ADR-0009 — an explicitly selected orphan Project is one aggregate Delete target)
---

# Clean sweeps only harness-owned items; human-owned items require an explicit Delete target

moldig scans and shows everything. The **clean** sweep — the CleanMyMac-style pass with preselected candidates — covers only **harness-owned** items: memory files and harness cache. **Human-owned** items (context files, skills including third-party ones installed on purpose, agent definitions, MCP server entries) are never part of a sweep and never preselected. Normally they can be **deleted** or **updated** only through an explicit per-item selection, grouped by action, with each group confirmed as a whole before anything runs. ADR-0009 adds one aggregate Delete target: an explicitly selected orphan Project, whose complete harness records ask for a second confirmation. Every removal is recoverable. The alternative, one flat list where anything flagged can be ticked and swept, was rejected: a false positive on a human-owned item destroys deliberate work, while a false positive on harness state costs at most a re-scan, so the two must never share a checkbox list or a confirmation.

## Consequences

- Preselection exists only in clean, and only for harness cache the harness itself documents as sweepable (e.g. Claude Code's 30-day sweep set); memory files are shown with their signals (age, size, never read) but never preselected.
- Findings on human-owned items are advice that leads to an explicit action (open, delete, update), each with its own selection pass and confirmation, in the order clean → delete → update.
- An orphan Project may be selected as one aggregate Delete target; it is never preselected by Clean and always asks twice (ADR-0009).
- **Shared** items (git-tracked, project-scoped) carry an explicit warning on every suggested action, since collaborators may depend on them.
- Every removal is recoverable: files go to the OS trash (macOS, Windows, Linux alike); any config file is backed up before an entry is removed from it.
