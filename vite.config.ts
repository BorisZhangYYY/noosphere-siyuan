/** Build the frontend plugin as the single script loaded by SiYuan. */
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: { entry: "src/index.ts", formats: ["cjs"], fileName: () => "index.js", cssFileName: "index" },
    cssMinify: true,
    rollupOptions: { external: ["siyuan"] },
  },
});
