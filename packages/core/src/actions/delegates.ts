/**
 * Delegates: the commands moldig hands to a harness or an Installer. The index carries one
 * human-readable string (`removal.command`, frozen in types.ts); the Plan carries `{argv, cwd}`
 * beside it and no shell is ever spawned (D87). A command moldig cannot express as argv is
 * refused rather than handed to a shell.
 */
import type { Entity, Index, Plugin } from "../index/types.js";

export interface DelegateCommand {
  argv: string[];
  cwd: string | null;
  display: string;
  /** `false` for a command moldig shows and never runs (`git -C <dir> pull`, 14 §2). */
  runnable: boolean;
  permanent: boolean;
  reason: string | null;
}

/** Only `opencode session delete` leaves no way back (08 §3.6); every other delegate is undoable. */
function permanentArgv(argv: readonly string[]): boolean {
  return argv[0] === "opencode" && argv[1] === "session" && argv[2] === "delete";
}

const SHELL_CHARS = new Set(["&", "|", ";", "<", ">", "$", "`", "(", ")", "{", "}", "*", "?"]);

/** Split a command into argv, honouring quotes and refusing anything that needs a shell. */
function tokenise(command: string): string[] | null {
  const argv: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const char of command) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (char === " " || char === "\t") {
      if (started) argv.push(current);
      current = "";
      started = false;
      continue;
    }
    if (SHELL_CHARS.has(char)) return null;
    current += char;
    started = true;
  }
  if (quote !== null) return null;
  if (started) argv.push(current);
  return argv.length === 0 ? null : argv;
}

const CD_PREFIX = /^cd\s+"([^"]+)"\s+&&\s+/u;

/**
 * `removal.command` is one string and the adapters write `cd "<dir>" && claude mcp remove …`
 * for a local-scope entry (the command acts on the entry of the directory it runs in). The
 * engine parses that prefix into `cwd` and never passes it to a shell (spec 08 open item 1).
 */
export function parseDelegate(command: string, fallbackCwd: string | null): DelegateCommand | null {
  const prefix = CD_PREFIX.exec(command);
  const cwd = prefix?.[1] ?? fallbackCwd;
  const rest = prefix === null ? command : command.slice(prefix[0].length);
  const argv = tokenise(rest);
  if (argv === null) return null;
  return {
    argv,
    cwd,
    display: command,
    runnable: true,
    permanent: permanentArgv(argv),
    reason: null,
  };
}

function dirnameOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut <= 0 ? path : path.slice(0, cut);
}

function projectPath(index: Index, projectId: string | null): string | null {
  if (projectId === null) return null;
  return index.projects.find((project) => project.id === projectId)?.path ?? null;
}

/** D93: project and local installs run in the Project directory, everything else in the home. */
function pluginCwd(index: Index, plugin: Plugin, home: string): string {
  for (const install of plugin.installs) {
    if (install.scope !== "project" && install.scope !== "local") continue;
    const path = projectPath(index, install.project);
    if (path !== null) return path;
  }
  return home;
}

function displayOf(argv: string[]): string {
  return argv.join(" ");
}

/**
 * Where a Delete delegate runs (D93): the Project directory for a project or local install,
 * the home directory otherwise. A `cd "<dir>" && …` prefix in `removal.command` wins over it.
 */
export function delegateCwdFor(index: Index, entity: Entity, home: string): string {
  if (entity.kind === "plugin") return pluginCwd(index, entity, home);
  return projectPath(index, entity.project) ?? home;
}

/**
 * The Update delegate per Installer (14 §2; 08 §4.5 table): `npx skills update <name> -g` for a
 * global-lock Skill, `npx skills update <name> -p` in the Project's directory for a project-lock
 * one, `claude plugin update <plugin>@<marketplace>`, `gemini extensions update <name>`, and
 * `git -C <dir> pull` shown and never run. `null` = no Installer recognised, so no Update.
 */
export function updateDelegateFor(
  index: Index,
  entity: Entity,
  home: string,
): DelegateCommand | null {
  if (entity.kind !== "skill" && entity.kind !== "plugin") return null;
  const origin = entity.origin;
  if (origin === null) return null;
  // D42 added `git-clone` to `Origin.installer`; index v0's type union is frozen in types.ts
  // and belongs to another ticket, so the value is read as a string here.
  const installer: string = origin.installer;
  if (installer === "vercel-skills" && entity.kind === "skill") {
    const lockFile = origin.lock.type === "entry" ? origin.lock.file : null;
    const projectLock = lockFile !== null && lockFile.endsWith("skills-lock.json");
    const argv = ["npx", "skills", "update", entity.name, projectLock ? "-p" : "-g"];
    return {
      argv,
      cwd: projectLock && lockFile !== null ? dirnameOf(lockFile) : home,
      display: displayOf(argv),
      runnable: true,
      permanent: false,
      reason: null,
    };
  }
  if (installer === "claude-plugin" && entity.kind === "plugin") {
    const argv = ["claude", "plugin", "update", entity.pluginId];
    return {
      argv,
      cwd: pluginCwd(index, entity, home),
      display: displayOf(argv),
      runnable: true,
      permanent: false,
      reason: null,
    };
  }
  if (installer === "gemini-extension" && entity.kind === "plugin") {
    const argv = ["gemini", "extensions", "update", entity.pluginId];
    return {
      argv,
      cwd: pluginCwd(index, entity, home),
      display: displayOf(argv),
      runnable: true,
      permanent: false,
      reason: null,
    };
  }
  if (installer === "git-clone") {
    const argv = ["git", "-C", entity.path, "pull"];
    return {
      argv,
      cwd: null,
      display: displayOf(argv),
      runnable: false,
      permanent: false,
      reason: "moldig shows this command and never runs it in v1",
    };
  }
  return null;
}
