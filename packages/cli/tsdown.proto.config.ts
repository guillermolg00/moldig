import { defineConfig, type UserConfig } from "tsdown";

// THROWAWAY PROTOTYPE (ticket 09): bundles the Ink TUI prototype (ink + react included) into
// `dist-proto/proto.mjs`. `@moldig/core` is read from source through the custom condition,
// like the real CLI build. No dts, no publint: `dist-proto/` is gitignored and never shipped.
const config: UserConfig = defineConfig({
  entry: { proto: "src/proto/main.tsx" },
  outDir: "dist-proto",
  platform: "node",
  format: ["esm"],
  fixedExtension: true,
  dts: false,
  sourcemap: false,
  failOnWarn: false,
  // Quiet: `bun run proto` runs this build before the TUI, and a piped run must start with
  // the frame, not the bundler's log.
  logLevel: "silent",
  deps: {
    alwaysBundle: [/^ink$/, /^react$/, /^react\//, /^@moldig\/core/],
    neverBundle: ["react-devtools-core"], // ink's optional devtools hook; only loaded under DEV=true
    onlyBundle: false,
  },
  inputOptions: {
    resolve: { conditionNames: ["@moldig/source", "import", "node", "default"] },
  },
});

export default config;
