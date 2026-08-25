// THROWAWAY PROTOTYPE (ticket 09) — the selection model: marks, dispositions, groups,
// and the SIMULATED run. Nothing here touches the filesystem; state lives in memory only.
//
// Rules come from ticket 08: clean's universe is `ownership: harness ∧ protection: none`;
// tickable iff additionally `rule ∈ {swept, undocumented}` (memory files included, never
// ticked by default); preselection comes from the findings' targets; `rule: kept` units and
// human-owned items are reached only through Delete; live rows are never selectable; a
// disposition is decided before anything moves.
import type { AuditIndex, Entity, Flag } from "@moldig/core";
import { basenameOf } from "./format.js";

export type ActionKind = "clean" | "delete" | "update" | "open";
export const ACTION_ORDER: readonly ActionKind[] = ["clean", "delete", "update", "open"];
export const ACTION_TITLE: Readonly<Record<ActionKind, string>> = {
  clean: "Clean",
  delete: "Delete",
  update: "Update",
  open: "Open",
};

export type Badge =
  | "shared"
  | "permanent"
  | "user content"
  | "never read"
  | "live"
  | "sensitive"
  | "secret"
  | "dangling"
  | "invalid"
  | "shadowed"
  | "kept"
  | "size only";

export interface Disposition {
  readonly kind: "trash" | "backup-edit" | "delegate" | "refused" | "update" | "open" | "none";
  readonly text: string; // ticket 08 §4 strings, literally
  readonly permanent: boolean;
  readonly reason: string | null;
}

// Commands whose harness offers no recovery (ticket 08 §3): flagged *permanent* and confirmed
// separately. `claude plugin uninstall` is recoverable by reinstall → not listed.
const PERMANENT_COMMANDS: readonly RegExp[] = [/^opencode session delete/, /^codex mcp remove/];

export function isPermanentCommand(command: string): boolean {
  return PERMANENT_COMMANDS.some((re) => re.test(command));
}

/** v1 classifies by `lstat().dev` against $HOME's (ticket 08 §3); the prototype only knows paths. */
export function refusedReason(entity: Entity): string | null {
  const p = entity.path;
  if (p.startsWith("/Volumes/NAS") || p.startsWith("//") || p.startsWith("\\\\")) {
    return "network volume";
  }
  return null;
}

export function dispositionOf(entity: Entity): Disposition {
  const refused = refusedReason(entity);
  if (refused !== null) {
    return {
      kind: "refused",
      text: `refused: ${refused}`,
      permanent: false,
      reason: `${refused} — no trash available`,
    };
  }
  switch (entity.removal.method) {
    case "trash":
      return { kind: "trash", text: "→ Trash", permanent: false, reason: null };
    case "backup-edit":
      return { kind: "backup-edit", text: "→ backup + edit", permanent: false, reason: null };
    case "delegate": {
      const command = entity.removal.command ?? "<harness command>";
      const permanent = isPermanentCommand(command);
      return {
        kind: "delegate",
        text: permanent ? `→ ${command} (permanent)` : `→ ${command}`,
        permanent,
        reason: null,
      };
    }
    default:
      return { kind: "none", text: "no action", permanent: false, reason: null };
  }
}

export function installerCommand(entity: Entity): string | null {
  if (entity.kind === "skill") {
    return entity.origin?.installer === "vercel-skills" ? `npx skills update ${entity.name}` : null;
  }
  if (entity.kind !== "plugin" || entity.origin === null) return null;
  switch (entity.origin.installer) {
    case "claude-plugin":
      return `claude plugin update ${entity.pluginId}`;
    case "gemini-extension":
      return `gemini extensions update ${entity.pluginId}`;
    default:
      return null;
  }
}

export function updateDisposition(entity: Entity): Disposition | null {
  const command = installerCommand(entity);
  if (command === null) return null;
  const modified = entity.kind === "skill" && entity.drift === "local-modified";
  return {
    kind: "update",
    text: modified ? `→ backup + ${command}` : `→ ${command}`,
    permanent: false,
    reason: null,
  };
}

export const OPEN_DISPOSITION: Disposition = {
  kind: "open",
  text: "→ open in editor",
  permanent: false,
  reason: null,
};

export function isLive(entity: Entity): boolean {
  if (entity.protection === "live") return true;
  return entity.kind === "harness-cache" && entity.liveGuard?.alive === true;
}

export function isSizeOnly(entity: Entity): boolean {
  return entity.protection === "undocumented";
}

/** Clean's universe + the tickable rule (ticket 08). */
export function isTickable(entity: Entity): boolean {
  if (entity.ownership !== "harness" || entity.protection !== "none") return false;
  if (entity.removal.method === "none") return false;
  if (isLive(entity) || refusedReason(entity) !== null) return false;
  if (entity.kind === "harness-cache") {
    return entity.rule === "swept" || entity.rule === "undocumented";
  }
  return entity.kind === "memory-file";
}

