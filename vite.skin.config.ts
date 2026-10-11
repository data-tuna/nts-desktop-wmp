import { defineConfig } from "vite";

// The skin engine, as one classic script the skin protocol serves as
// /engine.js. It runs in the skin webview, not in the trusted page.
export default defineConfig({
  build: {
    outDir: "dist-skin",
    emptyOutDir: true,
    lib: { entry: "src/skin/main.ts", formats: ["iife"], name: "skin", fileName: () => "engine.js" },
  },
});
