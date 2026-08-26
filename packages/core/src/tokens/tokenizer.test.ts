import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { isRecord } from "../scan/fs.js";
import {
  applyMultiplier,
  loadTokenizer,
  modelFamilyOf,
  MULTIPLIERS,
  TOKENIZER_VERSION,
} from "./tokenizer.js";

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

describe("the version the index reports", () => {
  it("matches the pin in the package manifest, so a bundle never invents one", async () => {
    const manifest = new URL("../../package.json", import.meta.url);
    const pkg: unknown = JSON.parse(await readFile(manifest, "utf8"));
    const pinned =
      isRecord(pkg) && isRecord(pkg["dependencies"]) ? pkg["dependencies"]["gpt-tokenizer"] : null;
    expect(pinned).toBe(TOKENIZER_VERSION);
  });
});
