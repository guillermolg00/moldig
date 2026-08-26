import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    tailwindcss(),
    tanstackStart({ prerender: { enabled: true, crawlLinks: true } }),
    // React's plugin must come after Start's.
    viteReact(),
  ],
});
