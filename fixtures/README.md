# Fixture trees

Anonymised copies of what the six harnesses leave on disk, one directory per case:
`fixtures/<harness>/<case>/`. Shared by `packages/core`, `packages/cli` and any future app.

The contract:

- A case is a real directory tree, committed as-is, with every value that could identify a
  person or machine replaced by `"<redacted>"`. Never commit a token, key or transcript.
- Absolute paths inside files (`~/.claude.json`, `config.toml`, …) use the placeholders
  `<HOME>` and `<ROOT>`; the test helper rewrites them when it copies the case.
- Each case carries a `fixture.json` describing what git cannot: symlinks (created at run time,
  with `"junction"` for directories on Windows) and file ages (`{ "path", "ageDays" }`, applied
  with `utimes`, so "older than 30 days" rules are testable).
- Tests never touch the real home directory: the helper copies the case into a fresh temp
  directory (`mkdtemp` + `realpath`) and the scanner receives the home directory, the
  directories to scan, the working directory, the platform and the environment explicitly.
  Snapshot serialisers normalise `<ROOT>`, path separators and ordering.
