import { defineConfig, type UserConfig } from "tsdown";

// `@moldig/core` is a devDependency on purpose: it is bundled into the CLI so
// `npx moldig` ships one file with zero runtime dependencies. The custom
// condition makes the bundle (and `tsdown --watch`) read core from source,
// like tsc and Vitest do, instead of a possibly stale `dist/`.
const config: UserConfig = defineConfig({
  entry: ["src/cli.ts", "src/main.ts"],
  platform: "node",
  format: ["esm"],
  fixedExtension: true,
  dts: false,
  sourcemap: true,
  failOnWarn: true,
  inputOptions: {
    resolve: { conditionNames: ["@moldig/source", "import", "node", "default"] },
  },
});

export default config;
