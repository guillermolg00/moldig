/**
 * The selection model shared by every screen: marks, predicates, dispositions, badges and the
 * Clean → Delete → Update → Open groups.
 *
 * Rules come from ticket 08: Clean's universe is `ownership: harness ∧ protection: none`;
 * tickable iff additionally `rule ∈ {swept, undocumented}` (memory files included, never ticked
 * by default); preselection comes from the findings' targets; `rule: kept` units and
 * human-owned items are reached only through Delete; live rows are never selectable; a
 * disposition is decided before anything moves.
 *
 * The TUI never classifies volumes. Whether a target sits on a network, read-only or
 * unclassifiable volume is the actions engine's call, injected here as `Refusal`.
 */
import type { AuditIndex, Badge as CoreBadge, Entity, Flag } from "@moldig/core";

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
  | "size only"
  | "locally modified";

export interface Disposition {
  readonly kind: "trash" | "backup-edit" | "delegate" | "refused" | "update" | "open" | "none";
  /** Ticket 08 §4's strings, literally. */
  readonly text: string;
  readonly permanent: boolean;
  readonly reason: string | null;
}

/**
 * The actions engine's per-entity verdict on the volume the target sits on: D89's verbatim
 * reason (`"network volume — no trash available"`) or `null`. `refusalFor` is the real one.
 */
export type Refusal = (entity: Entity) => string | null;
export const noRefusal: Refusal = () => null;

/**
 * D60: `opencode session delete` is the only command whose harness offers no way back. A
 * `codex mcp remove` is preceded by a backup of `config.toml`, so it is recoverable.
 */
const PERMANENT_COMMANDS: readonly RegExp[] = [/^opencode session delete/u];

export function isPermanentCommand(command: string): boolean {
  return PERMANENT_COMMANDS.some((pattern) => pattern.test(command));
}

