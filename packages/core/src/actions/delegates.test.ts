import { describe, expect, it } from "vitest";
import { parseDelegate } from "./delegates.js";

describe("parseDelegate", () => {
  it.each([
    ["claude mcp remove server-a -s user", ["claude", "mcp", "remove", "server-a", "-s", "user"]],
    ["codex mcp remove server-a", ["codex", "mcp", "remove", "server-a"]],
    [
      "claude plugin uninstall plugin-a@marketplace",
      ["claude", "plugin", "uninstall", "plugin-a@marketplace"],
    ],
    [
      "gemini extensions uninstall extension-a",
      ["gemini", "extensions", "uninstall", "extension-a"],
    ],
    ["opencode session delete ses_123", ["opencode", "session", "delete", "ses_123"]],
  ])("accepts the known adapter-owned command %s", (command, argv) => {
    expect(parseDelegate(command, "/home/test")).toMatchObject({ argv, cwd: "/home/test" });
  });

  it.each([
    "claude mcp remove --all -s user",
    'claude mcp remove "server a" -s user',
    "codex mcp remove server-a --all",
    "gemini extensions uninstall ../extension",
    "opencode session delete ses_123 extra",
    "/tmp/attacker/claude mcp remove server-a -s user",
    "sh -c whoami",
  ])("refuses an unsafe or unknown command shape: %s", (command) => {
    expect(parseDelegate(command, "/home/test")).toBeNull();
  });
});
