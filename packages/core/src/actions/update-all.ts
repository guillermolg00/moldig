/** Machine-wide Update all: aggregate real updater invocations, explain everything else. */
import type { AuditIndex, Entity, Locator, McpServer, Plugin } from "../index/types.js";
import { locatorKey } from "./data-dir.js";
import type { Selection, SelectionTarget } from "./types.js";

export type UpdateSubject = "skill" | "plugin" | "mcp-server";
export type UpdateNoticeKind = "managed" | "excluded" | "unsupported";

export interface UpdateNotice {
  readonly key: string;
  readonly subject: UpdateSubject;
  readonly label: string;
  readonly kind: UpdateNoticeKind;
  readonly reason: string;
}

export interface UpdateAllCounts {
  readonly batches: number;
  readonly skillsReady: number;
  readonly pluginsReady: number;
  readonly mcpServersReady: number;
  readonly managed: number;
  readonly excluded: number;
  readonly unsupported: number;
}

export interface UpdateAllSelection {
  readonly selection: Selection;
  readonly notices: readonly UpdateNotice[];
  readonly counts: UpdateAllCounts;
}

export type McpUpdateVerdict =
  | {
      readonly kind: "docker-image";
      readonly image: string;
      readonly argvPrefix: readonly string[];
      readonly platform: string | null;
    }
  | { readonly kind: UpdateNoticeKind; readonly reason: string };

function basename(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut === -1 ? path : path.slice(cut + 1);
}

function fileOf(locator: Locator): string | null {
  switch (locator.type) {
    case "file":
      return locator.path;
    case "entry":
    case "array-value":
    case "sqlite":
      return locator.file;
    default:
      return null;
  }
}

type Launcher = "node" | "python";
type PackageSpec = { readonly kind: "found"; readonly value: string } | { readonly kind: "unsafe" };
type PackageVersion = "unpinned" | "pinned" | "unsafe";

const NODE_PACKAGE_FLAGS = new Set(["--package", "-p"]);
const NODE_VALUE_FLAGS = new Set(["--call", "-c", "--node-options", "--script-shell", "--cwd"]);
const NODE_BOOLEAN_FLAGS = new Set([
  "-y",
  "--yes",
  "-q",
  "--quiet",
  "--silent",
  "--verbose",
  "--no-install",
  "--ignore-existing",
  "--bun",
]);
const PYTHON_PACKAGE_FLAGS = new Set(["--from"]);
const PYTHON_VALUE_FLAGS = new Set([
  "--python",
  "--with",
  "--index",
  "--default-index",
  "--index-url",
  "--extra-index-url",
  "--keyring-provider",
  "--directory",
]);
const PYTHON_BOOLEAN_FLAGS = new Set([
  "--isolated",
  "--no-cache",
  "--offline",
  "--refresh",
  "--no-progress",
  "--native-tls",
  "--no-native-tls",
]);
const PYTHON_PINNING_FLAGS = new Set(["--constraint", "-c", "--override"]);

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}

function inlineFlag(arg: string, flags: ReadonlySet<string>): [string, string] | null {
  for (const flag of flags) {
    if (arg.startsWith(`${flag}=`)) return [flag, arg.slice(flag.length + 1)];
  }
  return null;
}

function packageSpec(args: readonly string[], launcher: Launcher): PackageSpec {
  const packageFlags = launcher === "node" ? NODE_PACKAGE_FLAGS : PYTHON_PACKAGE_FLAGS;
  const valueFlags = launcher === "node" ? NODE_VALUE_FLAGS : PYTHON_VALUE_FLAGS;
  const booleanFlags = launcher === "node" ? NODE_BOOLEAN_FLAGS : PYTHON_BOOLEAN_FLAGS;
  let explicit: string | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const packageInline = inlineFlag(arg, packageFlags);
    if (packageInline !== null) {
      if (packageInline[1] === "") return { kind: "unsafe" };
      explicit = packageInline[1];
      continue;
    }
    if (packageFlags.has(arg)) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return { kind: "unsafe" };
      explicit = value;
      index += 1;
      continue;
    }
    const valueInline = inlineFlag(arg, valueFlags);
    if (valueInline !== null) {
      if (valueInline[1] === "") return { kind: "unsafe" };
      continue;
    }
    if (valueFlags.has(arg)) {
      if (args[index + 1] === undefined) return { kind: "unsafe" };
      index += 1;
      continue;
    }
    if (launcher === "python") {
      if (PYTHON_PINNING_FLAGS.has(arg) || inlineFlag(arg, PYTHON_PINNING_FLAGS) !== null) {
        return { kind: "unsafe" };
      }
    }
    if (booleanFlags.has(arg)) continue;
    if (arg === "--") {
      return explicit === null ? { kind: "unsafe" } : { kind: "found", value: explicit };
    }
    if (arg.startsWith("-")) return { kind: "unsafe" };
    return { kind: "found", value: explicit ?? arg };
  }
  return explicit === null ? { kind: "unsafe" } : { kind: "found", value: explicit };
}

