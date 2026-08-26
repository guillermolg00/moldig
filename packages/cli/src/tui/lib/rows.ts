/**
 * The rows of the Items screen for one container — a Project or a harness's user scope — or for
 * a finding's target list.
 *
 * Sections in a fixed order: Context files / Skills / MCP servers / Agent definitions / Plugins
 * / Memory / Harness cache, plus Settings files behind `h`. Memory units expand into the index
 * and then the facts (never-read first, 08 §2); harness cache groups by (container × cacheKind)
 * and expands into units, oldest first (D116, 08 §1).
 */
import type { AuditIndex, Entity, EntityKind, HarnessCache, MemoryFile } from "@moldig/core";
import { basenameOf, formatAge, formatBytes, formatTokens, plural, shortPath } from "./format.js";
import {
  type ActionKind,
  type Badge,
  type Refusal,
  badgesOf,
  dispositionOf,
  isLive,
  isSizeOnly,
  isTickable,
  noRefusal,
  tokensPerHarness,
} from "./selection.js";

export interface ItemRow {
  readonly key: string;
  readonly kind: "section" | "entity" | "group";
  readonly depth: number;
  readonly label: string;
  readonly entity: Entity | null;
  readonly meta: string;
  readonly tickable: boolean;
  readonly humanOwned: boolean;
  readonly live: boolean;
  readonly refused: string | null;
  readonly sizeOnly: boolean;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly childIds: readonly string[];
  readonly badges: readonly Badge[];
}

export interface RowsOptions {
  readonly container: string | null;
  readonly onlyIds: ReadonlySet<string> | null;
  readonly expanded: ReadonlySet<string>;
  readonly showSettings: boolean;
  readonly filter: string;
  readonly marks: ReadonlyMap<string, ActionKind>;
  readonly home: string;
  readonly platform: string;
  readonly refusal?: Refusal;
}

const SECTIONS: readonly { readonly kind: EntityKind; readonly title: string }[] = [
  { kind: "context-file", title: "Context files" },
  { kind: "skill", title: "Skills" },
  { kind: "mcp-server", title: "MCP servers" },
  { kind: "agent-definition", title: "Agent definitions" },
  { kind: "plugin", title: "Plugins" },
  { kind: "memory-file", title: "Memory" },
  { kind: "harness-cache", title: "Harness cache" },
  { kind: "settings-file", title: "Settings files" },
];

/** Code-unit order: deterministic on every platform, unlike `localeCompare`. */
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function harnessOf(container: string): string | null {
  return container.startsWith("harness:") ? container.slice("harness:".length) : null;
}

export function inContainer(entity: Entity, container: string): boolean {
  const harness = harnessOf(container);
  if (harness === null) {
    if (entity.project === container) return true;
    // A Skill lives in one place but is reached from several; a placement in the Project counts.
    return entity.kind === "skill" && entity.placements.some((p) => p.project === container);
  }
  if (entity.project !== null) return false;
  if (entity.harness === harness) return true;
  if (entity.harness === null && entity.kind === "skill") {
    return entity.placements.some((p) => p.harness === harness);
  }
  return false;
}

export function entitiesInContainer(index: AuditIndex, container: string): Entity[] {
  return index.entities.filter((entity) => inContainer(entity, container));
}

/** The last meta cell of a harness-cache row: what moldig would do with the unit. */
function cacheDisposition(entity: HarnessCache, refusal: Refusal): string {
  if (isSizeOnly(entity)) return "size only";
  if (isLive(entity)) return "live";
  if (entity.protection === "never") return "never";
  if (entity.rule === "kept") return "kept · Delete only";
  return dispositionOf(entity, refusal).text;
}

