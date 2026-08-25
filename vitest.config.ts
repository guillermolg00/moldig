import { defaultServerConditions } from "vite";
import { defineConfig } from "vitest/config";

// Tests run on Node (never `bun test`, see ADR-0005). The custom condition lets
// packages import each other from source without a build step; Vitest resolves
// through the SSR pipeline, so it must be set there too (CI proved it).
const conditions = ["@moldig/source", ...defaultServerConditions];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**"],
      exclude: ["**/*.test.ts"],
    },
  },
});
