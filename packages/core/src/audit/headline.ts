/**
 * §7.10 focus and headline [D39; D77; D86]. The headline is the one number a report opens with:
 * what every session of a harness pays whatever the Project (`baseline`), what the focused
 * Project adds on top (`project`), and the two together — each in the low/mid/high range of its
 * model family. Its scope is `user-controllable`: context files, rules, imports, the loaded slice
 * of a memory index and skill descriptions. Never an agent definition [D39], never the harness's
 * own system prompt, environment info or tool schemas.
 *
 * Only harnesses with `presence: "installed"` are listed [D77], and `contextWindowTokens` is
 * filled from the shipped catalogue for Claude Code alone in v1, so `pctOfContext` is `null`
 * everywhere else [D86].
 */
import type { Headline, Index, Project, TokenRange } from "../index/types.js";
import { addRanges, applyMultiplier, multiplierFor } from "../tokens/tokenizer.js";

/** The sum of what a session started in this Project adds, across every harness that knows it. */
function costOf(project: Project): number {
  return Object.values(project.perHarness).reduce(
    (sum, entry) => sum + (entry?.sessionLoad.tokens ?? 0),
    0,
  );
}

/**
 * Gone and unreachable Projects are never focused: nothing a session pays can be attributed to a
 * directory that is not there. An explicit `focus` that does not enclose cwd is `most-expensive`.
 */
export function focusOf(index: Index, focusId: string | undefined): Headline["focus"] {
  const present = index.projects.filter((project) => project.reachability === "present");
  if (focusId !== undefined) {
    const chosen = present.find((project) => project.id === focusId);
    if (chosen !== undefined)
      return { project: chosen.id, reason: chosen.enclosesCwd ? "cwd" : "most-expensive" };
  }
  const enclosing = present.find((project) => project.enclosesCwd);
  if (enclosing !== undefined) return { project: enclosing.id, reason: "cwd" };
  const most = present.toSorted(
    (a, b) => costOf(b) - costOf(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )[0];
  return most === undefined
    ? { project: null, reason: "none" }
    : { project: most.id, reason: "most-expensive" };
}

export function headlineOf(index: Index, focusId: string | undefined): Headline {
  const focus = focusOf(index, focusId);
  const focused =
    focus.project === null
      ? undefined
      : index.projects.find((project) => project.id === focus.project);
  const perHarness: Headline["perHarness"] = index.harnesses
    .filter((harness) => harness.presence === "installed")
    .map((harness) => {
      const multiplier = multiplierFor(harness.modelFamily);
      const baseline: TokenRange = applyMultiplier(harness.userScope.baseline.tokens, multiplier);
      const projectTokens = focused?.perHarness[harness.harness]?.sessionLoad.tokens ?? 0;
      const project: TokenRange = applyMultiplier(projectTokens, multiplier);
      const total = addRanges(baseline, project);
      return {
        harness: harness.harness,
        modelFamily: harness.modelFamily,
        contextWindowTokens: harness.contextWindowTokens,
        baseline,
        project,
        total,
        pctOfContext:
          harness.contextWindowTokens === null || harness.contextWindowTokens === 0
            ? null
            : Math.round((total.mid / harness.contextWindowTokens) * 1000) / 10,
      };
    });
  return { scope: "user-controllable", focus, perHarness };
}
