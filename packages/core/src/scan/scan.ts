/* oxlint-disable no-await-in-loop -- sequential on purpose: the load-chain order, the per-Project `order` numbers and bounded disk IO depend on it */
/**
 * `scan`: the read-only pass that runs every adapter and builds index v0 (ticket 07). Order:
 * adapters resolve their breadcrumbs → Roots are walked for markers and the cwd's Project is
 * included → git runs once per present repository (only when allowed) → adapters emit their
 * entities and edges → Projects, session loads and totals are assembled and everything is
 * sorted by id so two scans of one machine serialise identically. The memory read signal is
 * never computed here (`readSignal.source: "not-computed"`): `audit` does that (ticket 07/08).
 */
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeCodeAdapter } from "../adapters/claude-code/index.js";
import type { Adapter, AdapterOutput } from "../adapters/adapter.js";
import { gitVersion, repoGitStatus, type RepoGitStatus } from "../git/git-status.js";
import type {
  Breadcrumb,
  Entity,
  Harness,
  HarnessId,
  Index,
  LoadedByEdge,
  Project,
  SessionLoad,
  Warning,
} from "../index/types.js";
import { loadTokenizer, MULTIPLIERS } from "../tokens/tokenizer.js";
import { byId, mergeOutputs, parentIdOf } from "./assemble.js";
import { createContext, warning, type GitLookup, type ResolvedOptions } from "./context.js";
import { createDiscovery, type DiscoveredProject } from "./discovery.js";
import { isFile, isRecord, readText, realpathOrSelf } from "./fs.js";
import { assertScanPlatform, pathIdentity, type ScanPlatform } from "./paths.js";

export interface ScanOptions {
  home: string;
  roots: readonly string[];
  cwd: string;
  /** D125: anything outside these three throws; the CLI turns the throw into a usage error. */
  platform: ScanPlatform;
  env: Readonly<Record<string, string | undefined>>;
  /** Default: every harness with an adapter (today only `claude-code`). */
  harnesses?: readonly HarnessId[];
  /** Default `true`; `false` never spawns git: `git-missing` warning, `gitStatus: null`. */
  git?: boolean;
  /** Deterministic `generatedAt` and `ageDays`. */
  now?: Date;
  /** D50: PID liveness behind the `pid` and `in-use-marker` guards; default `process.kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean;
}

const STAT_DEADLINE_MS = 2000;

/** Default live guard: signal 0 asks the kernel whether the process exists, and kills nothing. */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return isRecord(error) && error["code"] === "EPERM";
  }
}

const ADAPTERS: Record<string, () => Adapter> = {
  "claude-code": createClaudeCodeAdapter,
};

let versionPromise: Promise<string> | undefined;

