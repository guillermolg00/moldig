import { describe, expect, it } from "vitest";
import type { Origin } from "../index/types.js";
import { updatePreview, UPDATE_PREVIEW_TIMEOUT_MS, type UpdateFetchers } from "./update.js";

const ORIGIN: Origin = {
  installer: "vercel-skills",
  sourceType: "github",
  source: "vercel/skills",
  sourceUrl: "https://github.com/vercel/skills",
  ref: "abc1234",
  skillPath: "skills/agent-browser",
  recordedHash: null,
  installedAt: null,
  updatedAt: null,
  lock: {
    type: "entry",
    file: "/home/.agents/.skill-lock.json",
    format: "json",
    keyPath: ["skills", "agent-browser"],
  },
};

const TREE = JSON.stringify({
  tree: [
    { path: "skills/agent-browser/SKILL.md", type: "blob" },
    { path: "skills/agent-browser/reference.md", type: "blob" },
    { path: "skills/agent-browser", type: "tree" },
    { path: "skills/other/SKILL.md", type: "blob" },
  ],
});

function fetchers(
  answers: Record<string, { status: number; text: string } | null>,
  calls: string[] = [],
): UpdateFetchers {
  return {
    fetchText: (url, options) => {
      expect(options.timeoutMs).toBe(UPDATE_PREVIEW_TIMEOUT_MS);
      calls.push(url);
      return Promise.resolve(answers[url] ?? null);
    },
  };
}

const RAW = "https://raw.githubusercontent.com/vercel/skills/abc1234/skills/agent-browser/SKILL.md";
const TREES = "https://api.github.com/repos/vercel/skills/git/trees/abc1234?recursive=1";

describe("the Update preview (14 §2, D92)", () => {
  it("reads SKILL.md from GitHub raw and the file list from the trees API", async () => {
    const calls: string[] = [];
    const preview = await updatePreview(
      ORIGIN,
      fetchers(
        { [RAW]: { status: 200, text: "# upstream\n" }, [TREES]: { status: 200, text: TREE } },
        calls,
      ),
      { skillMd: "# installed\n", files: ["SKILL.md", "gone.md"] },
    );
    expect(calls).toEqual([RAW, TREES]);
    expect(preview.status).toBe("ready");
    expect(preview.upstream?.skillMd).toBe("# upstream\n");
    expect(preview.upstream?.files).toEqual(["reference.md", "SKILL.md"]);
    expect(preview.changed).toEqual({ added: ["reference.md"], removed: ["gone.md"] });
  });

  it("asks for HEAD when the lock records no ref", async () => {
    const calls: string[] = [];
    await updatePreview({ ...ORIGIN, ref: null }, fetchers({}, calls));
    expect(calls[0]).toContain("/vercel/skills/HEAD/skills/agent-browser/SKILL.md");
    expect(calls[1]).toContain("git/trees/HEAD?recursive=1");
  });

  it("degrades to upstream unreachable on a 404", async () => {
    const preview = await updatePreview(
      ORIGIN,
      fetchers({ [RAW]: { status: 404, text: "Not Found" }, [TREES]: { status: 404, text: "" } }),
    );
    expect(preview).toEqual({
      status: "unreachable",
      reason: "upstream unreachable",
      upstream: null,
      changed: null,
    });
  });

  it("degrades to upstream unreachable when the request times out", async () => {
    const preview = await updatePreview(ORIGIN, fetchers({}));
    expect(preview.status).toBe("unreachable");
    expect(preview.reason).toBe("upstream unreachable");
  });

  it("says so when only part of the upstream answered", async () => {
    const preview = await updatePreview(
      ORIGIN,
      fetchers({ [RAW]: { status: 200, text: "# upstream\n" } }),
    );
    expect(preview.status).toBe("ready");
    expect(preview.reason).toBe("part of the upstream is unreachable");
    expect(preview.upstream?.files).toEqual([]);
  });

  it("shows the command with no preview for any other origin", async () => {
    const calls: string[] = [];
    const preview = await updatePreview({ ...ORIGIN, sourceType: "local" }, fetchers({}, calls));
    expect(preview.status).toBe("unsupported");
    expect(calls).toEqual([]);
  });
});
