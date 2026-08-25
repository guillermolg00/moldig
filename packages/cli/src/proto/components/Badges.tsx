// THROWAWAY PROTOTYPE (ticket 09) — short badges: shared, permanent, user content, never
// read, live, sensitive (+ a few row states) and the severity badge of findings.
import { Text } from "ink";
import type { ReactElement } from "react";
import { SEVERITY_COLOR } from "../lib/format.js";
import type { Badge } from "../lib/selection.js";

const BADGE_COLOR: Readonly<Record<Badge, string>> = {
  shared: "yellow",
  permanent: "red",
  "user content": "magenta",
  "never read": "cyan",
  live: "blue",
  sensitive: "gray",
  secret: "red",
  dangling: "red",
  invalid: "red",
  shadowed: "gray",
  kept: "gray",
  "size only": "gray",
};

export function Badges({ badges }: { readonly badges: readonly Badge[] }): ReactElement | null {
  if (badges.length === 0) return null;
  return (
    <Text>
      {badges.map((b) => (
        <Text key={b} color={BADGE_COLOR[b]}>
          {" "}
          [{b}]
        </Text>
      ))}
    </Text>
  );
}

export function SeverityBadge({
  severity,
}: {
  readonly severity: "low" | "medium" | "high";
}): ReactElement {
  return <Text color={SEVERITY_COLOR[severity]}>● {severity.padEnd(6)}</Text>;
}
