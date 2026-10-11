import { defineConfig } from "vite";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig({
  // Vite options tailored for Tauri development
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // The player and the skin picker (ATA-112).
  build: { rolldownOptions: { input: ["index.html", "picker.html"] } },
  // 2. tauri expects a fixed port, fail if that port is not available.
  // 1430, not the Winamp app's 1420, so both can run `tauri dev` at once.
  server: {
    port: 1430,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1431,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
});
