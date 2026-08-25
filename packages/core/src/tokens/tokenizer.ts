/**
 * Token counting (research 05): one o200k count per text through `gpt-tokenizer`, and per
 * model-family multipliers consumers apply to it. Falls back to `bytes/4` when the rank table
 * cannot be loaded, which the scan reports as a `tokenizer-fallback` warning.
 */
import { createRequire } from "node:module";
import type { ModelFamily, TokenRange } from "../index/types.js";

export type TokenMethod = "o200k_base" | "bytes/4";

export interface TokenCount {
  o200k: number;
  method: TokenMethod;
}

export interface Tokenizer {
  readonly name: "gpt-tokenizer";
  readonly version: string;
  readonly encoding: "o200k_base";
  /** `true` once any count fell back to `bytes/4`. */
  readonly fallbackUsed: boolean;
  count(text: string): TokenCount;
}

/** Research 05: OpenAI and Gemini ×1; Claude ≤ 4.6 ×1.15 (1–1.25); Claude 4.7+ ×1.5 (1.3–1.65). */
export const MULTIPLIERS: Record<ModelFamily, TokenRange> = {
  openai: { low: 1, mid: 1, high: 1 },
  google: { low: 1, mid: 1, high: 1 },
  "anthropic-46": { low: 1, mid: 1.15, high: 1.25 },
  "anthropic-47plus": { low: 1.3, mid: 1.5, high: 1.65 },
};

const UNIT: TokenRange = { low: 1, mid: 1, high: 1 };

export function multiplierFor(family: ModelFamily | null): TokenRange {
  return family === null ? UNIT : (MULTIPLIERS[family] ?? UNIT);
}

export function applyMultiplier(tokens: number, range: TokenRange): TokenRange {
  return {
    low: Math.round(tokens * range.low),
    mid: Math.round(tokens * range.mid),
    high: Math.round(tokens * range.high),
  };
}

export function addRanges(a: TokenRange, b: TokenRange): TokenRange {
  return { low: a.low + b.low, mid: a.mid + b.mid, high: a.high + b.high };
}

/**
 * Model id → tokenizer family (research 05): Claude 4.7 and later (Opus 4.7/4.8/5, Sonnet 5,
 * Fable 5, Mythos) count ~30 % higher than Sonnet 4.6 and earlier. Bare aliases follow the
 * current defaults; an unknown or redacted id yields `null` (multiplier 1).
 */
export function modelFamilyOf(model: string | null): ModelFamily | null {
  if (model === null) return null;
  const id = model.toLowerCase();
  if (id.startsWith("gpt-") || /^o\d/.test(id) || id.includes("codex")) return "openai";
  if (id.startsWith("gemini")) return "google";
  if (/fable|mythos/.test(id)) return "anthropic-47plus";
  if (/opus-?5|sonnet-?5|opus-?4[-.]?[78]/.test(id)) return "anthropic-47plus";
  if (/haiku/.test(id)) return "anthropic-46";
  if (/claude|opus|sonnet/.test(id)) {
    return /4[-.]?[0-6]\b|3[-.]?\d/.test(id) ? "anthropic-46" : "anthropic-47plus";
  }
  return null;
}

function bytesOver4(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg: unknown = require("gpt-tokenizer/package.json");
    if (typeof pkg === "object" && pkg !== null && "version" in pkg) {
      const version = (pkg as { version?: unknown }).version;
      if (typeof version === "string") return version;
    }
  } catch {
    // The version is informational; the count below does not depend on it.
  }
  return "unknown";
}

/** Loads the o200k encoding once; a load failure yields a tokenizer that counts `bytes/4`. */
export async function loadTokenizer(): Promise<Tokenizer> {
  let countTokens: ((text: string) => number) | null = null;
  try {
    const encoding = await import("gpt-tokenizer/encoding/o200k_base");
    countTokens = (text) => encoding.countTokens(text);
  } catch {
    countTokens = null;
  }
  let fallbackUsed = countTokens === null;
  const counter = countTokens;
  return {
    name: "gpt-tokenizer",
    version: packageVersion(),
    encoding: "o200k_base",
    get fallbackUsed() {
      return fallbackUsed;
    },
    count(text) {
      if (counter !== null) {
        try {
          return { o200k: counter(text), method: "o200k_base" };
        } catch {
          fallbackUsed = true;
        }
      }
      fallbackUsed = true;
      return { o200k: bytesOver4(text), method: "bytes/4" };
    },
  };
}
