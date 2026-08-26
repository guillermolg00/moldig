import { defineConfig, type UserConfig } from "tsdown";

// `@moldig/core`, `ink` and `react` are devDependencies on purpose: they are bundled into the
// CLI, so `npx moldig` ships one bundle and exactly one runtime dependency, `trash` (D88). The
// custom condition makes the bundle (and `tsdown --watch`) read core from source, like tsc and
// Vitest do, instead of a possibly stale `dist/`.
//
// Ink and React must be bundled *together*: bundling Ink against an external React yields two
// React copies and the "Invalid hook call" warning. `react-devtools-core` and its `ws` transport
// are Ink's optional devtools hook: it only loads when `DEV=true` *and* `import.meta.resolve`
// finds the package, which a published install never does, so bundling them would ship a
// megabyte of dead code. `trash` ships native helpers (a Swift binary, `windows-trash.exe`) that
// cannot be bundled at all.
const config: UserConfig = defineConfig({
  entry: ["src/cli.ts", "src/main.ts"],
  deps: {
    alwaysBundle: [/^ink$/, /^react$/, /^react\//, /^@moldig\/core/],
    neverBundle: ["react-devtools-core", "ws", "trash"],
    onlyBundle: false,
  },
  platform: "node",
  format: ["esm"],
  fixedExtension: true,
  dts: false,
  sourcemap: true,
  // No `attw`: the package exports no types, only a bin. `publint` still checks the tarball
  // (the bin path, `files`, the module shape) on every build.
  publint: true,
  failOnWarn: true,
  inputOptions: {
    resolve: { conditionNames: ["@moldig/source", "import", "node", "default"] },
  },
});

export default config;
