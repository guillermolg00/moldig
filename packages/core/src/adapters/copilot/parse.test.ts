import { describe, expect, it } from "vitest";
import { parseFlatYaml, parseJsoncObject, stripJsonc } from "./parse.js";

const SESSION_KEYS = ["id", "cwd", "git_root", "created_at", "updated_at"];

describe("the flat workspace.yaml reader", () => {
  it("returns the allowlisted keys and drops every other value", () => {
    const parsed = parseFlatYaml(
      [
        "id: 00000000-0000-4000-8000-000000000001",
        "cwd: /Users/x/work/project-a",
        "git_root: /Users/x/work/project-a",
        "repository: private/thing",
        "branch: feature/secret-name",
        "summary: what the user asked for",
        "summary_count: 2",
        "created_at: 2026-01-15T12:00:00.000Z",
        "updated_at: 2026-01-15T12:00:00.000Z",
        "",
      ].join("\n"),
      SESSION_KEYS,
    );
    expect(parsed.data).toEqual({
      id: "00000000-0000-4000-8000-000000000001",
      cwd: "/Users/x/work/project-a",
      git_root: "/Users/x/work/project-a",
      created_at: "2026-01-15T12:00:00.000Z",
      updated_at: "2026-01-15T12:00:00.000Z",
    });
    // The conversation and identity keys never leave the reader at all.
    expect(Object.keys(parsed.data)).not.toContain("summary");
    expect(parsed.unsupported).toBe(false);
    expect(parsed.empty).toBe(false);
  });

  it("unquotes a value, ignores comments and document markers", () => {
    const parsed = parseFlatYaml(
      ["---", "# a comment", 'cwd: "/Users/x/a b"', "...", ""].join("\n"),
      SESSION_KEYS,
    );
    expect(parsed.data["cwd"]).toBe("/Users/x/a b");
    expect(parsed.unsupported).toBe(false);
  });

  it("reports a shape richer than flat key/value instead of guessing at it", () => {
    for (const text of [
      "cwd: /a\nworkspace:\n  folders:\n    - /a\n",
      "cwd: /a\nnotes: |\n  a block scalar\n",
      "cwd: /a\n- a list item at the root\n",
      "anchor: &ref\n",
    ]) {
      expect(parseFlatYaml(text, SESSION_KEYS).unsupported).toBe(true);
    }
    // The keys it *can* read are still read: the warning is `skipped`, not `parse-error`.
    expect(parseFlatYaml("cwd: /a\nnotes: |\n  block\n", SESSION_KEYS).data["cwd"]).toBe("/a");
    expect(parseFlatYaml("", SESSION_KEYS).empty).toBe(true);
    expect(parseFlatYaml("not yaml at all\n", SESSION_KEYS)).toMatchObject({
      unsupported: true,
      empty: true,
    });
  });
});

describe("the JSONC reader VS Code's settings need", () => {
  it("strips comments and trailing commas without touching string literals", () => {
    const text = `{
      // a line comment
      "chat.useAgentsMdFile": true, /* a block comment */
      "path": "https://example.com/a//b", // not a comment
      "glob": "/* not a comment either */",
      "chat.instructionsFilesLocations": { ".github/instructions": true, },
    }`;
    expect(parseJsoncObject(text)).toEqual({
      "chat.useAgentsMdFile": true,
      path: "https://example.com/a//b",
      glob: "/* not a comment either */",
      "chat.instructionsFilesLocations": { ".github/instructions": true },
    });
  });

  it("keeps an escaped quote inside a string", () => {
    expect(stripJsonc('{"a": "say \\" // no"}')).toBe('{"a": "say \\" // no"}');
    expect(parseJsoncObject('{"a": "say \\" // no"}')).toEqual({ a: 'say " // no' });
  });

  it("returns null for a document that is not an object", () => {
    expect(parseJsoncObject("[1, 2]")).toBeNull();
    expect(parseJsoncObject("{ not json")).toBeNull();
  });
});
