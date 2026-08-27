/** The compact global shortcut reference. Any key closes it. */
import { Box, Text } from "ink";
import type { ReactElement } from "react";

export const KEY_MAP: readonly (readonly [string, string])[] = [
  ["↑/↓ · j/k", "navigate"],
  ["PgUp/PgDn", "move by a page; Home/End jump"],
  ["enter", "open or choose the focused row"],
  ["space", "select removable harness state, or toggle a cleanup group"],
  ["a", "select every removable row in the filtered view"],
  ["d", "explicitly mark one human-owned or kept row for Delete"],
  ["u", "mark a skill or plugin for Update when its installer is known"],
  ["o", "open the focused path in your editor"],
  ["/", "filter the current list; esc clears it"],
  ["r", "review finding categories"],
  ["p", "browse projects"],
  ["s", "review the current selection"],
  ["g", "open the graph around the focused row"],
  ["esc", "go back"],
  ["?", "show these shortcuts"],
  ["q", "quit"],
];

export function HelpOverlay(): ReactElement {
  return (
    <Box flexDirection="column">
      <Text>Shortcuts</Text>
      <Box flexDirection="column" paddingTop={1}>
        {KEY_MAP.map(([key, what]) => (
          <Text key={key}>
            <Text color="cyan">{key.padEnd(14)}</Text>
            <Text dimColor>{what}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
