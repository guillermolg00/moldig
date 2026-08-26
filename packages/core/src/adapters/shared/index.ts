/* oxlint-disable no-await-in-loop -- sequential on purpose: bounded, ordered disk IO */
/**
 * The shared-stores adapter (ticket 06 §12–14): the one adapter that is not a harness. It owns
 * every real thing several harnesses share — the canonical skill stores `~/.agents/skills` and
 * `<member>/.agents/skills`, the locks that record what was installed into them, and the
 * `AGENTS.md` files nine readers quote — and emits them with `harness: null` and
 * `AdapterOutput.harness: null` (D127), so it files no `harnesses[]` row and no baseline.
 *
 * It is never selectable through `--harness` (D21): `scan` registers it outside the map that flag
 * filters, and it is registered **first**, which is what makes it the *owner* of a shared entity
 * under D38's merge rule — a harness adapter that also reached the same directory contributes only
 * its Placement and its own `loaded-by` edge.
 *
 * Read-only (ADR-0001): no process is ever spawned — the git tree hash a lock records is
 * recomputed in pure JavaScript (`hashes.ts`), never by shelling out to git.
 */
import { basename, join } from "node:path";
import type { SettingsFile } from "../../index/types.js";
import { warning, type ScanContext } from "../../scan/context.js";
import type { DiscoveredProject } from "../../scan/discovery.js";
import { isFile } from "../../scan/fs.js";
import type { Adapter, AdapterOutput } from "../adapter.js";
import { collectAgentsFiles } from "./agents-md.js";
import { readSkillLock, storeOf, type SkillLock } from "./locks.js";
import { addEntity, baseEntity, type SharedScan } from "./model.js";
import { collectStores, lockFilesOf, storeDirsOf } from "./stores.js";

export { withSharedSkillFacts } from "./duplicates.js";
export { gitTreeSha1, sha256Folder } from "./hashes.js";

/** Not a `HarnessId` moldig scans: `--harness` never selects this adapter (D21). */
const ADAPTER_ID = "shared";

/**
 * D75: `$XDG_STATE_HOME/skills/.skill-lock.json` and `~/.agents/.skill-lock.json` are both read
 * when both exist; the env-var one is listed first, so it wins for a name present in both, and the
 * other still yields its own entity and `originates-from` edges.
 */
async function readUserLocks(ctx: ScanContext, home: string): Promise<SkillLock[]> {
  const xdg = ctx.consultEnv("XDG_STATE_HOME");
  const files = lockFilesOf(home, xdg);
  const out: SkillLock[] = [];
  for (const [index, file] of files.entries()) {
    const lock = await readSkillLock({
      path: file,
      // Only the *lock* moves under `XDG_STATE_HOME`: the store it records stays `~/.agents/skills`.
      store: join(home, ".agents", "skills"),
      scope: "user",
      project: null,
      fromEnv: xdg !== undefined && index === 0,
    });
    if (lock.present) out.push(lock);
  }
  return out;
}

/** Every present member's committed `skills-lock.json` (`version: 1`, meant to be tracked). */
async function readProjectLocks(projects: readonly DiscoveredProject[]): Promise<SkillLock[]> {
  const out: SkillLock[] = [];
  for (const project of projects) {
    if (project.reachability !== "present") continue;
    for (const member of project.members) {
      if (member.reachability !== "present") continue;
      const file = join(member.path, "skills-lock.json");
      const lock = await readSkillLock({
        path: file,
        store: storeOf(file),
        scope: "project",
        project,
      });
      if (lock.present) out.push(lock);
    }
  }
  return out;
}

/**
 * Ticket 06 §13: a lock is a `settings-file` the Delete flow backup-edits and never removes.
 * Its shape is read by field names; a `version` other than the one its file name documents is a
 * `degraded` warning and the entries are still read — never a guess.
 */
async function lockEntity(scan: SharedScan, lock: SkillLock): Promise<void> {
  if (lock.parseError) {
    scan.ctx.warn(
      warning(
        "parse-error",
        `${basename(lock.path)} is not valid JSON`,
        null,
        lock.path,
        "partial",
      ),
    );
  } else if (lock.version !== null && lock.version !== lock.documentedVersion) {
    scan.ctx.warn(
      warning(
        "unsupported-shape",
        `${basename(lock.path)} declares version ${lock.version}; ${lock.documentedVersion} is the documented version of this file — its entries are read by field name`,
        null,
        lock.path,
        "degraded",
      ),
    );
  }
  if (!(await isFile(lock.path))) return;
  const base = baseEntity(scan, {
    kind: "settings-file",
    path: lock.path,
    scope: lock.scope,
    project: lock.project,
    ownership: "human",
    locator: { type: "file", path: lock.path },
    format: "json",
    sensitive: false,
    protection: "never",
    removal: { method: "none" },
    metrics: await scan.ctx.fileMetrics(lock.path, null),
  });
  const entity: SettingsFile = {
    ...base,
    kind: "settings-file",
    role: "skill-lock",
    topLevelKeys: lock.topLevelKeys,
    entries: lock.entries.length,
    hooks: [],
  };
  addEntity(scan, entity);
}

export function createSharedAdapter(): Adapter {
  let scan: SharedScan | null = null;

  return {
    id: ADAPTER_ID,

    async discover(ctx) {
      const home = ctx.options.home;
      scan = {
        ctx,
        home,
        // The global locks are read here: `XDG_STATE_HOME` must land in `scan.env` whether or not
        // any Project turns up later.
        locks: await readUserLocks(ctx, home),
        stores: [],
        entities: new Map(),
        edges: new Map(),
        skills: new Map(),
      };
    },

    async collect(ctx): Promise<AdapterOutput> {
      if (scan === null) throw new Error("discover() must run before collect()");
      scan.locks = [...scan.locks, ...(await readProjectLocks(ctx.discovery.projects()))];
      for (const lock of scan.locks) await lockEntity(scan, lock);
      scan.stores = storeDirsOf(scan);
      await collectStores(scan);
      await collectAgentsFiles(scan);
      return {
        // D127: the stores several harnesses share are nobody's harness.
        harness: null,
        breadcrumbs: [],
        entities: [...scan.entities.values()],
        edges: [...scan.edges.values()],
        projectFacts: new Map(),
      };
    },
  };
}
