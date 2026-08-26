export type Runner = {
  id: string;
  token: string;
};

export type Command = {
  id: string;
  token: string;
  label: string;
  headline: string;
  blurb: string;
};

export const RUNNERS: Runner[] = [
  { id: "npx", token: "npx" },
  { id: "bunx", token: "bunx" },
  { id: "pnpm", token: "pnpm dlx" },
  { id: "yarn", token: "yarn dlx" },
];

export const COMMANDS: Command[] = [
  {
    id: "interactive",
    token: "",
    label: "interactive",
    headline: "The whole thing, as a terminal experience.",
    blurb:
      "An overview, the projects, the items in each, a dependency graph of what names what, a selection panel, and a confirmation before anything moves.",
  },
  {
    id: "scan",
    token: "scan",
    label: "scan",
    headline: "Everything the six harnesses left, in one table.",
    blurb:
      "Skills, MCP servers, context files, memories, plugins and cache, across every project on the machine. Read-only, and --json when a script is reading instead of you.",
  },
  {
    id: "audit",
    token: "audit",
    label: "audit",
    headline: "What every session costs you, and what is worth fixing.",
    blurb:
      "The headline number in tokens, then the findings by severity: duplicates, orphans, bloat, drift, shadow memory, cache and exposed secrets. Exits 1 when something needs you, so CI can run it as it is.",
  },
  {
    id: "clean",
    token: "clean",
    label: "clean",
    headline: "Remove what you select, and nothing else.",
    blurb:
      "Every removal is recoverable: the system trash, a backup before any edit, or the harness's own command. Unattended it needs --yes and a filter, on purpose.",
  },
];
