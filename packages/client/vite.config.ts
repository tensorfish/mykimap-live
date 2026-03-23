import { defineConfig } from "vite";

export default defineConfig({
  // Load .env from project root, not packages/client/
  envDir: "../../",
  // Suppress missing source map warnings from duckdb-wasm
  optimizeDeps: {
    exclude: ["@duckdb/duckdb-wasm"],
  },
  server: {
    port: 5173,
    proxy: {
      "/ws": {
        target: "ws://localhost:3000",
        ws: true,
      },
      "/health": {
        target: "http://localhost:3000",
      },
      "/api": {
        target: "http://localhost:3000",
      },
      "/data": {
        target: "http://localhost:3000",
      },
    },
  },
});