/** Delete: one explicit selection at a time, human-owned and `rule: kept` state included. */
export function canDelete(entity: Entity): boolean {
  if (entity.protection !== "none" || entity.removal.method === "none") return false;
  if (isLive(entity) || refusedReason(entity) !== null) return false;
  return true;
}

export function canUpdate(entity: Entity): boolean {
  return updateDisposition(entity) !== null;
}

export function allowed(entity: Entity, action: ActionKind): boolean {
  switch (action) {
    case "clean":
      return isTickable(entity);
    case "delete":
      return canDelete(entity);
    case "update":
      return canUpdate(entity);
    default:
      return true;
  }
}

export function dispositionFor(entity: Entity, action: ActionKind): Disposition {
  if (action === "update") return updateDisposition(entity) ?? OPEN_DISPOSITION;
  if (action === "open") return OPEN_DISPOSITION;
  return dispositionOf(entity);
}

export function badgesOf(entity: Entity): Badge[] {
  const badges: Badge[] = [];
  if (entity.shared === true) badges.push("shared");
  if (isLive(entity)) badges.push("live");
  if (entity.kind === "harness-cache") {
    if (entity.userContent) badges.push("user content");
    if (entity.rule === "kept") badges.push("kept");
  }
  if (entity.kind === "memory-file" && entity.neverRead === true) badges.push("never read");
  if (entity.kind === "skill" && entity.placements.some((p) => p.dangling)) badges.push("dangling");
  if (entity.kind === "mcp-server") {
    if (entity.invalid !== null) badges.push("invalid");
    if (entity.secretKeys.length > 0) badges.push("secret");
  }
  if (dispositionOf(entity).permanent) badges.push("permanent");
  if (isSizeOnly(entity)) badges.push("size only");
  if (entity.sensitive && !badges.includes("secret")) badges.push("sensitive");
  return badges;
}

export function flagBadge(flag: Flag): Badge | null {
  switch (flag) {
    case "shared":
      return "shared";
    case "sensitive":
      return "sensitive";
    case "secret-exposed":
      return "secret";
    case "live":
      return "live";
    case "user-content":
      return "user content";
    default:
      return null;
  }
}

/** Tokens per session the entity costs, per harness id ("harness:claude-code" → tokens). */
export function tokensPerHarness(index: AuditIndex, entityId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const edge of index.edges) {
    if (edge.kind !== "loaded-by" || edge.from !== entityId) continue;
    const e = edge;
    if (!e.countsTowardHeadline || e.tokensLoaded === null) continue;
    out[e.to] = Math.max(out[e.to] ?? 0, e.tokensLoaded);
  }
  return out;
}

export function addTokens(
  into: Record<string, number>,
  more: Readonly<Record<string, number>>,
): Record<string, number> {
  for (const [harness, tokens] of Object.entries(more)) {
    into[harness] = (into[harness] ?? 0) + tokens;
  }
  return into;
}

export function entityById(index: AuditIndex, id: string): Entity | undefined {
  return index.entities.find((e) => e.id === id);
}

/** Preselection (ADR-0004): only what a `clean` finding marks `preselect: true`. */
export function initialMarks(index: AuditIndex): Map<string, ActionKind> {
  const marks = new Map<string, ActionKind>();
  for (const finding of index.findings) {
    if (finding.action.kind !== "clean") continue;
    for (const target of finding.targets) {
      if (!target.id) continue;
      const preselect =
        target.preselect ?? (finding.targets.length === 1 && finding.action.preselect);
      if (!preselect) continue;
      const entity = entityById(index, target.id);
      if (entity && isTickable(entity) && entity.kind !== "memory-file")
        marks.set(target.id, "clean");
    }
  }
  return marks;
}

export interface SelectionRow {
  readonly entity: Entity;
  readonly action: ActionKind;
  readonly disposition: Disposition;
  readonly badges: readonly Badge[];
  readonly bytes: number;
  readonly tokens: Readonly<Record<string, number>>;
}

export interface SelectionGroup {
  readonly action: ActionKind;
  readonly title: string;
  readonly rows: readonly SelectionRow[];
  readonly bytes: number;
  readonly tokens: Readonly<Record<string, number>>;
  readonly sharedCount: number;
  readonly extraConfirm: string | null; // groups with user content or permanent rows
}

