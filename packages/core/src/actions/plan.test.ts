import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuditIndex, Entity, HarnessCache } from "../index/types.js";
import { audit, scan } from "../index.js";
import { loadFixture, normaliseSnapshot, type FixtureTree } from "../testing/index.js";
import { dataDirFor, encodePath } from "./data-dir.js";
import { plan } from "./plan.js";
import { selectionFrom } from "./selection.js";
import type { Device, Plan, PlanEnv, PlanRow, Selection } from "./types.js";

/** Same clock as the adapter test: after the fixture's synthetic timestamps. */
const NOW = new Date("2026-08-26T12:00:00.000Z");
const PLATFORM = "darwin";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

let tree: FixtureTree;
let index: AuditIndex;
let env: PlanEnv;

const id = (kind: string, path: string): string => {
  const hash = path.indexOf("#");
  const file = hash === -1 ? path : path.slice(0, hash);
  const keyPath = hash === -1 ? "" : path.slice(hash);
  return `${kind}:${file.toLowerCase()}${keyPath}`;
};
const home = (rel: string): string => `${tree.home}/${rel}`;
const root = (rel: string): string => `${tree.root}/${rel}`;
const slug = (rel: string): string =>
  `${tree.home}/.claude/projects/${tree.slug(tree.root)}-${rel}`;

/**
 * The volume classification is injected, so a network mount is testable without one (15
 * Answer): the shell snapshot sits on a network volume, the legacy todo on a second local
 * disk, the agent definition on a read-only mount, everything else on the home volume.
 */
function deviceOf(path: string): Device {
  // The host's separator reaches this double on Windows, where the real probe would see `\`.
  const where = path.replaceAll("\\", "/");
  if (where.includes("/.claude/shell-snapshots/")) return { dev: 77, kind: "network" };
  if (where.includes("/.claude/todos/")) return { dev: 42, kind: "local" };
  if (where.includes("/.claude/agents/")) return { dev: 88, kind: "read-only" };
  return { dev: 1, kind: "local" };
}

/** A running session: no fixture can carry a live PID, so the row is added to the index here. */
const LIVE_ID = "harness-cache:live-session";

function withLiveUnit(audited: AuditIndex): AuditIndex {
  const anchor = audited.entities.find(
    (entity): entity is HarnessCache =>
      entity.kind === "harness-cache" && entity.cacheKind === "transcript",
  );
  if (anchor === undefined) throw new Error("no transcript unit in the fixture");
  const live: Entity = {
    ...anchor,
    id: LIVE_ID,
    label: "session a harness is using right now",
    liveGuard: { kind: "pid", alive: true },
  };
  return { ...audited, entities: [...audited.entities, live] };
}

function render(document: Plan): string[] {
  const lines = [
    `run ${document.runId} · command ${document.command} · moldig ${document.moldig.version}`,
    `data dir ${document.dataDir}`,
    `backups ${document.backupDir}`,
    `manifest ${document.manifestPath}`,
  ];
  for (const group of document.groups) {
    lines.push(
      "",
      `${group.title} (${group.count}) · ${group.bytes} bytes · tokens/session ${JSON.stringify(group.tokensPerSession)} · shared ${group.shared}`,
    );
    for (const warning of group.warnings) lines.push(`  ${warning}`);
    if (group.extraConfirmation.required) {
      lines.push(`  extra confirmation: ${group.extraConfirmation.reason}`);
    }
    for (const row of group.rows) lines.push(...renderRow(row));
  }
  return lines;
}