/** The version of the nearest `@moldig/core` package.json above this module (src or dist). */
function moldigVersion(): Promise<string> {
  versionPromise ??= (async () => {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 6; depth += 1) {
      const candidate = join(dir, "package.json");
      if (await isFile(candidate)) {
        const text = await readText(candidate);
        try {
          const pkg: unknown = text === null ? null : JSON.parse(text);
          if (
            isRecord(pkg) &&
            pkg["name"] === "@moldig/core" &&
            typeof pkg["version"] === "string"
          ) {
            return pkg["version"];
          }
        } catch {
          // keep walking
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    try {
      const pkg: unknown = createRequire(import.meta.url)("@moldig/core/package.json");
      if (isRecord(pkg) && typeof pkg["version"] === "string") return pkg["version"];
    } catch {
      // not resolvable from here
    }
    return "0.0.0";
  })();
  return versionPromise;
}

function sessionLoadOf(edges: readonly LoadedByEdge[], project: string | null): SessionLoad {
  const items = edges
    .filter(
      (edge) => edge.project === project && edge.countsTowardHeadline && edge.tokensLoaded !== null,
    )
    .toSorted(
      (a, b) =>
        (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || byId(a, b),
    )
    .map((edge, index) => ({
      entity: edge.from,
      edge: edge.id,
      order: edge.order ?? index,
      tokens: edge.tokensLoaded ?? 0,
    }));
  return { items, tokens: items.reduce((sum, item) => sum + item.tokens, 0) };
}

/** The pipeline fills `userScope.baseline` from the harness's `project: null` load (§2.5). */
function withBaseline(harness: Harness, loadedBy: readonly LoadedByEdge[]): Harness {
  const baseline = sessionLoadOf(
    loadedBy.filter((edge) => edge.to === harness.id),
    null,
  );
  return { ...harness, userScope: { ...harness.userScope, baseline } };
}

function projectOf(
  discovered: DiscoveredProject,
  outputs: readonly AdapterOutput[],
  breadcrumbs: readonly Breadcrumb[],
  entities: readonly Entity[],
  loadedBy: readonly LoadedByEdge[],
  parent: string | null,
): Project {
  const perHarness: Project["perHarness"] = {};
  for (const output of outputs) {
    // D127: an output without a Harness (the shared stores) files no `perHarness` entry.
    if (output.harness === null) continue;
    const harness = output.harness;
    const facts = output.projectFacts.get(discovered.id);
    const harnessEdges = loadedBy.filter((edge) => edge.to === harness.id);
    const sessionLoad = sessionLoadOf(harnessEdges, discovered.id);
    const touched =
      facts !== undefined ||
      sessionLoad.items.length > 0 ||
      breadcrumbs.some(
        (crumb) => crumb.harness === harness.harness && crumb.project === discovered.id,
      );
    if (!touched) continue;
    perHarness[harness.harness] = {
      trusted: facts?.trusted ?? null,
      effectiveSettings: facts?.effectiveSettings ?? {},
      sessionLoad,
    };
  }
  const nestedMarkers = discovered.nestedMarkers
    .map(({ relativePath, marker }) => {
      const entity =
        entities.find(
          (item) => item.project === discovered.id && item.relativePath === relativePath,
        ) ?? null;
      return { relativePath, marker, entity: entity?.id ?? null };
    })
    .toSorted((a, b) => a.relativePath.localeCompare(b.relativePath));
  return {
    id: discovered.id,
    path: discovered.path,
    displayName: discovered.displayName,
    kind: discovered.kind,
    reachability: discovered.reachability,
    unreachableReason: discovered.unreachableReason,
    enclosesCwd: discovered.enclosesCwd,
    discoveredBy: (["breadcrumb", "marker-walk", "cwd"] as const).filter((via) =>
      discovered.discoveredBy.has(via),
    ),
    parent,
    members: discovered.members.map((member) => ({ ...member })),
    breadcrumbs: breadcrumbs
      .filter((crumb) => crumb.project === discovered.id)
      .map((crumb) => crumb.id),
    nestedMarkers,
    perHarness,
  };
}

export async function scan(options: ScanOptions): Promise<Index> {
  const started = Date.now();
  const now = options.now ?? new Date();
  const platform = assertScanPlatform(options.platform);
  const identity = pathIdentity(platform);
  const home = await realpathOrSelf(resolve(options.home));
  const roots = await Promise.all(options.roots.map((root) => realpathOrSelf(resolve(root))));
  const cwd = await realpathOrSelf(resolve(options.cwd));
  const resolved: ResolvedOptions = {
    home,
    roots,
    cwd,
    platform,
    env: options.env,
    git: options.git ?? true,
    now,
    isProcessAlive: options.isProcessAlive ?? processIsAlive,
  };
  // Discovery is built before the context it warns through, so both share one collector (D36).
  const warnings: Warning[] = [];
  const discovery = createDiscovery({
    home,
    roots,
    cwd,
    platform,
    identity,
    statDeadlineMs: STAT_DEADLINE_MS,
    warn: (item) => warnings.push(item),
  });
  const gitLookup: GitLookup = { repos: new Map() };
  const tokenizer = await loadTokenizer();
  const ctx = createContext(resolved, identity, tokenizer, discovery, gitLookup, warnings);
  if (tokenizer.fallbackUsed) {
    ctx.warn(
      warning(
        "tokenizer-fallback",
        "gpt-tokenizer could not be loaded: token counts use bytes/4",
        null,
        null,
        "degraded",
      ),
    );
  }

  const wanted = options.harnesses ?? Object.keys(ADAPTERS);
  const adapters = wanted
    .map((id) => ADAPTERS[id]?.())
    .filter((adapter): adapter is Adapter => adapter !== undefined);

  for (const adapter of adapters) await adapter.discover(ctx);
  await discovery.walkRoots();
  await discovery.includeCwd();
  // D28: everything located before its Project existed gets a second chance now.
  await discovery.refold();

  let gitAvailable = false;
  let gitVersionText: string | null = null;
  if (resolved.git) {
    gitVersionText = await gitVersion();
    gitAvailable = gitVersionText !== null;
    if (!gitAvailable) {
      ctx.warn(
        warning(
          "git-missing",
          "git is not available: git-tracked status unknown",
          null,
          null,
          "degraded",
        ),
      );
    } else {
      const dirs = discovery
        .projects()
        .filter(
          (project) => project.reachability === "present" && project.kind !== "plain-directory",
        )
        .flatMap((project) =>
          project.members
            .filter((member) => member.reachability === "present")
            .map((member) => member.path),
        );
      await Promise.all(
        dirs.map(async (dir) => {
          const result = await repoGitStatus(dir);
          const status: RepoGitStatus | null = result.ok ? result.status : null;
          gitLookup.repos.set(identity.fold(dir), status);
          if (!result.ok) {
            ctx.warn(
              warning(
                "git-missing",
                `git could not list ${dir}: ${result.error}`,
                null,
                dir,
                "partial",
              ),
            );
          }
        }),
      );
    }
  } else {
    ctx.warn(
      warning(
        "git-missing",
        "git not run (git: false): git-tracked status unknown",
        null,
        null,
        "degraded",
      ),
    );
  }

  const outputs: AdapterOutput[] = [];
  for (const adapter of adapters) outputs.push(await adapter.collect(ctx));
  if (tokenizer.fallbackUsed && !ctx.warnings.some((item) => item.code === "tokenizer-fallback")) {
    ctx.warn(
      warning("tokenizer-fallback", "a token count fell back to bytes/4", null, null, "degraded"),
    );
  }

  // D38: one entity per real thing, whatever number of adapters saw it.
  const { entities, edges } = mergeOutputs(outputs, identity.fold);
  const breadcrumbs = outputs.flatMap((output) => output.breadcrumbs).toSorted(byId);
  const loadedBy = edges.filter((edge): edge is LoadedByEdge => edge.kind === "loaded-by");
  const harnesses: Harness[] = outputs
    .map((output) => output.harness)
    .filter((harness): harness is Harness => harness !== null)
    .map((harness) => withBaseline(harness, loadedBy))
    .toSorted(byId);
  const discovered = discovery.projects();
  const projects = discovered.map((project) =>
    projectOf(
      project,
      outputs,
      breadcrumbs,
      entities,
      loadedBy,
      parentIdOf(project, discovered, identity.fold),
    ),
  );

  const totals = {
    entities: entities.length,
    files: entities.reduce((sum, entity) => sum + (entity.metrics.files ?? 0), 0),
    bytes: entities.reduce((sum, entity) => sum + entity.metrics.bytes, 0),
    harnessCacheBytes: entities
      .filter((entity) => entity.kind === "harness-cache")
      .reduce((sum, entity) => sum + entity.metrics.bytes, 0),
    memoryBytes: entities
      .filter((entity) => entity.kind === "memory-file")
      .reduce((sum, entity) => sum + entity.metrics.bytes, 0),
    tokens: entities.reduce((sum, entity) => sum + (entity.metrics.tokens?.o200k ?? 0), 0),
  };

  return {
    schemaVersion: 0,
    generatedAt: now.toISOString(),
    moldig: { version: await moldigVersion() },
    scan: {
      home,
      roots,
      cwd,
      platform,
      caseFold: identity.caseFold,
      env: ctx.envConsulted,
      git: { available: gitAvailable, version: gitVersionText },
      durationMs: Date.now() - started,
    },
    tokenizer: {
      name: tokenizer.name,
      version: tokenizer.version,
      encoding: tokenizer.encoding,
      fallbackUsed: tokenizer.fallbackUsed,
      multipliers: { ...MULTIPLIERS },
    },
    harnesses,
    projects,
    breadcrumbs,
    entities,
    edges,
    warnings: ctx.warnings,
    totals,
  };
}
