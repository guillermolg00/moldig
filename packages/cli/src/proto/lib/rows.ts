// THROWAWAY PROTOTYPE (ticket 09) — the rows of the Items screen for one container
// (a Project or a harness's user scope), or for a finding's target list.
//
// Sections: Context files / Skills / MCP servers / Agent definitions / Plugins / Memory /
// Harness cache (+ Settings files when toggled). Memory units expand into index + facts
// (never-read facts first); cache groups (container × cacheKind) expand into units.
import type { AuditIndex, Entity, EntityKind, HarnessCache, MemoryFile } from "@moldig/core";
import { basenameOf, formatAge, formatBytes, formatTokens, plural, shortPath } from "./format.js";
import {
  type ActionKind,
  type Badge,
  type Disposition,
  badgesOf,
  dispositionOf,
  isLive,
  isSizeOnly,
  isTickable,
  refusedReason,
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
  readonly noAction: boolean;
  readonly expandable: boolean;
  readonly expanded: boolean;
  readonly childIds: readonly string[];
  readonly badges: readonly Badge[];
  readonly disposition: Disposition | null;
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
}

const SECTIONS: readonly { kind: EntityKind; title: string }[] = [
  { kind: "context-file", title: "Context files" },
  { kind: "skill", title: "Skills" },
  { kind: "mcp-server", title: "MCP servers" },
  { kind: "agent-definition", title: "Agent definitions" },
  { kind: "plugin", title: "Plugins" },
  { kind: "memory-file", title: "Memory" },
  { kind: "harness-cache", title: "Harness cache" },
  { kind: "settings-file", title: "Settings files" },
];

export function harnessOf(container: string): string | null {
  return container.startsWith("harness:") ? container.slice("harness:".length) : null;
}