function renderRow(row: PlanRow): string[] {
  const lines = [
    `  ${row.disposition.display}`,
    `    row ${row.key}`,
    `    ${row.target.kind} · ${row.target.harness ?? "no harness"} · volume ${row.volume ?? "—"} · ${row.bytes} bytes`,
    `    disposition ${row.disposition.kind}${row.disposition.permanent ? " · permanent" : ""}${row.disposition.runnable ? "" : " · not runnable"}`,
  ];
  if (row.disposition.reason !== null) lines.push(`    reason ${row.disposition.reason}`);
  if (row.disposition.argv !== null) {
    lines.push(`    argv ${JSON.stringify(row.disposition.argv)} in ${row.disposition.cwd ?? "—"}`);
  }
  for (const path of row.paths) lines.push(`    trash ${path}`);
  for (const backup of row.backups) {
    lines.push(`    backup ${backup.path}${backup.recursive ? " (recursive)" : ""} → ${backup.to}`);
  }
  for (const edit of row.edits) {
    lines.push(
      edit.kind === "json-entry"
        ? `    edit ${edit.file} # ${edit.keyPath.join(" / ")}`
        : `    edit ${edit.file} # drop the lines listing ${edit.fact}`,
    );
  }
  if (Object.keys(row.tokensPerSession).length > 0) {
    lines.push(`    tokens/session ${JSON.stringify(row.tokensPerSession)}`);
  }
  if (row.flags.length > 0) lines.push(`    flags ${row.flags.join(" · ")}`);
  if (row.badges.length > 0) lines.push(`    badges ${row.badges.join(" · ")}`);
  return lines;
}

/** A backup name percent-encodes the whole original path (D90), temp directory included. */
function stableBackups(text: string): string {
  return `${text
    .replaceAll(encodePath(tree.home), "<HOME-ENCODED>")
    .replaceAll(encodePath(tree.root), "<ROOT-ENCODED>")}\n`;
}

beforeAll(async () => {
  tree = await loadFixture("claude-code/breadcrumbs", {
    cwd: "root/project-a",
    now: NOW,
    platform: PLATFORM,
  });
  const scanned = await scan({
    home: tree.home,
    roots: tree.roots,
    cwd: tree.cwd,
    platform: PLATFORM,
    env: tree.env,
    git: false,
    now: NOW,
  });
  index = withLiveUnit(await audit(scanned));
  env = {
    home: tree.home,
    platform: PLATFORM,
    dataDir: dataDirFor({ platform: PLATFORM, env: {}, home: tree.home }),
    now: NOW,
    moldig: { version: "0.0.0" },
    command: "clean",
    deviceOf,
  };
});

afterAll(async () => {
  await tree.cleanup();
});

/** Clean's preselected marks plus one target per row of the Delete table (14 §1). */
function everySelection(): Selection {
  return [
    ...selectionFrom(index),
    { action: "clean", id: id("memory-file", slug("project-a/memory/MEMORY.md")) },
    { action: "clean", id: id("memory-file", slug("project-a/memory/topic-a.md")) },
    { action: "clean", id: id("harness-cache", home(".claude/history.jsonl")) },
    { action: "clean", id: LIVE_ID },
    {
      action: "clean",
      locator: {
        type: "dir",
        path: `${tree.home}/.claude/projects/${tree.slug(tree.root)}-gone/memory`,
      },
      label: "memory unit of the gone project",
    },
    {
      action: "delete",
      id: id("mcp-server", `${root("project-a/.mcp.json")}#mcpServers/server-http`),
    },
    { action: "delete", id: id("mcp-server", `${home(".claude.json")}#mcpServers/server-stdio`) },
    {
      action: "delete",
      id: id(
        "mcp-server",
        `${home(".claude.json")}#projects/${root("project-a")}/mcpServers/server-http`,
      ),
    },
    {
      action: "delete",
      id: id(
        "mcp-server",
        `${home(".claude.json")}#projects/${root("gone")}/mcpServers/server-stdio`,
      ),
    },
    { action: "delete", id: id("settings-file", root("project-a/.mcp.json")) },
    { action: "delete", id: id("context-file", root("project-a/CLAUDE.md")) },
    { action: "delete", id: id("agent-definition", root("project-a/.claude/agents/reviewer.md")) },
    { action: "delete", id: id("harness-cache", home(".claude/history.jsonl")) },
    {
      action: "delete",
      locator: {
        type: "entry",
        file: root("project-b/skills-lock.json"),
        format: "json",
        keyPath: ["skills", "skill-missing"],
      },
      label: "skill-missing (lock entry)",
    },
    { action: "update", id: id("skill", root("project-a/.claude/commands/x.md")) },
    { action: "open", id: id("context-file", home(".claude/CLAUDE.md")) },
  ];
}

