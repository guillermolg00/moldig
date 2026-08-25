/**
 * `@moldig/core/testing` — the fixture tree helper shared by every package's tests.
 * Copies a case from `fixtures/<harness>/<case>/` into a temp directory (never the real home).
 */
export { loadFixture, normaliseSnapshot } from "./fixture-tree.js";
export type { FixtureOptions, FixtureTree } from "./fixture-tree.js";