const NODE_PACKAGE =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/[A-Za-z0-9][A-Za-z0-9._~-]*|[A-Za-z0-9][A-Za-z0-9._~-]*)(?:@([^@/\s]+))?$/u;
const PYTHON_PACKAGE = "[A-Za-z0-9][A-Za-z0-9._-]*(?:\\[[A-Za-z0-9._,-]+\\])?";
const PYTHON_UNPINNED = new RegExp(`^${PYTHON_PACKAGE}$`, "u");
const PYTHON_PINNED = new RegExp(
  `^${PYTHON_PACKAGE}(?:(?:===|==|~=|!=|<=|>=|<|>).+|@[^\\s]+|\\s+@\\s+[^\\s]+)$`,
  "u",
);

function packageVersion(spec: string, launcher: Launcher): PackageVersion {
  if (spec === "<redacted>" || spec.includes("${") || hasControlCharacter(spec)) {
    return "unsafe";
  }
  if (launcher === "node") {
    const matched = NODE_PACKAGE.exec(spec);
    if (matched === null) return "unsafe";
    const version = matched[1];
    return version === undefined || version === "latest" ? "unpinned" : "pinned";
  }
  if (PYTHON_UNPINNED.test(spec)) return "unpinned";
  if (PYTHON_PINNED.test(spec)) return "pinned";
  return "unsafe";
}

function launcherVerdict(server: McpServer, launcher: Launcher): McpUpdateVerdict {
  if (server.usesInterpolation) {
    return { kind: "unsupported", reason: "the launcher package uses runtime interpolation" };
  }
  const parsed = packageSpec(server.args, launcher);
  if (parsed.kind === "unsafe") {
    return { kind: "unsupported", reason: "the launcher package cannot be identified safely" };
  }
  const version = packageVersion(parsed.value, launcher);
  if (version === "unsafe") {
    return { kind: "unsupported", reason: "the launcher package cannot be identified safely" };
  }
  if (version === "pinned") {
    return {
      kind: "excluded",
      reason:
        "the launcher package is pinned in the MCP configuration; Update all never rewrites that pin",
    };
  }
  return {
    kind: "managed",
    reason:
      "the package is resolved by its ephemeral launcher when the server starts; there is no separate safe update command",
  };
}

const DOCKER_GLOBAL_VALUE_OPTIONS = new Set([
  "--config",
  "--context",
  "-c",
  "--host",
  "-H",
  "--log-level",
  "-l",
  "--tlscacert",
  "--tlscert",
  "--tlskey",
]);
const DOCKER_GLOBAL_BOOLEAN_OPTIONS = new Set(["--debug", "-D", "--tls", "--tlsverify"]);

const DOCKER_VALUE_OPTIONS = new Set([
  "--add-host",
  "--annotation",
  "--attach",
  "-a",
  "--cap-add",
  "--cap-drop",
  "--device",
  "--dns",
  "--entrypoint",
  "--env",
  "-e",
  "--env-file",
  "--gpus",
  "--group-add",
  "--hostname",
  "-h",
  "--label",
  "-l",
  "--mount",
  "--name",
  "--network",
  "--platform",
  "--publish",
  "-p",
  "--pull",
  "--restart",
  "--runtime",
  "--security-opt",
  "--shm-size",
  "--tmpfs",
  "--ulimit",
  "--user",
  "-u",
  "--volume",
  "-v",
  "--workdir",
  "-w",
]);

const DOCKER_BOOLEAN_OPTIONS = new Set([
  "--detach",
  "-d",
  "--init",
  "--interactive",
  "-i",
  "--privileged",
  "--read-only",
  "--remove-orphans",
  "--rm",
  "--tty",
  "-t",
  "-it",
  "-ti",
]);

