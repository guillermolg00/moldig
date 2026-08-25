import { describe, expect, it } from "vitest";
import { applyMultiplier, loadTokenizer, modelFamilyOf, MULTIPLIERS } from "./tokenizer.js";

describe("tokenizer", () => {
  it("counts with o200k_base and reports gpt-tokenizer's version", async () => {
    const tokenizer = await loadTokenizer();
    expect(tokenizer.count("hello world").method).toBe("o200k_base");
    expect(tokenizer.count("hello world").o200k).toBe(2);
    expect(tokenizer.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(tokenizer.fallbackUsed).toBe(false);
  });

  it("maps model ids to tokenizer families (research 05) and applies the ranges", () => {
    expect(modelFamilyOf("claude-opus-4-7")).toBe("anthropic-47plus");
    expect(modelFamilyOf("claude-sonnet-4-6")).toBe("anthropic-46");
    expect(modelFamilyOf("claude-haiku-4-5")).toBe("anthropic-46");
    expect(modelFamilyOf("fable")).toBe("anthropic-47plus");
    expect(modelFamilyOf("gpt-5.4")).toBe("openai");
    expect(modelFamilyOf("gemini-2.5-pro")).toBe("google");
    expect(modelFamilyOf("<redacted>")).toBeNull();
    expect(modelFamilyOf(null)).toBeNull();
    expect(applyMultiplier(1000, MULTIPLIERS["anthropic-47plus"])).toEqual({
      low: 1300,
      mid: 1500,
      high: 1650,
    });
  });
});
