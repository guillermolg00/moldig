import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Tests run on Node (never `bun test`, see ADR-0005). The custom condition lets
// packages import each other from source without a build step.
export default defineConfig({
  resolve: { conditions: ["@moldig/source", ...defaultServerConditions] },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**"],
      exclude: ["**/*.test.ts"],
    },
  },
});
