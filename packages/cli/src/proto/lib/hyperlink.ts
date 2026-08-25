// THROWAWAY PROTOTYPE (ticket 09) — OSC 8 hyperlinks on paths (research 03).
//
// Detection is written by hand in the spirit of `supports-hyperlinks`, plus the two cases
// it misses: Warp (`TERM_PROGRAM=WarpTerminal`) and tmux (which re-emits OSC 8 to an outer
// terminal that has the `hyperlinks` feature). Terminal.app never gets links.
import os from "node:os";

export type Env = Readonly<Record<string, string | undefined>>;

export function supportsHyperlinks(env: Env, isTTY: boolean): boolean {
  if (env["FORCE_HYPERLINK"] === "1") return true;
  if (env["FORCE_HYPERLINK"] === "0") return false;
  if (!isTTY) return false;
  const program = env["TERM_PROGRAM"] ?? "";
  if (program === "Apple_Terminal") return false;
  if (["iTerm.app", "WezTerm", "vscode", "ghostty", "WarpTerminal", "zed"].includes(program)) {
    return true;
  }
  if (env["TMUX"]) return true;
  const vte = Number(env["VTE_VERSION"] ?? "0");
  if (vte >= 5000) return true;
  const term = env["TERM"] ?? "";
  if (term === "alacritty" || term === "xterm-kitty") return true;
  if (env["WT_SESSION"]) return true;
  return false;
}

/** `file://<hostname>/abs/path` — the spec wants the hostname filled (research 03). */
export function fileUrl(absPath: string, platform: string, hostname = os.hostname()): string {
  const posix = platform === "win32" ? `/${absPath.replaceAll("\\", "/")}` : absPath;
  const encoded = posix
    .split("/")
    .map((segment) => encodeURIComponent(segment).replaceAll("%3A", ":"))
    .join("/");
  return `file://${hostname}${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}

// OSC 8 ; ; URI ST … OSC 8 ; ; ST — ST is the terminator the spec encourages.
const OSC = "]8;;";
const ST = "\\";

export function osc8(text: string, url: string): string {
  return `${OSC}${url}${ST}${text}${OSC}${ST}`;
}
