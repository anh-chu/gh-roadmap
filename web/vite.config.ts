import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

// Dev: Fastify mounts vite as middleware on its own port — no standalone vite server,
// no proxy. Production: vite build outputs to dist/, Fastify serves it statically.
export default defineConfig({
  root: here,
  plugins: [react()],
  build: {
    outDir: resolve(here, "dist"),
    emptyOutDir: true,
  },
  allowedHosts: ["devvm"]
});
