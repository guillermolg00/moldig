import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import appCss from "../styles/global.css?url";

const TAGLINE =
  "One read-only pass over the skills, MCP servers, context files, memories and cache that AI coding harnesses leave across your projects. See what every session costs you in tokens, and clean only where you say so.";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "moldig: clean up what your AI tools leave behind" },
      { name: "description", content: TAGLINE },
    ],
    links: [{ rel: "stylesheet", href: appCss }],
  }),
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <Nav />
      <Outlet />
    </RootDocument>
  );
}

function Nav() {
  return (
    <header className="border-b border-line dark:border-line-dark">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
        <span className="font-mono text-[17px] font-semibold tracking-tight">moldig</span>
        <a
          className="text-[15px] text-muted transition-colors hover:text-accent dark:text-muted-dark dark:hover:text-accent-dark"
          href="https://github.com/guillermolg00/moldig"
          rel="noreferrer"
        >
          GitHub
        </a>
      </div>
    </header>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className="scheme-light-dark">
      <head>
        <HeadContent />
      </head>
      <body className="bg-canvas text-ink antialiased dark:bg-canvas-dark dark:text-ink-dark">
        {children}
        <Scripts />
      </body>
    </html>
  );
}
