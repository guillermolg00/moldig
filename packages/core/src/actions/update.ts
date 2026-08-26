/**
 * The Update preview (14 §2, D92): the upstream `SKILL.md` from GitHub raw and the file list
 * from the trees API, unauthenticated, 5 s timeout, any failure degrading to "upstream
 * unreachable" with the command still shown. The network arrives as an injected fetcher —
 * this is the only place in moldig that reaches the network, and only when asked.
 */
import type { Origin } from "../index/types.js";

export const UPDATE_PREVIEW_TIMEOUT_MS = 5000;

export interface UpdateFetchers {
  /** `null` for any transport failure; the implementation enforces the timeout. */
  fetchText: (
    url: string,
    options: { timeoutMs: number },
  ) => Promise<{ status: number; text: string } | null>;
}

export interface InstalledCopy {
  skillMd: string | null;
  /** Paths relative to the skill directory, as the upstream tree lists them. */
  files: string[];
}

export interface UpdatePreview {
  status: "ready" | "unreachable" | "unsupported";
  reason: string | null;
  upstream: { skillMd: string | null; files: string[] } | null;
  /** Files the upstream adds or drops; null without an installed listing to compare against. */
  changed: { added: string[]; removed: string[] } | null;
}

const UNREACHABLE = "upstream unreachable";

interface Repo {
  owner: string;
  repo: string;
}

/** `https://github.com/<owner>/<repo>[/…]`, `git@github.com:<owner>/<repo>.git`. */
function repoOf(sourceUrl: string | null): Repo | null {
  if (sourceUrl === null) return null;
  const ssh = /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/u.exec(sourceUrl);
  if (ssh?.[1] !== undefined && ssh[2] !== undefined) return { owner: ssh[1], repo: ssh[2] };
  const https = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?].*)?$/u.exec(
    sourceUrl,
  );
  if (https?.[1] !== undefined && https[2] !== undefined)
    return { owner: https[1], repo: https[2] };
  return null;
}

function trimSlashes(path: string): string {
  return path.replaceAll(/^\/+|\/+$/gu, "");
}

/** The trees API answers with `{tree: [{path, type}]}`; only blobs under the skill path count. */
function filesFrom(text: string, skillPath: string): string[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const tree = (parsed as { tree?: unknown }).tree;
  if (!Array.isArray(tree)) return null;
  const prefix = skillPath === "" ? "" : `${skillPath}/`;
  const out: string[] = [];
  for (const item of tree) {
    if (typeof item !== "object" || item === null) continue;
    if (!("path" in item) || !("type" in item)) continue;
    const { path, type } = item;
    if (type !== "blob" || typeof path !== "string") continue;
    if (prefix !== "" && !path.startsWith(prefix)) continue;
    out.push(path.slice(prefix.length));
  }
  return out.toSorted((a, b) => a.localeCompare(b));
}

/**
 * `updatePreview(origin, fetchers)` — pure but for the two injected requests. `ref: null` asks
 * for `HEAD`, which the API resolves to the repository's default branch (D92).
 */
export async function updatePreview(
  origin: Origin,
  fetchers: UpdateFetchers,
  installed: InstalledCopy | null = null,
): Promise<UpdatePreview> {
  if (origin.sourceType !== "github") {
    return {
      status: "unsupported",
      reason: "moldig previews GitHub origins only; the command is shown",
      upstream: null,
      changed: null,
    };
  }
  const repo = repoOf(origin.sourceUrl ?? origin.source);
  if (repo === null) {
    return { status: "unreachable", reason: UNREACHABLE, upstream: null, changed: null };
  }
  const ref = origin.ref ?? "HEAD";
  const skillPath = trimSlashes(origin.skillPath ?? "");
  const suffix = skillPath === "" ? "" : `${skillPath}/`;
  const options = { timeoutMs: UPDATE_PREVIEW_TIMEOUT_MS };
  const [raw, trees] = await Promise.all([
    fetchers.fetchText(
      `https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/${ref}/${suffix}SKILL.md`,
      options,
    ),
    fetchers.fetchText(
      `https://api.github.com/repos/${repo.owner}/${repo.repo}/git/trees/${ref}?recursive=1`,
      options,
    ),
  ]);
  const skillMd = raw !== null && raw.status === 200 ? raw.text : null;
  const files = trees !== null && trees.status === 200 ? filesFrom(trees.text, skillPath) : null;
  if (skillMd === null && files === null) {
    return { status: "unreachable", reason: UNREACHABLE, upstream: null, changed: null };
  }
  const changed =
    files === null || installed === null
      ? null
      : {
          added: files.filter((file) => !installed.files.includes(file)),
          removed: installed.files.filter((file) => !files.includes(file)),
        };
  return {
    status: "ready",
    reason: skillMd === null || files === null ? "part of the upstream is unreachable" : null,
    upstream: { skillMd, files: files ?? [] },
    changed,
  };
}
