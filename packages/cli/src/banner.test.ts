import { describe, expect, it } from "vitest";
import { banner } from "./banner.js";

describe("banner", () => {
  it("names every harness of v1", () => {
    const text = banner();
    for (const id of ["claude-code", "codex", "cursor", "gemini-cli", "copilot", "opencode"]) {
      expect(text).toContain(id);
    }
  });
});
