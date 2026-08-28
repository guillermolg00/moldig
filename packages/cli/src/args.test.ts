import { describe, expect, it } from "vitest";
import { parseArgs, severityRank } from "./args.js";

function ok(argv: readonly string[]) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) throw new Error(`expected a parse, got: ${parsed.message}`);
  return parsed.options;
}

function fails(argv: readonly string[]): string {
  const parsed = parseArgs(argv);
  if (parsed.ok) throw new Error("expected a usage error");
  return parsed.message;
}

describe("parseArgs", () => {
  it("defaults to the interactive command with no Root", () => {
    expect(ok([])).toMatchObject({ command: "default", roots: [], json: false, git: true });
  });

  it("takes the command from the first positional argument", () => {
    expect(ok(["scan"]).command).toBe("scan");
    expect(ok(["audit", "~/Work"])).toMatchObject({ command: "audit", roots: ["~/Work"] });
    expect(ok(["purge", "~/Work"])).toMatchObject({ command: "purge", roots: ["~/Work"] });
    expect(ok(["update", "~/Work"])).toMatchObject({ command: "update", roots: ["~/Work"] });
    expect(ok(["~/Work"])).toMatchObject({ command: "default", roots: ["~/Work"] });
  });

  it("treats everything after -- as a Root", () => {
    expect(ok(["--", "scan"])).toMatchObject({ command: "default", roots: ["scan"] });
    expect(ok(["scan", "--", "--json"])).toMatchObject({ command: "scan", roots: ["--json"] });
  });

  it("accepts a flag value as the next argument or after =", () => {
    expect(ok(["audit", "--severity", "high"]).severity).toBe("high");
    expect(ok(["audit", "--severity=high"]).severity).toBe("high");
    expect(ok(["audit", "--fail-on=never"]).failOn).toBe("never");
  });

  it("repeats --harness and --category without duplicates", () => {
    expect(
      ok(["scan", "--harness", "codex", "--harness", "codex", "--harness", "cursor"]).harnesses,
    ).toEqual(["codex", "cursor"]);
    expect(ok(["audit", "--category", "bloat", "--category", "orphan"]).categories).toEqual([
      "bloat",
      "orphan",
    ]);
  });

  it("--pretty implies --json (D23)", () => {
    expect(ok(["scan", "--pretty"])).toMatchObject({ json: true, pretty: true });
  });

  it("--no-git and --no-read-signal invert their defaults", () => {
    expect(ok(["scan", "--no-git"]).git).toBe(false);
    expect(ok(["audit", "--no-read-signal"]).readSignal).toBe(false);
  });

  it("rejects an unknown flag, a missing value and a value on a boolean", () => {
    expect(fails(["scan", "--nope"])).toBe("unknown flag --nope");
    expect(fails(["audit", "--severity"])).toBe("--severity needs a value");
    expect(fails(["scan", "--json=yes"])).toBe("--json takes no value");
  });

  it("rejects an unknown Harness id and lists the valid ones (D21)", () => {
    expect(fails(["scan", "--harness", "windsurf"])).toContain("claude-code, codex, cursor");
  });

  it("rejects a flag the command does not take", () => {
    expect(fails(["scan", "--fail-on", "high"])).toBe("--fail-on is not a flag of scan");
    expect(fails(["--yes"])).toContain("not of moldig without a command");
  });

  it("keeps purge and update interactive and aggregate by rejecting document and Harness filters", () => {
    expect(fails(["purge", "--json"])).toBe("--json is not a flag of purge");
    expect(fails(["purge", "--harness", "codex"])).toBe("--harness is not a flag of purge");
    expect(fails(["update", "--json"])).toBe("--json is not a flag of update");
    expect(fails(["update", "--harness", "codex"])).toBe("--harness is not a flag of update");
  });

  it("keeps an unattended clean to harness-cache (D16)", () => {
    expect(ok(["clean", "--category", "harness-cache"]).categories).toEqual(["harness-cache"]);
    expect(fails(["clean", "--category", "bloat"])).toContain("harness-cache only");
  });

  it("reads --older-than as a number of days", () => {
    expect(ok(["clean", "--older-than", "30"]).olderThanDays).toBe(30);
    expect(fails(["clean", "--older-than", "soon"])).toContain("a number of days");
  });

  it("ranks severities low < medium < high (D132)", () => {
    expect(severityRank("low")).toBeLessThan(severityRank("medium"));
    expect(severityRank("medium")).toBeLessThan(severityRank("high"));
  });
});
