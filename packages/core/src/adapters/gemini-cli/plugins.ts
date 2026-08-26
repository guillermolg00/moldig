/* oxlint-disable no-await-in-loop -- sequential on purpose: the baseline order and bounded disk IO depend on it */
/**
 * Gemini extensions (research 02, Gemini extensions; spec §8). D134 fixes the wording: they are
 * **plugins** in every string moldig writes — only the literal `gemini extensions …` command and
 * the `gemini-extension.json` file name keep the word. Only `~/.gemini/extensions/<name>/` is
 * loaded by the extension manager; a `<member>/.gemini/extensions/<name>/` is present but never
 * read, so it gets a `never` verdict and ships nothing.
 *
 * `extension-enablement.json` carries per-plugin `overrides: ["<glob>", "!<glob>"]`; the last
 * matching glob wins (D71) and `!` means disabled.
 */
import { basename, join } from "node:path";
import type { Origin, OriginatesFromEdge, Plugin } from "../../index/types.js";
import { warning } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isFile, isRecord, isStringArray, listDir, readText, treeStats } from "../../scan/fs.js";
import { edgeId } from "../../scan/paths.js";
import {
  addEdge,
  addEntity,
  baseEntity,
  evidence,
  loadedBy,
  providedBy,
  type GeminiScan,
} from "./model.js";
import { contextFileFacts, emitLoad } from "./context-files.js";
import { hooksOf, parseJsonc } from "./settings.js";

