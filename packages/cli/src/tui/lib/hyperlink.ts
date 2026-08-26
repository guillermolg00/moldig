/**
 * OSC 8 hyperlinks on the paths the TUI prints.
 *
 * Detection is written by hand in the spirit of `supports-hyperlinks`, plus the two cases it
 * misses: Warp (`TERM_PROGRAM=WarpTerminal`) and tmux (which re-emits OSC 8 to an outer
 * terminal that has the `hyperlinks` feature). Terminal.app never gets links.
 */
import { hostname } from "node:os";

export type Env = Readonly<Record<string, string | undefined>>;

const LINKING_PROGRAMS = new Set([
  "iTerm.app",
  "WezTerm",
  "vscode",
  "ghostty",
  "WarpTerminal",
  "zed",
]);

export function supportsHyperlinks(env: Env, isTTY: boolean): boolean {
  if (env["FORCE_HYPERLINK"] === "1") return true;
  if (env["FORCE_HYPERLINK"] === "0") return false;
  if (!isTTY) return false;
  const program = env["TERM_PROGRAM"] ?? "";
  if (program === "Apple_Terminal") return false;
  if (LINKING_PROGRAMS.has(program)) return true;
  // tmux >= 3.2 re-emits OSC 8 when the outer terminal has the `hyperlinks` feature.
  if (env["TMUX"]) return true;
  if (Number(env["VTE_VERSION"] ?? "0") >= 5000) return true;
  const term = env["TERM"] ?? "";
  if (term === "alacritty" || term === "xterm-kitty") return true;
  // Windows Terminal >= 1.4 (Ctrl+click).
  if (env["WT_SESSION"]) return true;
  return false;
}

/** D131: the modifier the hint names follows the platform the scan recorded. */
export function clickHint(platform: string): string {
  return platform === "darwin" ? "cmd+click" : "ctrl+click";
}

/** `file://<hostname>/abs/path` — the spec wants the hostname filled. */
export function fileUrl(absolutePath: string, platform: string, host = hostname()): string {
  const posix = platform === "win32" ? `/${absolutePath.replaceAll("\\", "/")}` : absolutePath;
  const encoded = posix
    .split("/")
    .map((segment) => encodeURIComponent(segment).replaceAll("%3A", ":"))
    .join("/");
  return `file://${host}${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}

// OSC 8 ; ; URI ST … OSC 8 ; ; ST — ST is the terminator the spec encourages. No `id=`
// parameter and no `#line` fragment in v1.
const OSC = "]8;;";
const ST = "\\";

export function osc8(text: string, url: string): string {
  return `${OSC}${url}${ST}${text}${OSC}${ST}`;
}
