import { HARNESSES } from "@moldig/core";

/** What `moldig` prints until the scanner exists. */
export function banner(): string {
  return `moldig — coming soon. It will scan ${HARNESSES.length} harnesses: ${HARNESSES.join(", ")}.`;
}
