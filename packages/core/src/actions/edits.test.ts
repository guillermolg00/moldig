import { describe, expect, it } from "vitest";
import { removeJsonEntry, rewriteMemoryIndex } from "./edits.js";

/** The three hook shapes ticket 08 §2 names, plus what must survive byte for byte. */
const INDEX = `# Memory

Some prose about the project.

- [topic-a.md](topic-a.md) — the hook shape with an em dash
- [topic-b.md](./topic-b.md): the hook shape with a colon
- [topic-c.md](notes/topic-c.md)
- a plain item with no link at all
- [keep-me.md](keep-me.md) — another fact that stays

\`\`\`md
- [topic-a.md](topic-a.md) — inside a code fence: never touched
\`\`\`

## Tail

1. [topic-a.md](topic-a.md) — an ordered item counts as a list item
`;

describe("the MEMORY.md rewrite (08 §2)", () => {
  it("drops the em-dash hook and writes every other byte back unchanged", () => {
    const out = rewriteMemoryIndex(INDEX, "topic-a.md");
    expect(out).not.toBeNull();
    const dropped = new Set([
      "- [topic-a.md](topic-a.md) — the hook shape with an em dash",
      "1. [topic-a.md](topic-a.md) — an ordered item counts as a list item",
    ]);
    expect(out).toBe(
      INDEX.split("\n")
        .filter((line) => !dropped.has(line))
        .join("\n"),
    );
    expect(out).toContain("- [topic-a.md](topic-a.md) — inside a code fence: never touched");
    expect(out).toContain("- a plain item with no link at all");
    expect(out).toContain("- [keep-me.md](keep-me.md)");
  });

  it("drops the colon hook and the hookless item, matching on the basename", () => {
    expect(rewriteMemoryIndex(INDEX, "topic-b.md")).not.toContain("topic-b");
    const withoutC = rewriteMemoryIndex(INDEX, "topic-c.md");
    expect(withoutC).not.toBeNull();
    expect(withoutC).not.toContain("topic-c");
    expect(withoutC?.split("\n")).toHaveLength(INDEX.split("\n").length - 1);
  });

  it("writes nothing when no line matched", () => {
    expect(rewriteMemoryIndex(INDEX, "never-listed.md")).toBeNull();
    expect(rewriteMemoryIndex("- plain text only\n", "topic-a.md")).toBeNull();
  });

  it("keeps CRLF, the trailing newline and a file that ends without one", () => {
    const crlf = "- [a.md](a.md) — one\r\n- [b.md](b.md) — two\r\n";
    expect(rewriteMemoryIndex(crlf, "a.md")).toBe("- [b.md](b.md) — two\r\n");
    const noNewline = "- [a.md](a.md)\n- [b.md](b.md)";
    expect(rewriteMemoryIndex(noNewline, "b.md")).toBe("- [a.md](a.md)\n");
  });

  it("only the first link of a line decides", () => {
    const line = "- [keep.md](keep.md) — see also [topic-a.md](topic-a.md)\n";
    expect(rewriteMemoryIndex(line, "topic-a.md")).toBeNull();
    expect(rewriteMemoryIndex(line, "keep.md")).toBe("");
  });
});

const JSONC = `{
  // the servers this project shares
  "mcpServers": {
    /* the one that stays */
    "server-stdio": { "command": "node", "args": ["server.js"] },
    "server-http": { "type": "http", "url": "https://example.test/mcp" },
    "server-sse": { "type": "sse", "url": "https://example.test/sse" },
  },
  "other": true
}
`;

describe("removing an Entry from a JSON / JSONC settings file (14 §1)", () => {
  it("preserves comments, key order and the entries around it byte for byte", () => {
    const out = removeJsonEntry(JSONC, ["mcpServers", "server-http"]);
    expect(out).not.toBeNull();
    expect(out).toContain("// the servers this project shares");
    expect(out).toContain("/* the one that stays */");
    expect(out).not.toContain("server-http");
    const keys = [...(out ?? "").matchAll(/"(server-[a-z]+)"/gu)].map((match) => match[1]);
    expect(keys).toEqual(["server-stdio", "server-sse"]);
    expect(out).toContain('"other": true');
    // The trailing comma of the last entry and the one-line entries are left as they were.
    expect(out).toContain('"server-stdio": { "command": "node", "args": ["server.js"] },');
    expect(out).toContain('"url": "https://example.test/sse" },\n  },');
    expect(out).toBe(
      JSONC.split("\n")
        .filter((line) => !line.includes("server-http"))
        .join("\n"),
    );
  });

  it("keeps the layout when the first entry of an object goes", () => {
    const out = removeJsonEntry(JSONC, ["mcpServers", "server-stdio"]);
    expect(out).toContain('"mcpServers": {\n    "server-http"');
    expect(out).not.toContain("server-stdio");
  });

  it("reaches a nested key path and leaves the rest alone", () => {
    const text = `{\n  "projects": {\n    "/repo": { "mcpServers": { "a": 1, "b": 2 } }\n  }\n}\n`;
    const out = removeJsonEntry(text, ["projects", "/repo", "mcpServers", "a"]);
    expect(out).toContain('"b": 2');
    expect(out).not.toContain('"a": 1');
  });

  it("answers null when the entry is not there", () => {
    expect(removeJsonEntry(JSONC, ["mcpServers", "absent"])).toBeNull();
    expect(removeJsonEntry("not json at all", ["mcpServers", "a"])).toBeNull();
  });

  it("keeps the file's own indentation", () => {
    const tabbed = `{\n\t"mcpServers": {\n\t\t"a": {},\n\t\t"b": {}\n\t}\n}\n`;
    const out = removeJsonEntry(tabbed, ["mcpServers", "a"]);
    expect(out).toContain("\t\t");
    expect(out).not.toContain('"a"');
  });
});