describe("plan() over the breadcrumbs case", () => {
  it("preselects exactly what the audit marked", () => {
    const selection = selectionFrom(index);
    expect(selection.map((target) => target.id)).toEqual([
      id("harness-cache", slug(`project-a-apps-web/${SESSION_B}.jsonl`)),
      id("harness-cache", home(".claude/shell-snapshots/snapshot-zsh-1700000000000-synth1.sh")),
      id(
        "harness-cache",
        home(
          ".claude/todos/11111111-1111-4111-8111-111111111111-agent-11111111-1111-4111-8111-111111111111.json",
        ),
      ),
    ]);
    expect(selection.every((target) => target.finding !== undefined)).toBe(true);
    expect(selectionFrom(index, { olderThanDays: 100 })).toEqual([]);
    expect(selectionFrom(index, { harnesses: ["codex"] })).toEqual([]);
  });

  it("groups Clean → Delete → Update → Open and decides every disposition", async () => {
    const document = plan(index, everySelection(), env);
    expect(document.groups.map((group) => group.action)).toEqual([
      "clean",
      "delete",
      "update",
      "open",
    ]);
    await expect(
      stableBackups(normaliseSnapshot(render(document), tree).join("\n")),
    ).toMatchFileSnapshot("./__snapshots__/breadcrumbs.plan.txt");
  });

  it("never makes a refused volume, a Live row or a protected row actionable", () => {
    const document = plan(index, everySelection(), env);
    const rows = document.groups.flatMap((group) => group.rows);
    const refused = (key: string): PlanRow => {
      const row = rows.find((item) => item.key.includes(key));
      if (row === undefined) throw new Error(`no row for ${key}`);
      return row;
    };
    expect(refused("shell-snapshots").disposition).toMatchObject({
      kind: "refused",
      display: "refused: network volume",
      reason: "network volume — no trash available",
    });
    expect(refused(LIVE_ID).disposition.reason).toBe("live — a harness is using it right now");
    expect(refused("agents/reviewer.md").disposition.reason).toBe(
      "read-only volume — nothing can be moved",
    );
    // D142: a settings file is never deletable; its entries are.
    expect(refused(id("settings-file", root("project-a/.mcp.json"))).disposition.reason).toBe(
      "protected — moldig never removes this file",
    );
    // D111: a kept unit is Delete only, never part of a Clean group.
    expect(refused("history.jsonl").disposition.kind).toBe("refused");
    expect(refused("history.jsonl").disposition.reason).toContain("kept");
    // D95: a local-scope entry whose Project directory is gone stays undeletable.
    expect(
      refused(`#projects/${root("gone")}/mcpServers/server-stdio`).disposition.reason,
    ).toContain("the project directory this entry is keyed by is gone");
    for (const row of rows) {
      if (row.disposition.kind !== "refused") continue;
      expect(row.paths).toEqual([]);
      expect(row.backups).toEqual([]);
      expect(row.edits).toEqual([]);
    }
  });

  it("carries argv and a working directory for every delegate, never a shell (D87)", () => {
    const document = plan(index, everySelection(), env);
    const rows = document.groups.flatMap((group) => group.rows);
    const user = rows.find(
      (row) => row.key === id("mcp-server", `${home(".claude.json")}#mcpServers/server-stdio`),
    );
    expect(user?.disposition.argv).toEqual([
      "claude",
      "mcp",
      "remove",
      "server-stdio",
      "-s",
      "user",
    ]);
    expect(user?.disposition.cwd).toBe(tree.home);
    const local = rows.find(
      (row) =>
        row.key ===
        id(
          "mcp-server",
          `${home(".claude.json")}#projects/${root("project-a")}/mcpServers/server-http`,
        ),
    );
    expect(local?.disposition.argv).toEqual([
      "claude",
      "mcp",
      "remove",
      "server-http",
      "-s",
      "local",
    ]);
    expect(local?.disposition.cwd).toBe(root("project-a"));
    expect(local?.disposition.command).toContain("cd ");
    for (const row of rows) {
      for (const argument of row.disposition.argv ?? []) {
        expect(argument).not.toContain("&&");
      }
    }
  });
});
