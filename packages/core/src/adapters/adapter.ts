/**
 * The adapter contract: one module per harness, read-only, run by `scan` in two phases —
 * `discover` resolves the harness's breadcrumbs so Projects exist before git runs, `collect`
 * emits the harness, its breadcrumbs, entities and edges into index v0.
 */
import type { Breadcrumb, Edge, Entity, Harness, HarnessId } from "../index/types.js";
import type { ScanContext } from "../scan/context.js";

export interface ProjectFacts {
  trusted: boolean | null;
  effectiveSettings: Record<string, unknown>;
}

export interface AdapterOutput {
  harness: Harness;
  breadcrumbs: Breadcrumb[];
  entities: Entity[];
  edges: Edge[];
  /** Per Project id: the trust and project + local settings layers this harness sees. */
  projectFacts: Map<string, ProjectFacts>;
}

export interface Adapter {
  readonly id: HarnessId;
  discover(ctx: ScanContext): Promise<void>;
  collect(ctx: ScanContext): Promise<AdapterOutput>;
}
