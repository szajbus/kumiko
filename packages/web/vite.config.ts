import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const server = process.env.BENTOMO_SERVER ?? "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@bentomo/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)) },
  },
  server: {
    proxy: { "/api": { target: server, ws: true } },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
