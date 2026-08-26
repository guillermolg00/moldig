/**
 * The guard a suite uses when it asserts the index of a fixture tree.
 *
 * Every fixture case is a POSIX tree: its paths, its `.claude.json` keys, its symlinks and the
 * byte counts of the files whose `<HOME>` / `<ROOT>` placeholders are rewritten with real paths
 * all assume `/`. A suite then pins `platform: "darwin"` so one snapshot serves every host. On a
 * Windows host the two halves contradict each other — the tree the host writes is
 * `C:\…\home\.claude`, the index the suite asserts is a darwin index, a JSON file embedding a
 * path is longer by one byte per separator it escapes, and a directory symlink is a junction
 * whose target is absolute. Those differences are the contradiction, not defects: nothing about
 * them says whether moldig reads a real Windows machine correctly.
 *
 * What does say it runs from every host, because paths are strings: the suites that pin
 * `platform: "win32"` over win32 spellings — `pathEngine`, `pathIdentity`, `presenceOf` and the
 * mount-root rule, the user-scope table, `discovery`. Those never skip. The Windows leg of CI
 * runs them, the typecheck, the lint and the build; it does not run a POSIX tree through a
 * darwin index and call the mismatch a failure.
 */
export const POSIX_FIXTURE_HOST: boolean = process.platform !== "win32";