export function groupSelection(
  index: AuditIndex,
  marks: ReadonlyMap<string, ActionKind>,
): SelectionGroup[] {
  const groups: SelectionGroup[] = [];
  for (const action of ACTION_ORDER) {
    const rows: SelectionRow[] = [];
    for (const [id, marked] of marks) {
      if (marked !== action) continue;
      const entity = entityById(index, id);
      if (!entity) continue;
      rows.push({
        entity,
        action,
        disposition: dispositionFor(entity, action),
        badges: badgesOf(entity),
        bytes: action === "clean" || action === "delete" ? entity.metrics.bytes : 0,
        tokens: action === "open" || action === "update" ? {} : tokensPerHarness(index, id),
      });
    }
    if (rows.length === 0) continue;
    rows.sort((a, b) => b.bytes - a.bytes || a.entity.label.localeCompare(b.entity.label));
    const tokens: Record<string, number> = {};
    for (const row of rows) addTokens(tokens, row.tokens);
    const userContent = rows.some((r) => r.badges.includes("user content"));
    const permanent = rows.some((r) => r.disposition.permanent);
    const reasons = [
      userContent ? "user content" : null,
      permanent ? "permanent rows" : null,
    ].filter((r): r is string => r !== null);
    groups.push({
      action,
      title: ACTION_TITLE[action],
      rows,
      bytes: rows.reduce((acc, r) => acc + r.bytes, 0),
      tokens,
      sharedCount: rows.filter((r) => r.badges.includes("shared")).length,
      extraConfirm: reasons.length > 0 ? reasons.join(" and ") : null,
    });
  }
  return groups;
}

// ---------- the simulated run ----------
export type RowResult = "moved" | "edited" | "delegated" | "refused" | "failed";

export interface RunRow {
  readonly row: SelectionRow;
  readonly result: RowResult;
  readonly reason: string | null;
  readonly backupPath: string | null;
}

export interface RunGroup {
  readonly action: ActionKind;
  readonly title: string;
  readonly skipped: boolean;
  readonly rows: readonly RunRow[];
}

export interface RunSummary {
  readonly runId: string;
  readonly manifestPath: string;
  readonly groups: readonly RunGroup[];
}

/** moldig's data directory (ticket 08 §3): never inside a repository. */
export function dataDir(
  home: string,
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  if (platform === "win32") return `${env["LOCALAPPDATA"] ?? `${home}\\AppData\\Local`}\\moldig`;
  return `${env["XDG_DATA_HOME"] ?? `${home}/.local/share`}/moldig`;
}

function joinFor(platform: string, ...parts: string[]): string {
  return parts.join(platform === "win32" ? "\\" : "/");
}

export function encodePath(p: string): string {
  return p.replaceAll(/[\\/:<>]/g, "%");
}

// One made-up failure so the screens show that a failed target never aborts the run.
const SIMULATED_FAILURE = /snapshot-b/;

export function simulateGroup(
  group: SelectionGroup,
  runId: string,
  home: string,
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): RunGroup {
  const backups = joinFor(platform, dataDir(home, platform, env), "backups", runId);
  const rows = group.rows.map((row): RunRow => {
    if (row.disposition.kind === "refused") {
      return { row, result: "refused", reason: row.disposition.reason, backupPath: null };
    }
    if (SIMULATED_FAILURE.test(row.entity.path)) {
      return {
        row,
        result: "failed",
        reason: `EPERM: operation not permitted, rename ${basenameOf(row.entity.path, platform)} (simulated)`,
        backupPath: null,
      };
    }
    switch (row.disposition.kind) {
      case "delegate":
        return { row, result: "delegated", reason: null, backupPath: null };
      case "backup-edit":
        return {
          row,
          result: "edited",
          reason: null,
          backupPath: joinFor(platform, backups, encodePath(row.entity.path)),
        };
      case "update": {
        const modified = row.entity.kind === "skill" && row.entity.drift === "local-modified";
        return {
          row,
          result: "delegated",
          reason: null,
          backupPath: modified ? joinFor(platform, backups, encodePath(row.entity.path)) : null,
        };
      }
      default:
        return { row, result: "moved", reason: null, backupPath: null };
    }
  });
  return { action: group.action, title: group.title, skipped: false, rows };
}

export function skippedGroup(group: SelectionGroup): RunGroup {
  return { action: group.action, title: group.title, skipped: true, rows: [] };
}

export function manifestPath(
  runId: string,
  home: string,
  platform: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return joinFor(platform, dataDir(home, platform, env), "runs", `${runId}.json`);
}

export function runTotals(run: RunSummary): {
  freedBytes: number;
  tokens: Record<string, number>;
  counts: Record<RowResult, number>;
  backups: string[];
} {
  const counts: Record<RowResult, number> = {
    moved: 0,
    edited: 0,
    delegated: 0,
    refused: 0,
    failed: 0,
  };
  const tokens: Record<string, number> = {};
  const backups: string[] = [];
  let freedBytes = 0;
  for (const group of run.groups) {
    for (const r of group.rows) {
      counts[r.result] += 1;
      if (r.backupPath) backups.push(r.backupPath);
      if (r.result === "moved" || r.result === "edited" || r.result === "delegated") {
        if (group.action === "clean" || group.action === "delete") {
          freedBytes += r.row.bytes;
          addTokens(tokens, r.row.tokens);
        }
      }
    }
  }
  return { freedBytes, tokens, counts, backups };
}
