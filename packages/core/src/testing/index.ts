/**
 * `@moldig/core/testing` — the fixture tree helper shared by every package's tests.
 * Copies a case from `fixtures/<harness>/<case>/` into a temp directory (never the real home).
 * `treePaths` is how a test names a path inside that tree: never `${tree.home}/…` by hand, or
 * the string is `C:\…\home/.claude/…` on Windows and no id matches.
 */
export { loadFixture, normaliseSnapshot } from "./fixture-tree.js";
export type { FixtureOptions, FixtureTree } from "./fixture-tree.js";
export { treePaths } from "./tree-paths.js";
export type { PathTree, TreePaths } from "./tree-paths.js";