/** A glob of `extension-enablement.json`: `**` crosses `/`, `*` does not. */
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i] ?? "";
    if (char === "*" && glob[i + 1] === "*") {
      // `/**` also matches the directory itself, which is how `<ROOT>/**` selects `<ROOT>/x`.
      if (source.endsWith("/")) source = source.slice(0, -1) + "(?:/.*)?";
      else source += ".*";
      i += 1;
      continue;
    }
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += char.replaceAll(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

/** The last matching glob wins; a leading `!` disables (D71). `null` = no glob matched. */
export function overrideVerdict(overrides: readonly string[], path: string): boolean | null {
  let verdict: boolean | null = null;
  for (const glob of overrides) {
    const negated = glob.startsWith("!");
    const pattern = negated ? glob.slice(1) : glob;
    if (globToRegExp(pattern).test(path)) verdict = !negated;
  }
  return verdict;
}

export interface Enablement {
  path: string;
  present: boolean;
  overrides: Map<string, string[]>;
}

export async function readEnablement(path: string): Promise<Enablement> {
  const text = await readText(path);
  if (text === null) return { path, present: false, overrides: new Map() };
  const data = parseJsonc(text);
  const overrides = new Map<string, string[]>();
  if (data !== null) {
    for (const [name, record] of Object.entries(data)) {
      if (!isRecord(record)) continue;
      const list = record["overrides"];
      if (isStringArray(list)) overrides.set(name, [...list]);
    }
  }
  return { path, present: true, overrides };
}

/** `.gemini-extension-install.json` → the plugin's Origin and the lock the edge points at (§8). */
function originOf(dir: string, data: Record<string, unknown> | null): Origin | null {
  if (data === null) return null;
  const type = typeof data["type"] === "string" ? data["type"] : null;
  const source = typeof data["source"] === "string" ? data["source"] : "";
  let sourceUrl: string | null = null;
  try {
    sourceUrl = new URL(source).toString();
  } catch {
    sourceUrl = null;
  }
  return {
    installer: "gemini-extension",
    sourceType: type === "git" ? "git" : type === "local" ? "local" : "unknown",
    source,
    sourceUrl,
    ref: typeof data["ref"] === "string" ? data["ref"] : null,
    skillPath: null,
    recordedHash: null,
    installedAt: null,
    updatedAt: null,
    lock: { type: "file", path: join(dir, ".gemini-extension-install.json") },
  };
}

async function readManifest(dir: string): Promise<Record<string, unknown> | null> {
  const text = await readText(join(dir, "gemini-extension.json"));
  return text === null ? null : parseJsonc(text);
}

/** The context file names a plugin ships: `contextFileName` (string or string[]), else `GEMINI.md`. */
function pluginContextNames(manifest: Record<string, unknown>): string[] {
  const value = manifest["contextFileName"];
  if (typeof value === "string") return [value];
  if (isStringArray(value)) return [...value];
  return ["GEMINI.md"];
}

export async function collectPlugins(
  scan: GeminiScan,
  projects: readonly DiscoveredProject[],
): Promise<void> {
  const enablement = await readEnablement(
    join(scan.paths.extensionsDir, "extension-enablement.json"),
  );
  const entries = (await listDir(scan.paths.extensionsDir)).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const dir = join(scan.paths.extensionsDir, entry.name);
    if (!(await isFile(join(dir, "gemini-extension.json")))) continue;
    const manifest = await readManifest(dir);
    if (manifest === null) {
      scan.ctx.warn(
        warning(
          "parse-error",
          "gemini-extension.json is not valid JSON",
          "gemini-cli",
          join(dir, "gemini-extension.json"),
          "partial",
        ),
      );
      continue;
    }
    const name = typeof manifest["name"] === "string" ? manifest["name"] : entry.name;
    const overrides = enablement.overrides.get(name) ?? null;
    const installs: Plugin["installs"] =
      overrides === null
        ? [{ scope: "user", project: null, enabled: true }]
        : [
            { scope: "user", project: null, enabled: null },
            ...projects.map((project) => ({
              scope: "project" as const,
              project: project.id,
              enabled: overrideVerdict(overrides, project.path) ?? true,
            })),
          ];
    const installText = await readText(join(dir, ".gemini-extension-install.json"));
    const installData = installText === null ? null : parseJsonc(installText);
    const hooksText = await readText(join(dir, "hooks", "hooks.json"));
    const hooksData = hooksText === null ? null : parseJsonc(hooksText);
    const tree = await treeStats(dir);
    const base = baseEntity(scan, {
      kind: "plugin",
      path: dir,
      scope: "user",
      project: null,
      ownership: "human",
      locator: { type: "dir", path: dir },
      format: "dir",
      label: name,
      sensitive: false,
      protection: "none",
      // Ticket 14 §1: uninstalling delegates to the CLI and is not permanent.
      removal: { method: "delegate", command: `gemini extensions uninstall ${name}` },
      metrics: {
        bytes: tree.bytes,
        files: tree.files,
        lines: null,
        mtime: tree.newestMs === null ? null : new Date(tree.newestMs).toISOString(),
        ageDays:
          tree.newestMs === null
            ? null
            : Math.max(
                0,
                Math.floor((scan.ctx.options.now.getTime() - tree.newestMs) / 86_400_000),
              ),
        tokens: null,
        lastUsed: null,
      },
    });
    const entity: Plugin = {
      ...base,
      kind: "plugin",
      pluginId: name,
      version: typeof manifest["version"] === "string" ? manifest["version"] : null,
      marketplace: null,
      installs,
      origin: originOf(dir, installData),
      hooks: hooksData === null ? [] : hooksOf(hooksData),
    };
    const added = addEntity(scan, entity);
    if (added.origin !== null) {
      const lock = join(dir, ".gemini-extension-install.json");
      const edge: OriginatesFromEdge = {
        id: edgeId("originates-from", added.id, scan.ctx.id("settings-file", lock)),
        kind: "originates-from",
        from: added.id,
        to: scan.ctx.id("settings-file", lock),
        confidence: "certain",
        evidence: [
          evidence("lock-entry", "gemini-extension install record", {
            type: "file",
            path: lock,
          }),
        ],
      };
      addEdge(scan, edge);
    }
    // `null` means "some Projects override it": the user install itself still loads.
    const userEnabled = installs[0]?.enabled !== false;
    const reason =
      overrides === null
        ? "installed plugin: enabled in every session"
        : `plugin enablement overrides: ${overrides.join(", ")}`;
    loadedBy(scan, {
      from: added.id,
      project: null,
      mode: userEnabled ? "full" : "disabled",
      reason,
      placement: dir,
      effectiveName: name,
      ordered: false,
      charsLoaded: null,
      importsResolved: null,
      tokensLoaded: null,
      disableModelInvocation: null,
      countsTowardHeadline: false,
      evidence: [evidence("manifest", reason)],
    });
    scan.extensions.push({
      dir,
      name,
      entity: added,
      manifest,
      enabled: userEnabled,
      reason,
    });
    // The plugin's own context file is part of the baseline of every session it is enabled in.
    for (const contextName of pluginContextNames(manifest)) {
      const path = join(dir, contextName);
      const facts = await contextFileFacts(scan, path, null);
      if (facts === null) continue;
      if (facts.entity !== null) providedBy(scan, facts.entity.id, added);
      await emitLoad(
        scan,
        facts,
        {
          project: null,
          mode: userEnabled ? "full" : "never",
          reason: userEnabled
            ? `plugin ${name}: read in every session it is enabled in`
            : `plugin ${name} is disabled: its context file is not read`,
          countsTowardHeadline: userEnabled,
          ordered: userEnabled,
        },
        null,
        0,
        new Set(),
      );
    }
  }

  // `<member>/.gemini/extensions/<name>/`: present but never loaded on main (fixture edge 8).
  for (const project of projects) {
    if (project.reachability !== "present") continue;
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      const dir = join(member.path, ".gemini", "extensions");
      for (const entry of (await listDir(dir)).toSorted((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isDirectory()) continue;
        const path = join(dir, entry.name);
        const manifest = await readManifest(path);
        if (manifest === null) continue;
        const name = typeof manifest["name"] === "string" ? manifest["name"] : basename(path);
        const installText = await readText(join(path, ".gemini-extension-install.json"));
        const tree = await treeStats(path);
        const base = baseEntity(scan, {
          kind: "plugin",
          path,
          scope: "project",
          project,
          ownership: "human",
          locator: { type: "dir", path },
          format: "dir",
          label: name,
          sensitive: false,
          protection: "none",
          removal: { method: "trash" },
          metrics: {
            bytes: tree.bytes,
            files: tree.files,
            lines: null,
            mtime: tree.newestMs === null ? null : new Date(tree.newestMs).toISOString(),
            ageDays:
              tree.newestMs === null
                ? null
                : Math.max(
                    0,
                    Math.floor((scan.ctx.options.now.getTime() - tree.newestMs) / 86_400_000),
                  ),
            tokens: null,
            lastUsed: null,
          },
        });
        const entity: Plugin = {
          ...base,
          kind: "plugin",
          pluginId: name,
          version: typeof manifest["version"] === "string" ? manifest["version"] : null,
          marketplace: null,
          installs: [{ scope: "project", project: project.id, enabled: false }],
          origin: originOf(path, installText === null ? null : parseJsonc(installText)),
          hooks: [],
        };
        const added = addEntity(scan, entity);
        const reason = "project plugins are not loaded; only ~/.gemini/extensions is";
        loadedBy(scan, {
          from: added.id,
          project: project.id,
          mode: "never",
          reason,
          placement: path,
          effectiveName: name,
          ordered: false,
          charsLoaded: null,
          importsResolved: null,
          tokensLoaded: null,
          disableModelInvocation: null,
          countsTowardHeadline: false,
          evidence: [evidence("loading-rule", reason)],
        });
      }
    }
  }
}
