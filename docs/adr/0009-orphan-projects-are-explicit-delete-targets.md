# 9. Orphan Projects are explicit aggregate Delete targets

Date: 2026-08-27

## Status

Accepted.

## Context

A Project whose directory is gone can survive in several harness stores at once: a project or trust entry, a slug directory, workspace storage, session rows, and the state each record owns. Treating those files as independent selection rows is the wrong unit. A machine with 105 orphan Projects produced hundreds of rows and one operating-system trash hand-off per row; while those calls ran, the TUI showed only `running…`. Deleting the child files also left the Project breadcrumbs behind, so the unchanged list made a successful run look unsuccessful.

ADR-0004 required human-owned configuration to be selected one item at a time. That remains the default, but it prevents the user from expressing the more useful intent here: “this Project no longer exists; delete every harness record for it.”

## Decision

An orphan Project is an explicit aggregate **Delete** target. The TUI lists orphan Projects, lets the user toggle individual Projects or all of them, and does not require an item-by-item review. The aggregate always asks twice before it runs.

The actions engine derives the aggregate from each selected Project's Breadcrumb locators and the harness-owned state behind them. On-disk paths retain one manifest row per Project but are handed to the operating-system trash in one batch. Store records remain precise recoverable edits: JSON/JSONC entries and array values preserve surrounding bytes, Codex Project trust tables are removed narrowly from TOML, and exact SQLite breadcrumb rows are removed transactionally after an online database backup. A live child blocks its enclosing state target. Every failed or refused row remains visible in the manifest and never aborts the rest.

After any interactive run, moldig scans and audits again before returning. Project lists and Findings therefore describe the disk after the action, not the immutable Index that preceded it.

## Consequences

ADR-0004 is amended: human-owned items still require explicit per-item selection except when they are contained by an explicitly selected orphan Project. The Project selection, the second confirmation, and recoverable disposition together form that exception.

The scanner remains read-only (ADR-0001). SQLite and TOML writes exist only in the actions path, behind injected CLI executors and a completed backup. A busy or incompatible store fails its row rather than being rewritten speculatively.

The Result manifest remains the source of truth, while the refreshed Index becomes the source of truth for subsequent navigation. Large orphan cleanups now have visible row and scan progress instead of an ambiguous `running…` frame.