function metaOf(index: AuditIndex, entity: Entity, refusal: Refusal): string {
  const tokens = entity.metrics.tokens ? `${formatTokens(entity.metrics.tokens.o200k)} tok` : null;
  const perSession = Object.values(tokensPerHarness(index, entity.id)).reduce(
    (most, count) => Math.max(most, count),
    0,
  );
  const cost = perSession > 0 ? `${formatTokens(perSession)}/session` : null;
  switch (entity.kind) {
    case "context-file":
      return [cost ?? tokens, formatBytes(entity.metrics.bytes), entity.scope]
        .filter(Boolean)
        .join(" · ");
    case "skill":
      return [
        plural(entity.placements.length, "placement"),
        cost ?? tokens,
        entity.drift === "unknown" ? null : `drift: ${entity.drift}`,
      ]
        .filter(Boolean)
        .join(" · ");
    case "mcp-server":
      return [entity.transport, entity.scope, entity.invalid ? `invalid: ${entity.invalid}` : null]
        .filter(Boolean)
        .join(" · ");
    case "agent-definition":
      return [cost ?? tokens, entity.scope].filter(Boolean).join(" · ");
    case "plugin":
      return [
        entity.version ?? "?",
        formatBytes(entity.metrics.bytes),
        plural(entity.installs.length, "install"),
      ].join(" · ");
    case "memory-file": {
      // The read column exists only where a transcript can prove a read (08 §2).
      const read =
        entity.readSignal.source === "transcript-tool-use"
          ? entity.neverRead === true
            ? "never read"
            : `reads ${entity.reads?.count ?? 0}`
          : null;
      const portion =
        entity.role === "index" && entity.loadedPortion
          ? `${formatTokens(entity.loadedPortion.tokens)}/session`
          : null;
      return [
        formatAge(entity.metrics.ageDays),
        formatBytes(entity.metrics.bytes),
        portion ?? tokens,
        read,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "harness-cache":
      return [
        formatAge(entity.metrics.ageDays),
        formatBytes(entity.metrics.bytes),
        cacheDisposition(entity, refusal),
      ]
        .filter(Boolean)
        .join(" · ");
    default:
      return [
        entity.role,
        formatBytes(entity.metrics.bytes),
        entity.entries === null ? null : plural(entity.entries, "entry", "entries"),
      ]
        .filter(Boolean)
        .join(" · ");
  }
}

function entityRow(index: AuditIndex, entity: Entity, depth: number, refusal: Refusal): ItemRow {
  const live = isLive(entity);
  const refused = refusal(entity);
  const sizeOnly = isSizeOnly(entity);
  return {
    key: entity.id,
    kind: "entity",
    depth,
    label: entity.label,
    entity,
    meta: metaOf(index, entity, refusal),
    tickable: isTickable(entity, refusal),
    humanOwned: entity.ownership === "human",
    live,
    refused,
    sizeOnly,
    expandable: false,
    expanded: false,
    childIds: [],
    badges: badgesOf(entity, refusal),
  };
}

interface GroupOptions {
  readonly expanded: boolean;
  readonly marks: ReadonlyMap<string, ActionKind>;
  readonly extra: string | null;
  readonly refusal: Refusal;
}

function groupRow(
  key: string,
  label: string,
  children: readonly Entity[],
  options: GroupOptions,
): ItemRow {
  const bytes = children.reduce((sum, child) => sum + child.metrics.bytes, 0);
  const tickableIds = children
    .filter((child) => isTickable(child, options.refusal))
    .map((child) => child.id);
  const selected = tickableIds.filter((id) => options.marks.get(id) === "clean").length;
  const meta = [
    plural(children.length, "unit"),
    formatBytes(bytes),
    options.extra,
    tickableIds.length > 0 ? `${selected}/${tickableIds.length} selected` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const badges: Badge[] = [];
  if (children.some((child) => isLive(child))) badges.push("live");
  if (children.some((child) => child.kind === "harness-cache" && child.userContent)) {
    badges.push("user content");
  }
  if (children.some((child) => child.kind === "memory-file" && child.neverRead === true)) {
    badges.push("never read");
  }
  return {
    key,
    kind: "group",
    depth: 1,
    label,
    entity: null,
    meta,
    tickable: tickableIds.length > 0,
    humanOwned: false,
    live: false,
    refused: null,
    sizeOnly: false,
    expandable: true,
    expanded: options.expanded,
    childIds: tickableIds,
    badges,
  };
}

function neverRank(file: MemoryFile): number {
  return file.neverRead === true ? 0 : 1;
}

/** 08 §2: the index first, then the facts no transcript read, then the rest by label. */
function sortMemory(files: readonly MemoryFile[]): MemoryFile[] {
  return files.toSorted((a, b) => {
    if (a.role === "index" && b.role !== "index") return -1;
    if (b.role === "index" && a.role !== "index") return 1;
    return neverRank(a) - neverRank(b) || compare(a.label, b.label);
  });
}

function matches(filter: string, entity: Entity): boolean {
  return (
    filter === "" ||
    entity.label.toLowerCase().includes(filter) ||
    entity.path.toLowerCase().includes(filter)
  );
}

function memoryRows(
  index: AuditIndex,
  members: readonly Entity[],
  options: RowsOptions,
  filter: string,
  isExpanded: (key: string) => boolean,
  refusal: Refusal,
): ItemRow[] {
  const rows: ItemRow[] = [];
  const units = new Map<string, MemoryFile[]>();
  for (const file of members) {
    if (file.kind !== "memory-file") continue;
    const list = units.get(file.unit) ?? [];
    list.push(file);
    units.set(file.unit, list);
  }
  for (const [unit, files] of units) {
    const visible = files.filter((file) => matches(filter, file));
    if (visible.length === 0) continue;
    const key = `unit:${unit}`;
    const expanded = isExpanded(key) || filter !== "";
    const harness = files[0]?.harness ?? null;
    rows.push(
      groupRow(key, shortPath(unit, options.home, options.platform), files, {
        expanded,
        marks: options.marks,
        extra: harness === null ? "memory unit" : `memory unit · ${harness}`,
        refusal,
      }),
    );
    if (expanded) {
      for (const file of sortMemory(visible)) rows.push(entityRow(index, file, 2, refusal));
    }
  }
  return rows;
}

function cacheRows(
  index: AuditIndex,
  members: readonly Entity[],
  options: RowsOptions,
  filter: string,
  isExpanded: (key: string) => boolean,
  refusal: Refusal,
): ItemRow[] {
  const rows: ItemRow[] = [];
  const groups = new Map<string, HarnessCache[]>();
  for (const unit of members) {
    if (unit.kind !== "harness-cache") continue;
    const key = `${unit.harness ?? "shared"}:${unit.cacheKind}`;
    const list = groups.get(key) ?? [];
    list.push(unit);
    groups.set(key, list);
  }
  for (const [groupKey, units] of groups) {
    const visible = units.filter((unit) => matches(filter, unit));
    if (visible.length === 0) continue;
    // D116: one group per (container × cacheKind), exactly as the findings are filed.
    const key = `cache:${options.container ?? "all"}:${groupKey}`;
    const expanded = isExpanded(key) || filter !== "";
    const first = units[0];
    const label = `${first?.cacheKind ?? groupKey} · ${first?.harness ?? ""}`;
    const rule = first?.rule ?? "undocumented";
    const retention = first?.retention;
    const swept =
      retention?.days != null
        ? `swept after ${retention.days} days`
        : retention?.count != null
          ? `the ${retention.count} newest are kept`
          : "swept by the harness";
    const extra =
      rule === "swept"
        ? swept
        : rule === "kept"
          ? "kept by the harness"
          : first?.protection === "undocumented"
            ? "size only"
            : "no documented sweep";
    rows.push(groupRow(key, label, units, { expanded, marks: options.marks, extra, refusal }));
    if (expanded) {
      const sorted = visible.toSorted(
        (a, b) => (b.metrics.ageDays ?? 0) - (a.metrics.ageDays ?? 0) || compare(a.label, b.label),
      );
      for (const unit of sorted) rows.push(entityRow(index, unit, 2, refusal));
    }
  }
  return rows;
}

export function buildRows(index: AuditIndex, options: RowsOptions): ItemRow[] {
  const refusal = options.refusal ?? noRefusal;
  const filter = options.filter.trim().toLowerCase();
  const onlyIds = options.onlyIds;
  const pool = onlyIds
    ? index.entities.filter((entity) => onlyIds.has(entity.id))
    : options.container === null
      ? [...index.entities]
      : entitiesInContainer(index, options.container);
  // A finding's target list opens flat: every group expanded, nothing hidden behind a caret.
  const isExpanded = (key: string): boolean =>
    onlyIds !== null ? true : options.expanded.has(key);
  const rows: ItemRow[] = [];

  for (const section of SECTIONS) {
    if (section.kind === "settings-file" && !options.showSettings) continue;
    const members = pool.filter((entity) => entity.kind === section.kind);
    if (members.length === 0) continue;

    let sectionRows: ItemRow[];
    if (section.kind === "memory-file") {
      sectionRows = memoryRows(index, members, options, filter, isExpanded, refusal);
    } else if (section.kind === "harness-cache") {
      sectionRows = cacheRows(index, members, options, filter, isExpanded, refusal);
    } else {
      sectionRows = members
        .filter((entity) => matches(filter, entity))
        .toSorted((a, b) => compare(a.label, b.label) || compare(a.path, b.path))
        .map((entity) => entityRow(index, entity, 1, refusal));
    }
    if (sectionRows.length === 0) continue;

    rows.push({
      key: `section:${section.kind}`,
      kind: "section",
      depth: 0,
      label: section.title,
      entity: null,
      meta: plural(members.length, "row"),
      tickable: false,
      humanOwned: false,
      live: false,
      refused: null,
      sizeOnly: false,
      expandable: false,
      expanded: false,
      childIds: [],
      badges: [],
    });
    rows.push(...sectionRows);
  }
  return rows;
}

export function containerLabel(index: AuditIndex, container: string | null): string {
  if (container === null) return "everything";
  const harness = harnessOf(container);
  if (harness !== null) {
    const found = index.harnesses.find((item) => item.id === container);
    return `${found?.displayName ?? harness} · user scope`;
  }
  const project = index.projects.find((item) => item.id === container);
  return project ? project.displayName : basenameOf(container, index.scan.platform);
}
