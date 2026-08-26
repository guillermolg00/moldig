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
  Edge,
  Entity,
  Harness,
  HarnessId,
  Index,
  LoadedByEdge,
  Project,
  SessionLoad,
} from "../index/types.js";
import { loadTokenizer, MULTIPLIERS } from "../tokens/tokenizer.js";
import { createContext, warning, type GitLookup, type ResolvedOptions } from "./context.js";
import { createDiscovery, type DiscoveredProject } from "./discovery.js";
import { isFile, isRecord, readText, realpathOrSelf } from "./fs.js";
import { pathIdentity } from "./paths.js";

export interface ScanOptions {
  home: string;
  roots: readonly string[];
  cwd: string;
  platform: NodeJS.Platform;
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

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const STAT_DEADLINE_MS = 2000;

const ADAPTERS: Record<string, () => Adapter> = {
  "claude-code": createClaudeCodeAdapter,
};

function byId<T extends { id: string }>(a: T, b: T): number {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function edgeOrder(a: Edge, b: Edge): number {
  return (
    a.kind.localeCompare(b.kind) ||
    (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
    ((a.to ?? "") < (b.to ?? "") ? -1 : (a.to ?? "") > (b.to ?? "") ? 1 : 0) ||
    byId(a, b)
  );
}

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

function projectOf(
  discovered: DiscoveredProject,
  outputs: readonly AdapterOutput[],
  breadcrumbs: readonly Breadcrumb[],
  entities: readonly Entity[],
  loadedBy: readonly LoadedByEdge[],
): Project {
  const perHarness: Project["perHarness"] = {};
  for (const output of outputs) {
    const facts = output.projectFacts.get(discovered.id);
    const harnessEdges = loadedBy.filter((edge) => edge.to === output.harness.id);
    const sessionLoad = sessionLoadOf(harnessEdges, discovered.id);
    const touched =
      facts !== undefined ||
      sessionLoad.items.length > 0 ||
      breadcrumbs.some(
        (crumb) => crumb.harness === output.harness.harness && crumb.project === discovered.id,
      );
    if (!touched) continue;
    perHarness[output.harness.harness] = {
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
    parent: null,
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
  const identity = pathIdentity(options.platform);
  const home = await realpathOrSelf(resolve(options.home));
  const roots = await Promise.all(options.roots.map((root) => realpathOrSelf(resolve(root))));
  const cwd = await realpathOrSelf(resolve(options.cwd));
  const resolved: ResolvedOptions = {
    home,
    roots,
    cwd,
    platform: options.platform,
    env: options.env,
    git: options.git ?? true,
    now,
    isProcessAlive: options.isProcessAlive ?? processIsAlive,
  };
  const discovery = createDiscovery({
    home,
    roots,
    cwd,
    platform: options.platform,
    identity,
    statDeadlineMs: STAT_DEADLINE_MS,
  });
  const gitLookup: GitLookup = { repos: new Map() };
  const tokenizer = await loadTokenizer();
  const ctx = createContext(resolved, identity, tokenizer, discovery, gitLookup);
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

  const entities = outputs.flatMap((output) => output.entities).toSorted(byId);
  const edges = outputs.flatMap((output) => output.edges).toSorted(edgeOrder);
  const breadcrumbs = outputs.flatMap((output) => output.breadcrumbs).toSorted(byId);
  const loadedBy = edges.filter((edge): edge is LoadedByEdge => edge.kind === "loaded-by");
  const harnesses: Harness[] = outputs
    .map((output) => ({
      ...output.harness,
      userScope: {
        ...output.harness.userScope,
        baseline: sessionLoadOf(
          loadedBy.filter((edge) => edge.to === output.harness.id),
          null,
        ),
      },
    }))
    .toSorted(byId);
  const projects = discovery
    .projects()
    .map((discovered) => projectOf(discovered, outputs, breadcrumbs, entities, loadedBy));

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
      platform:
        options.platform === "win32" ? "win32" : options.platform === "linux" ? "linux" : "darwin",
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
