/**
 * The `/init` template fingerprints of §7.8 [D8; D82]. The table ships in the detector, keyed by
 * harness and template, and every phrase is copied verbatim from that harness's published
 * template — **a harness whose template cannot be sourced contributes no phrase**, which is why
 * Cursor is absent: its rule generator is closed and its docs publish only the frontmatter keys
 * (`description` / `globs` / `alwaysApply`), which no hand-written file can be told apart by.
 *
 * Phrases are matched as exact, case-sensitive substrings of the first 600 characters of the raw
 * file text, frontmatter included. They are chosen long and specific enough that a hand-written
 * file does not carry one by accident; headings a human writes all the time (`## Project
 * Overview`, `## Key Files`, `## Usage`) are deliberately left out.
 */
import type { HarnessId } from "../index/types.js";

export interface Fingerprint {
  harness: HarnessId;
  /** How the message and the evidence name the harness, whether or not it is installed here. */
  harnessName: string;
  /** The template, as its harness calls it. */
  template: string;
  phrases: readonly string[];
}

export const FINGERPRINTS: readonly Fingerprint[] = [
  {
    harness: "claude-code",
    harnessName: "Claude Code",
    template: "/init",
    // The line the `/init` prompt tells the model to prefix `CLAUDE.md` with, unchanged across
    // the rewrite of that prompt; hundreds of thousands of public repositories carry it verbatim.
    phrases: [
      "This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.",
    ],
  },
  {
    harness: "gemini-cli",
    harnessName: "Gemini CLI",
    template: "/init",
    // `/init` writes an empty GEMINI.md and mandates these section names in its prompt
    // (`packages/core/src/commands/init.ts`); the headings are the only literal part.
    phrases: ["## Building and Running", "## Development Conventions"],
  },
  {
    harness: "copilot",
    harnessName: "Copilot",
    template: "new-workspace",
    // The HTML comment VS Code writes into a generated `.github/copilot-instructions.md`, quoted
    // without its documentation URL: the sentence is stable, the anchor in the URL is not.
    phrases: ["Use this file to provide workspace-specific custom instructions to Copilot"],
  },
];

/** How much of the raw text a fingerprint may hide in [D82]. */
export const FINGERPRINT_WINDOW = 600;

export interface FingerprintMatch {
  fingerprint: Fingerprint;
  phrase: string;
}

/** Exact, case-sensitive: a template phrase is copied, never paraphrased. */
function carries(head: string, phrase: string): boolean {
  return head.includes(phrase);
}

/** Every phrase of the table present in the first 600 characters, in table order. */
export function matchFingerprints(raw: string): FingerprintMatch[] {
  const head = raw.slice(0, FINGERPRINT_WINDOW);
  const out: FingerprintMatch[] = [];
  for (const fingerprint of FINGERPRINTS)
    for (const phrase of fingerprint.phrases)
      if (carries(head, phrase)) out.push({ fingerprint, phrase });
  return out;
}
