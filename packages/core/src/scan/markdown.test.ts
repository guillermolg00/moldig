import { describe, expect, it } from "vitest";
import {
  capPortion,
  findImports,
  findIndexLinks,
  parseFrontmatter,
  stripBlockComments,
} from "./markdown.js";

describe("markdown helpers", () => {
  it("parses the frontmatter shapes harness files use", () => {
    const rule = parseFrontmatter('---\npaths:\n  - "apps/web/**"\n---\nbody\n');
    expect(rule.data).toEqual({ paths: ["apps/web/**"] });
    expect(rule.body).toBe("body\n");
    const nested = parseFrontmatter(
      "---\nname: x\nmetadata:\n  type: project\n  modified: 2026-01-01\ndisable-model-invocation: true\n---\n",
    );
    expect(nested.data).toEqual({
      name: "x",
      metadata: { type: "project", modified: "2026-01-01" },
      "disable-model-invocation": true,
    });
    expect(parseFrontmatter("no frontmatter").present).toBe(false);
  });

  it("finds @imports outside code and strips block comments", () => {
    const text =
      "@docs/notes.md\nuse `@not/an/import.md` here\n```\n@also/not.md\n```\nmail me@example.com\n";
    expect(findImports(text)).toEqual([{ line: 1, target: "docs/notes.md" }]);
    expect(stripBlockComments("a\n<!-- gone -->\nb\n<!--\nmulti\n-->\nc")).toBe("a\nb\nc");
  });

  it("caps a memory index at min(lines, bytes) and finds index links", () => {
    const text = Array.from({ length: 300 }, (_, i) => `- line ${i}`).join("\n") + "\n";
    const portion = capPortion(text, 200, 25_600);
    expect(portion.lines).toBe(200);
    expect(portion.text.endsWith("\n")).toBe(true);
    expect(capPortion("a\nb\n", 200, 25_600).lines).toBe(2);
    expect(capPortion("x".repeat(100), 200, 10).bytes).toBe(10);
    expect(findIndexLinks("- [topic-a.md](topic-a.md): x\n- plain\n* [b](sub/b.md)")).toEqual([
      { line: 1, target: "topic-a.md" },
      { line: 3, target: "sub/b.md" },
    ]);
  });
});