interface DockerTarget {
  readonly image: string;
  readonly argvPrefix: readonly string[];
  readonly platform: string | null;
}

const DOCKER_IMAGE =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[A-Fa-f0-9]{64})?$/u;
const DOCKER_PLATFORM = /^[A-Za-z0-9_./-]+$/u;

function safeOptionValue(value: string): boolean {
  if (
    value === "" ||
    value === "<redacted>" ||
    value.includes("${") ||
    hasControlCharacter(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.username === "" && parsed.password === "";
  } catch {
    return true;
  }
}

function dockerCommand(command: string | null): string | null {
  if (command === null || command === "<redacted>") return null;
  const name = command.toLowerCase();
  // Trust only the Docker command resolved through the caller's PATH. An MCP configuration must
  // never choose an arbitrary executable merely because its basename is `docker`.
  return name === "docker" || name === "docker.exe" ? command : null;
}

function dockerTarget(server: McpServer): DockerTarget | null {
  if (server.usesInterpolation) return null;
  const command = dockerCommand(server.command);
  if (command === null) return null;

  const argvPrefix = [command];
  let run = -1;
  for (let index = 0; index < server.args.length; index += 1) {
    const arg = server.args[index] ?? "";
    if (arg === "run") {
      run = index;
      break;
    }
    const inline = inlineFlag(arg, DOCKER_GLOBAL_VALUE_OPTIONS);
    if (inline !== null) {
      if (!safeOptionValue(inline[1])) return null;
      argvPrefix.push(arg);
      continue;
    }
    if (DOCKER_GLOBAL_VALUE_OPTIONS.has(arg)) {
      const value = server.args[index + 1];
      if (value === undefined || !safeOptionValue(value)) return null;
      argvPrefix.push(arg, value);
      index += 1;
      continue;
    }
    if (DOCKER_GLOBAL_BOOLEAN_OPTIONS.has(arg)) {
      argvPrefix.push(arg);
      continue;
    }
    return null;
  }
  if (run === -1) return null;

  let platform: string | null = null;
  for (let index = run + 1; index < server.args.length; index += 1) {
    const arg = server.args[index] ?? "";
    if (arg === "--platform") {
      const value = server.args[index + 1];
      if (value === undefined || !DOCKER_PLATFORM.test(value)) return null;
      platform = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--platform=")) {
      const value = arg.slice("--platform=".length);
      if (!DOCKER_PLATFORM.test(value)) return null;
      platform = value;
      continue;
    }
    const valueInline = inlineFlag(arg, DOCKER_VALUE_OPTIONS);
    if (valueInline !== null) {
      if (valueInline[1] === "") return null;
      continue;
    }
    if (DOCKER_VALUE_OPTIONS.has(arg)) {
      if (server.args[index + 1] === undefined) return null;
      index += 1;
      continue;
    }
    if (DOCKER_BOOLEAN_OPTIONS.has(arg)) continue;
    if (arg.startsWith("-")) return null;
    if (!DOCKER_IMAGE.test(arg)) return null;
    return { image: arg, argvPrefix, platform };
  }
  return null;
}

/** Conservative: an Update must not launch the MCP server or rewrite its configuration. */
export function mcpUpdateVerdict(server: McpServer): McpUpdateVerdict {
  if (server.transport !== "stdio") {
    return { kind: "managed", reason: "the remote server is updated by its operator" };
  }
  const executable = server.command === null ? "" : basename(server.command).toLowerCase();
  const command = executable.replace(/\.(?:cmd|exe)$/u, "");
  if (command === "npx" || command === "bunx" || command === "pnpx") {
    return launcherVerdict(server, "node");
  }
  if (command === "npm" && server.args[0] === "exec") {
    return launcherVerdict({ ...server, args: server.args.slice(1) }, "node");
  }
  if (command === "pnpm" && server.args[0] === "dlx") {
    return launcherVerdict({ ...server, args: server.args.slice(1) }, "node");
  }
  if (command === "uvx") return launcherVerdict(server, "python");
  if (command === "uv" && server.args[0] === "tool" && server.args[1] === "run") {
    return launcherVerdict({ ...server, args: server.args.slice(2) }, "python");
  }
  if (command === "docker") {
    const target = dockerTarget(server);
    if (target === null) {
      return { kind: "unsupported", reason: "the docker image cannot be identified safely" };
    }
    if (target.image.includes("@sha256:")) {
      return {
        kind: "excluded",
        reason:
          "the Docker image is pinned by digest; updating it would require rewriting the configuration",
      };
    }
    return { kind: "docker-image", ...target };
  }
  return {
    kind: "unsupported",
    reason: "no non-destructive updater is known for this command",
  };
}

interface SkillBatch {
  readonly lock: Locator;
  readonly scope: "global" | "project";
  readonly project: string | null;
  readonly names: Set<string>;
}

interface DockerBatch {
  readonly image: string;
  readonly argvPrefix: readonly string[];
  readonly platform: string | null;
  readonly locator: Locator;
  readonly ids: string[];
}

function parentPluginOf(index: AuditIndex, entityId: string): Plugin | null {
  const parent = index.edges.find((edge) => edge.kind === "provided-by" && edge.from === entityId);
  if (parent === undefined) return null;
  const entity = index.entities.find((candidate) => candidate.id === parent.to);
  return entity?.kind === "plugin" ? entity : null;
}

const INSTALLER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function safeSkillName(name: string): boolean {
  return INSTALLER_NAME.test(name);
}

function pluginUpdateIssue(plugin: Plugin): string | null {
  const installer = plugin.origin?.installer;
  if (installer !== "claude-plugin" && installer !== "gemini-extension") {
    return "no supported Installer was recorded";
  }
  if (installer === "gemini-extension") {
    return INSTALLER_NAME.test(plugin.pluginId)
      ? null
      : "the extension identifier cannot be passed to its Installer safely";
  }
  const at = plugin.pluginId.lastIndexOf("@");
  const name = at === -1 ? "" : plugin.pluginId.slice(0, at);
  const marketplace = at === -1 ? "" : plugin.pluginId.slice(at + 1);
  return INSTALLER_NAME.test(name) && INSTALLER_NAME.test(marketplace)
    ? null
    : "the plugin identifier cannot be passed to its Installer safely";
}

function blockedPlugins(index: AuditIndex): ReadonlySet<string> {
  const blocked = new Set<string>();
  for (const entity of index.entities) {
    if (
      entity.kind !== "skill" ||
      (entity.drift !== "local-modified" && entity.drift !== "copies-differ")
    ) {
      continue;
    }
    const parent = parentPluginOf(index, entity.id);
    if (parent !== null) blocked.add(parent.id);
  }
  return blocked;
}

function parentUpdateNotice(
  notices: UpdateNotice[],
  entity: Entity,
  subject: UpdateSubject,
  parent: Plugin,
  blocked: ReadonlySet<string>,
): void {
  if (blocked.has(parent.id)) {
    notice(
      notices,
      entity,
      subject,
      "excluded",
      `parent plugin ${parent.label} is excluded because one of its Skills is locally modified or divergent`,
    );
    return;
  }
  const issue = pluginUpdateIssue(parent);
  notice(
    notices,
    entity,
    subject,
    issue === null ? "managed" : "unsupported",
    issue === null
      ? `updated with parent plugin ${parent.label}`
      : `parent plugin ${parent.label}: ${issue}`,
  );
}

function notice(
  notices: UpdateNotice[],
  entity: Entity,
  subject: UpdateSubject,
  kind: UpdateNoticeKind,
  reason: string,
): void {
  notices.push({ key: entity.id, subject, label: entity.label, kind, reason });
}

function projectName(index: AuditIndex, projectId: string | null): string {
  if (projectId === null) return "project";
  return index.projects.find((project) => project.id === projectId)?.displayName ?? "project";
}

export function updateAllSelection(index: AuditIndex): UpdateAllSelection {
  const selection: SelectionTarget[] = [];
  const notices: UpdateNotice[] = [];
  const skills = new Map<string, SkillBatch>();
  const docker = new Map<string, DockerBatch>();
  const selectedPlugins = new Set<string>();
  const blocked = blockedPlugins(index);
  let skillsReady = 0;
  let pluginsReady = 0;
  let mcpServersReady = 0;

  for (const entity of index.entities) {
    if (entity.kind === "skill") {
      if (entity.drift === "local-modified" || entity.drift === "copies-differ") {
        notice(
          notices,
          entity,
          "skill",
          "excluded",
          entity.drift === "local-modified"
            ? "locally modified Skills are excluded from Update all"
            : "copies from the same origin differ; decide which copy to keep first",
        );
        continue;
      }
      const parent = parentPluginOf(index, entity.id);
      if (parent !== null) {
        parentUpdateNotice(notices, entity, "skill", parent, blocked);
        continue;
      }
      if (!safeSkillName(entity.name)) {
        notice(
          notices,
          entity,
          "skill",
          "unsupported",
          "the Skill name cannot be passed to its Installer safely",
        );
        continue;
      }
      if (entity.origin?.installer !== "vercel-skills") {
        notice(
          notices,
          entity,
          "skill",
          "unsupported",
          entity.origin === null
            ? "no Installer origin was recorded"
            : `${entity.origin.installer} has no runnable bulk updater`,
        );
        continue;
      }
      const file = fileOf(entity.origin.lock);
      if (file === null) {
        notice(notices, entity, "skill", "unsupported", "the Installer lock file is unknown");
        continue;
      }
      const scope = file.endsWith("skills-lock.json") ? "project" : "global";
      const key = `${scope}:${file}`;
      const batch = skills.get(key) ?? {
        lock: entity.origin.lock,
        scope,
        project: entity.project,
        names: new Set<string>(),
      };
      batch.names.add(entity.name);
      skills.set(key, batch);
      skillsReady += 1;
      continue;
    }

    if (entity.kind === "plugin") {
      if (blocked.has(entity.id)) {
        notice(
          notices,
          entity,
          "plugin",
          "excluded",
          "the plugin contains a locally modified or divergent Skill",
        );
        continue;
      }
      const issue = pluginUpdateIssue(entity);
      if (issue !== null) {
        notice(notices, entity, "plugin", "unsupported", issue);
        continue;
      }
      if (!selectedPlugins.has(entity.id)) {
        selection.push({ action: "update", id: entity.id });
        selectedPlugins.add(entity.id);
        pluginsReady += 1;
      }
      continue;
    }

    if (entity.kind !== "mcp-server") continue;
    const parent = parentPluginOf(index, entity.id);
    if (parent !== null) {
      parentUpdateNotice(notices, entity, "mcp-server", parent, blocked);
      continue;
    }
    const verdict = mcpUpdateVerdict(entity);
    if (verdict.kind !== "docker-image") {
      notice(notices, entity, "mcp-server", verdict.kind, verdict.reason);
      continue;
    }
    const updaterKey = JSON.stringify([verdict.argvPrefix, verdict.platform, verdict.image]);
    const batch = docker.get(updaterKey) ?? {
      image: verdict.image,
      argvPrefix: verdict.argvPrefix,
      platform: verdict.platform,
      locator: entity.locator,
      ids: [],
    };
    batch.ids.push(entity.id);
    docker.set(updaterKey, batch);
    mcpServersReady += 1;
  }

  for (const [group, batch] of [...skills].toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    const names = [...batch.names].toSorted();
    const label =
      batch.scope === "global"
        ? `Skills · global · ${names.length}`
        : `Skills · ${projectName(index, batch.project)} · ${names.length}`;
    selection.push({
      action: "update",
      project: batch.project,
      updateBatch: {
        kind: "vercel-skills",
        key: `update:skills:${locatorKey(batch.lock)}`,
        label,
        lock: batch.lock,
        scope: batch.scope,
        names,
      },
    });
    void group;
  }

  for (const [, batch] of [...docker].toSorted(([left], [right]) => left.localeCompare(right))) {
    selection.push({
      action: "update",
      updateBatch: {
        kind: "docker-image",
        key: `update:docker:${locatorKey(batch.locator)}`,
        label: `MCP image ${batch.image} · ${batch.ids.length}`,
        locator: batch.locator,
        image: batch.image,
        argvPrefix: batch.argvPrefix,
        platform: batch.platform,
      },
    });
  }

  const managed = notices.filter((item) => item.kind === "managed").length;
  const excluded = notices.filter((item) => item.kind === "excluded").length;
  const unsupported = notices.filter((item) => item.kind === "unsupported").length;
  return {
    selection,
    notices: notices.toSorted(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.subject.localeCompare(right.subject) ||
        left.label.localeCompare(right.label),
    ),
    counts: {
      batches: selection.length,
      skillsReady,
      pluginsReady,
      mcpServersReady,
      managed,
      excluded,
      unsupported,
    },
  };
}
