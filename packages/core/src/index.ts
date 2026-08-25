/**
 * The moldig engine. The index, adapters, detectors and graph land here once
 * the unified index schema is settled; until then the package only carries
 * the vocabulary needed to prove the toolchain end to end.
 */

/** The harnesses moldig v1 knows how to scan. */
export const HARNESSES = [
  "claude-code",
  "codex",
  "cursor",
  "gemini-cli",
  "copilot",
  "opencode",
] as const;

export type HarnessId = (typeof HARNESSES)[number];
