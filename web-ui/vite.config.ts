import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

/** 构建产物落到 web/vendor/apps-sdk-ui，由 Hono 与旧 HTML 一并托管。 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/ui-i18n.js": "http://127.0.0.1:3000",
    },
  },
  build: {
    outDir: path.resolve(__dirname, "../web/vendor/apps-sdk-ui"),
    emptyOutDir: true,
    manifest: true,
    rollupOptions: {
      input: {
        bridge: path.resolve(__dirname, "src/bridge-entry.tsx"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