export function inContainer(entity: Entity, container: string): boolean {
  const harness = harnessOf(container);
  if (harness === null) {
    if (entity.project === container) return true;
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
  return index.entities.filter((e) => inContainer(e, container));
}

function metaOf(index: AuditIndex, e: Entity): string {
  const tokens = e.metrics.tokens ? `${formatTokens(e.metrics.tokens.o200k)} tok` : null;
  const perSession = Object.values(tokensPerHarness(index, e.id)).reduce(
    (a, b) => Math.max(a, b),
    0,
  );
  const cost = perSession > 0 ? `${formatTokens(perSession)}/session` : null;
  switch (e.kind) {
    case "context-file":
      return [cost ?? tokens, formatBytes(e.metrics.bytes), e.scope].filter(Boolean).join(" · ");
    case "skill":
      return [
        plural(e.placements.length, "placement"),
        cost ?? tokens,
        e.drift !== "unknown" ? `drift: ${e.drift}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "mcp-server":
      return [e.transport, e.scope, e.invalid ? `invalid: ${e.invalid}` : null]
        .filter(Boolean)
        .join(" · ");
    case "agent-definition":
      return [cost ?? tokens, e.scope].filter(Boolean).join(" · ");
    case "plugin":
      return [
        e.version ?? "?",
        formatBytes(e.metrics.bytes),
        plural(e.installs.length, "install"),
      ].join(" · ");
    case "memory-file": {
      const read =
        e.readSignal.source === "transcript-tool-use"
          ? e.neverRead
            ? "never read"
            : `reads ${e.reads?.count ?? 0}`
          : null;
      const portion =
        e.role === "index" && e.loadedPortion
          ? `${formatTokens(e.loadedPortion.tokens)}/session`
          : null;
      return [formatAge(e.metrics.ageDays), formatBytes(e.metrics.bytes), portion ?? tokens, read]
        .filter(Boolean)
        .join(" · ");
    }
    case "harness-cache":
      return [formatAge(e.metrics.ageDays), formatBytes(e.metrics.bytes), dispositionText(e)]
        .filter(Boolean)
        .join(" · ");
    default:
      return [
        e.role,
        formatBytes(e.metrics.bytes),
        e.entries === null ? null : plural(e.entries, "entry", "entries"),
      ]
        .filter(Boolean)
        .join(" · ");
  }
}

function dispositionText(e: HarnessCache): string {
  if (isSizeOnly(e)) return "size only";
  if (isLive(e)) return "live";
  if (e.protection === "never") return "never";
  if (e.rule === "kept") return "kept · Delete only";
  return dispositionOf(e).text;
}

function entityRow(index: AuditIndex, e: Entity, depth: number): ItemRow {
  const live = isLive(e);
  const refused = refusedReason(e);
  return {
    key: e.id,
    kind: "entity",
    depth,
    label: e.label,
    entity: e,
    meta: metaOf(index, e),
    tickable: isTickable(e),
    humanOwned: e.ownership === "human",
    live,
    refused,
    sizeOnly: isSizeOnly(e),
    noAction: e.removal.method === "none" && !isSizeOnly(e) && e.protection !== "never",
    expandable: false,
    expanded: false,
    childIds: [],
    badges: badgesOf(e),
    disposition: e.ownership === "harness" && !live && !isSizeOnly(e) ? dispositionOf(e) : null,
  };
}

function groupRow(
  key: string,
  label: string,
  children: readonly Entity[],
  o: {
    expanded: boolean;
    marks: ReadonlyMap<string, ActionKind>;
    tickable: boolean;
    extra?: string;
  },
): ItemRow {
  const bytes = children.reduce((acc, c) => acc + c.metrics.bytes, 0);
  const tickableIds = children.filter((c) => isTickable(c)).map((c) => c.id);
  const selected = tickableIds.filter((id) => o.marks.get(id) === "clean").length;
  const meta = [
    plural(children.length, "unit"),
    formatBytes(bytes),
    o.extra ?? null,
    tickableIds.length > 0 ? `${selected}/${tickableIds.length} selected` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const badges: Badge[] = [];
  if (children.some((c) => isLive(c))) badges.push("live");
  if (children.some((c) => c.kind === "harness-cache" && c.userContent))
    badges.push("user content");
  if (children.some((c) => c.kind === "memory-file" && c.neverRead === true))
    badges.push("never read");
  return {
    key,
    kind: "group",
    depth: 1,
    label,
    entity: null,
    meta,
    tickable: o.tickable && tickableIds.length > 0,
    humanOwned: false,
    live: false,
    refused: null,
    sizeOnly: false,
    noAction: false,
    expandable: true,
    expanded: o.expanded,
    childIds: tickableIds,
    badges,
    disposition: null,
  };
}

function sortMemory(files: MemoryFile[]): MemoryFile[] {
  return files.toSorted((a, b) => {
    if (a.role === "index" && b.role !== "index") return -1;
    if (b.role === "index" && a.role !== "index") return 1;
    const an = a.neverRead === true ? 0 : 1;
    const bn = b.neverRead === true ? 0 : 1;
    return an - bn || a.label.localeCompare(b.label);
  });
}

function matches(filter: string, e: Entity): boolean {
  return (
    filter === "" || e.label.toLowerCase().includes(filter) || e.path.toLowerCase().includes(filter)
  );
}

export function buildRows(index: AuditIndex, o: RowsOptions): ItemRow[] {
  const filter = o.filter.trim().toLowerCase();
  const pool = o.onlyIds
    ? index.entities.filter((e) => o.onlyIds?.has(e.id))
    : o.container
      ? entitiesInContainer(index, o.container)
      : [...index.entities];
  const isExpanded = (key: string): boolean => (o.onlyIds !== null ? true : o.expanded.has(key));
  const rows: ItemRow[] = [];

  for (const section of SECTIONS) {
    if (section.kind === "settings-file" && !o.showSettings) continue;
    const members = pool.filter((e) => e.kind === section.kind);
    if (members.length === 0) continue;
    const sectionRows: ItemRow[] = [];

    if (section.kind === "memory-file") {
      const units = new Map<string, MemoryFile[]>();
      for (const m of members.filter((e): e is MemoryFile => e.kind === "memory-file")) {
        const list = units.get(m.unit) ?? [];
        list.push(m);
        units.set(m.unit, list);
      }
      for (const [unit, files] of units) {
        const visible = files.filter((f) => matches(filter, f));
        if (visible.length === 0) continue;
        const key = `unit:${unit}`;
        const expanded = isExpanded(key) || filter !== "";
        const harness = files[0]?.harness ?? null;
        sectionRows.push(
          groupRow(key, shortPath(unit, o.home, o.platform), files, {
            expanded,
            marks: o.marks,
            tickable: true,
            extra: harness ? `memory unit · ${harness}` : "memory unit",
          }),
        );
        if (expanded) for (const f of sortMemory(visible)) sectionRows.push(entityRow(index, f, 2));
      }
    } else if (section.kind === "harness-cache") {
      const groups = new Map<string, HarnessCache[]>();
      for (const c of members.filter((e): e is HarnessCache => e.kind === "harness-cache")) {
        const key = `${c.harness}:${c.cacheKind}`;
        const list = groups.get(key) ?? [];
        list.push(c);
        groups.set(key, list);
      }
      for (const [groupKey, units] of groups) {
        const visible = units.filter((u) => matches(filter, u));
        if (visible.length === 0) continue;
        const key = `cache:${o.container ?? "all"}:${groupKey}`;
        const expanded = isExpanded(key) || filter !== "";
        const first = units[0];
        const label = `${first?.cacheKind ?? groupKey} · ${first?.harness ?? ""}`;
        const rule = first?.rule ?? "undocumented";
        const extra =
          rule === "swept"
            ? `swept after ${first?.retention.days ?? "?"} days`
            : rule === "kept"
              ? "kept by the harness"
              : first?.protection === "undocumented"
                ? "size only"
                : "no documented sweep";
        sectionRows.push(
          groupRow(key, label, units, { expanded, marks: o.marks, tickable: true, extra }),
        );
        if (expanded) {
          const sorted = visible.toSorted(
            (a, b) => (b.metrics.ageDays ?? 0) - (a.metrics.ageDays ?? 0),
          );
          for (const u of sorted) sectionRows.push(entityRow(index, u, 2));
        }
      }
    } else {
      const sorted = [...members]
        .filter((e) => matches(filter, e))
        .toSorted((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
      for (const e of sorted) sectionRows.push(entityRow(index, e, 1));
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
      noAction: false,
      expandable: false,
      expanded: false,
      childIds: [],
      badges: [],
      disposition: null,
    });
    rows.push(...sectionRows);
  }
  return rows;
}

export function containerLabel(index: AuditIndex, container: string | null): string {
  if (container === null) return "everything";
  const harness = harnessOf(container);
  if (harness !== null) {
    const h = index.harnesses.find((x) => x.id === container);
    return `${h?.displayName ?? harness} · user scope`;
  }
  const p = index.projects.find((x) => x.id === container);
  return p ? p.displayName : basenameOf(container, index.scan.platform);
}
