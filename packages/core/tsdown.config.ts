import { defineConfig, type UserConfig } from "tsdown";

const config: UserConfig = defineConfig({
  entry: ["src/index.ts", "src/testing/index.ts"],
  platform: "node",
  format: ["esm"],
  fixedExtension: true,
  dts: { sourcemap: true },
  sourcemap: true,
  publint: true,
  attw: { profile: "esm-only", level: "error" },
  failOnWarn: true,
});

export default config;
