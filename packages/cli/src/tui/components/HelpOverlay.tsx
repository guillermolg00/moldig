/** The compact global shortcut reference. Any key closes it. */
import { Box, Text } from "ink";
import type { ReactElement } from "react";
import { useStore } from "../lib/store.js";

export const KEY_MAP: readonly (readonly [string, string])[] = [
  ["↑/↓ · j/k", "navigate"],
  ["PgUp/PgDn", "move by a page; Home/End jump"],
  ["enter", "open or choose the focused row"],
  ["space", "toggle removable state, a cleanup group or one missing Project"],
  ["a", "select every removable row or missing Project in this view"],
  ["d", "explicitly mark one human-owned or kept row for Delete"],
  ["u", "Update the focused item; from Inventory, open Update all"],
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

const PROJECT_CLEAN_KEY_MAP: readonly (readonly [string, string])[] = [
  ["↑/↓", "inspect a cleanup group or item"],
  ["←/→", "hide or show the paths inside a group"],
  ["space", "exclude or restore the focused group or item"],
  ["enter", "move the selected cache to the OS Trash"],
  ["tab", "see findings and the rest of the inventory"],
  ["esc / q", "cancel and quit without moving anything"],
];

export function HelpOverlay(): ReactElement {
  const { route } = useStore();
  const keys = route.screen === "clean-plan" ? PROJECT_CLEAN_KEY_MAP : KEY_MAP;
  return (
    <Box flexDirection="column">
      <Text>Shortcuts</Text>
      <Box flexDirection="column" paddingTop={1}>
        {keys.map(([key, what]) => (
          <Text key={key}>
            <Text color="cyan">{key.padEnd(14)}</Text>
            <Text dimColor>{what}</Text>
          </Text>
        ))}
      </Box>
    </Box>
  );
}
