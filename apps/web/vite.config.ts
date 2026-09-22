import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: "../../dist/web",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@xterm/")) return "terminal";
          if (id.includes("/react/") || id.includes("/react-dom/")) return "react";
          return undefined;
        },
      },
    },
  },
  server: { proxy: { "/api": { target: "http://127.0.0.1:4545", ws: true }, "/health": "http://127.0.0.1:4545" } },
});
