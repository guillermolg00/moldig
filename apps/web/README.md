# @moldig/web

The moldig site. TanStack Start on Vite, styled with Tailwind.

```sh
bun run dev:web     # dev server on :5173
bun run build:web   # prerenders every static route into dist/client
```

The palette and the two font stacks are the `@theme` block in `src/styles/global.css`; everything
else is plain utility classes, with `dark:` variants driven by the visitor's system setting.

The hero puts two pickers around a fixed `moldig` (`src/components/wheel.tsx`), so the selected row
reads as one command line, with a copy button beside it and the explanation of the selected command
to the right. Each wheel is a CSS cylinder: the rows are pushed back by one radius so the selected
one sits at z = 0 and keeps its real size while the others fall away, and an invisible spacer sizes
the wheel to its longest label so nothing shifts sideways as it turns. It answers to the scroll
wheel, to dragging and to the arrow keys, and it is a real `listbox`, so the selected row ships in
the prerendered HTML. The commands and what each one does live in `src/data/commands.ts`.

`src/routeTree.gen.ts` is written by the Start plugin on every dev run and build. It is committed so
`bun run typecheck` works on a fresh clone, and both oxlint and oxfmt skip `*.gen.ts`.
