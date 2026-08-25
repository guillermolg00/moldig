// THROWAWAY PROTOTYPE (ticket 09) — the `?` help overlay: the key map, everywhere.
import { Box, Text } from "ink";
import type { ReactElement } from "react";

const KEYS: readonly (readonly [string, string])[] = [
  ["↑/↓ j/k", "move · PgUp/PgDn, Home/End jump"],
  [
    "enter",
    "open the row (findings → targets, project → items, memory unit / cache group → expand, item → detail)",
  ],
  ["→ / ←", "expand / collapse a memory unit or cache group"],
  [
    "space",
    "toggle the checkbox of a harness-owned row (or every unit of a group); mark a human-owned row for Open",
  ],
  ["a", "toggle every visible tickable row"],
  [
    "d",
    "mark the row for Delete (human-owned items and kept harness state; Trash, backup or harness command)",
  ],
  ["u", "mark a skill or plugin for Update (only when its origin is known)"],
  [
    "o",
    "open the path in the editor (cursor -g / code -g / $VISUAL / $EDITOR); cmd+click the link where OSC 8 works",
  ],
  ["g", "graph around the current row"],
  ["/", "filter rows by label (esc clears)"],
  ["h", "show / hide settings files"],
  ["p", "projects"],
  ["s", "selection panel (Clean / Delete / Update / Open) → confirm"],
  ["esc", "back"],
  ["?", "this help"],
  ["q", "quit and print the shareable summary"],
];

export function HelpOverlay(): ReactElement {
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold>Keys</Text>
      {KEYS.map(([key, what]) => (
        <Text key={key}>
          <Text color="cyan">{key.padEnd(10)}</Text>
          <Text>{what}</Text>
        </Text>
      ))}
    </Box>
  );
}