export function dispositionOf(entity: Entity, refusal: Refusal = noRefusal): Disposition {
  const refused = refusal(entity);
  if (refused !== null) {
    // The row reads `refused: network volume`; the detail keeps D89's whole sentence.
    return {
      kind: "refused",
      text: `refused: ${refused.split(" — ")[0] ?? refused}`,
      permanent: false,
      reason: refused,
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

/**
 * The installer command an Update delegates to (14 §2). `vercel-skills` takes the scope flag;
 * a project-scope update is run in the Project's own directory by the actions engine.
 * `codex-plugin` and an unknown installer have no update command in v1.
 */
export function installerCommand(entity: Entity): string | null {
  if (entity.kind === "skill") {
    if (entity.origin?.installer !== "vercel-skills") return null;
    return `npx skills update ${entity.name} ${entity.scope === "user" ? "-g" : "-p"}`;
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
  // 14 §2: a locally modified copy is backed up before the installer runs.
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

/** `protection: "undocumented"` — moldig cannot say what this is: bytes only, no checkbox. */
export function isSizeOnly(entity: Entity): boolean {
  return entity.protection === "undocumented";
}

/** Clean's universe plus the tickable rule (08 Answer). */
export function isTickable(entity: Entity, refusal: Refusal = noRefusal): boolean {
  if (entity.ownership !== "harness" || entity.protection !== "none") return false;
  if (entity.removal.method === "none") return false;
  if (isLive(entity) || refusal(entity) !== null) return false;
  if (entity.kind === "harness-cache") {
    return entity.rule === "swept" || entity.rule === "undocumented";
  }
  return entity.kind === "memory-file";
}

/** Delete: one explicit selection at a time, human-owned and `rule: kept` state included. */
export function canDelete(entity: Entity, refusal: Refusal = noRefusal): boolean {
  if (entity.protection !== "none" || entity.removal.method === "none") return false;
  return !isLive(entity) && refusal(entity) === null;
}

export function canUpdate(entity: Entity): boolean {
  return updateDisposition(entity) !== null;
}

export function allowed(entity: Entity, action: ActionKind, refusal: Refusal = noRefusal): boolean {
  switch (action) {
    case "clean":
      return isTickable(entity, refusal);
    case "delete":
      return canDelete(entity, refusal);
    case "update":
      return canUpdate(entity);
    default:
      return true;
  }
}

export function dispositionFor(
  entity: Entity,
  action: ActionKind,
  refusal: Refusal = noRefusal,
): Disposition {
  if (action === "update") return updateDisposition(entity) ?? OPEN_DISPOSITION;
  if (action === "open") return OPEN_DISPOSITION;
  return dispositionOf(entity, refusal);
}

export function badgesOf(entity: Entity, refusal: Refusal = noRefusal): Badge[] {
  const badges: Badge[] = [];
  if (entity.shared === true) badges.push("shared");
  if (isLive(entity)) badges.push("live");
  if (entity.kind === "harness-cache") {
    if (entity.userContent) badges.push("user content");
    if (entity.rule === "kept") badges.push("kept");
  }
  if (entity.kind === "memory-file" && entity.neverRead === true) badges.push("never read");
  if (entity.kind === "skill" && entity.placements.some((placement) => placement.dangling)) {
    badges.push("dangling");
  }
  if (entity.kind === "mcp-server") {
    if (entity.invalid !== null) badges.push("invalid");
    if (entity.secretKeys.length > 0) badges.push("secret");
  }
  if (dispositionOf(entity, refusal).permanent) badges.push("permanent");
  if (isSizeOnly(entity)) badges.push("size only");
  if (entity.sensitive && !badges.includes("secret")) badges.push("sensitive");
  return badges;
}

/** Display order of the badges a row carries, fixed by 08 §2 and shared by every screen. */
const BADGE_ORDER: readonly Badge[] = [
  "shared",
  "live",
  "user content",
  "kept",
  "never read",
  "dangling",
  "invalid",
  "secret",
  "permanent",
  "size only",
  "sensitive",
  "locally modified",
  "shadowed",
];

/** The run manifest's own badge union (D114) as the words the screens print. */
const CORE_BADGE: Readonly<Record<CoreBadge, Badge>> = {
  permanent: "permanent",
  "never-read": "never read",
  "locally-modified": "locally modified",
  dangling: "dangling",
  kept: "kept",
  "size-only": "size only",
  invalid: "invalid",
  secret: "secret",
};

/**
 * The badges of a planned or applied row: index v0's Flags and the manifest's own badges, in
 * one list, in display order. A Plan row and a manifest row both carry the two fields.
 */
export function badgesOfRow(row: {
  readonly flags: readonly Flag[];
  readonly badges: readonly CoreBadge[];
}): Badge[] {
  const found = new Set<Badge>();
  for (const flag of row.flags) {
    const badge = flagBadge(flag);
    if (badge !== null) found.add(badge);
  }
  for (const badge of row.badges) found.add(CORE_BADGE[badge]);
  // A secret is never announced twice as `sensitive` (`badgesOf` keeps the same rule).
  if (found.has("secret")) found.delete("sensitive");
  return BADGE_ORDER.filter((badge) => found.has(badge));
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
      // `memory` has no badge.
      return null;
  }
}

/** Tokens per session the entity costs, per harness id (`harness:claude-code` → tokens). */
export function tokensPerHarness(index: AuditIndex, entityId: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const edge of index.edges) {
    if (edge.kind !== "loaded-by" || edge.from !== entityId) continue;
    if (!edge.countsTowardHeadline || edge.tokensLoaded === null) continue;
    out[edge.to] = Math.max(out[edge.to] ?? 0, edge.tokensLoaded);
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
  return index.entities.find((entity) => entity.id === id);
}

/** Preselection (ADR-0004): only what a `clean` finding marks `preselect: true`. */
export function initialMarks(
  index: AuditIndex,
  refusal: Refusal = noRefusal,
): Map<string, ActionKind> {
  const marks = new Map<string, ActionKind>();
  for (const finding of index.findings) {
    if (finding.action.kind !== "clean") continue;
    for (const target of finding.targets) {
      const id = target.id;
      if (id === undefined) continue;
      const preselect =
        target.preselect ?? (finding.targets.length === 1 && finding.action.preselect);
      if (!preselect) continue;
      const entity = entityById(index, id);
      // Nothing human-owned and no memory file is ever preselected.
      if (entity && isTickable(entity, refusal) && entity.kind !== "memory-file") {
        marks.set(id, "clean");
      }
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
  /** Groups holding user content or permanent rows are confirmed a second time (08 §4). */
  readonly extraConfirm: string | null;
}

/** Code-unit order: deterministic on every platform, unlike `localeCompare`. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function groupSelection(
  index: AuditIndex,
  marks: ReadonlyMap<string, ActionKind>,
  refusal: Refusal = noRefusal,
): SelectionGroup[] {
  const groups: SelectionGroup[] = [];
  for (const action of ACTION_ORDER) {
    const rows: SelectionRow[] = [];
    for (const [id, marked] of marks) {
      if (marked !== action) continue;
      const entity = entityById(index, id);
      if (entity === undefined) continue;
      rows.push({
        entity,
        action,
        disposition: dispositionFor(entity, action, refusal),
        badges: badgesOf(entity, refusal),
        // Bytes and tokens count for Clean and Delete only; Open and Update free nothing.
        bytes: action === "clean" || action === "delete" ? entity.metrics.bytes : 0,
        tokens: action === "open" || action === "update" ? {} : tokensPerHarness(index, id),
      });
    }
    if (rows.length === 0) continue;
    rows.sort((a, b) => b.bytes - a.bytes || compare(a.entity.label, b.entity.label));
    const tokens: Record<string, number> = {};
    for (const row of rows) addTokens(tokens, row.tokens);
    const userContent = rows.some((row) => row.badges.includes("user content"));
    const permanent = rows.some((row) => row.disposition.permanent);
    const reasons = [
      userContent ? "user content" : null,
      permanent ? "permanent rows" : null,
    ].filter((reason): reason is string => reason !== null);
    groups.push({
      action,
      title: ACTION_TITLE[action],
      rows,
      bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
      tokens,
      sharedCount: rows.filter((row) => row.badges.includes("shared")).length,
      extraConfirm: reasons.length > 0 ? reasons.join(" and ") : null,
    });
  }
  return groups;
}

/** What the two-number header shows: bytes and tokens/session of the Clean and Delete rows. */
export function selectedTotals(
  index: AuditIndex,
  marks: ReadonlyMap<string, ActionKind>,
): { bytes: number; tokens: Record<string, number> } {
  let bytes = 0;
  const tokens: Record<string, number> = {};
  for (const [id, action] of marks) {
    if (action !== "clean" && action !== "delete") continue;
    const entity = entityById(index, id);
    if (entity === undefined) continue;
    bytes += entity.metrics.bytes;
    addTokens(tokens, tokensPerHarness(index, id));
  }
  return { bytes, tokens };
}
