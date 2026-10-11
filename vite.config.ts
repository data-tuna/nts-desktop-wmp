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
  // 2. tauri expects a fixed port, fail if that port is not available.
  // 1430, not the Winamp app's 1420, so both can run `tauri dev` at once.
  server: {
    port: 1430,
    strictPort: true,
    // Vite's default CORS lets any *.localhost origin read the dev server,
    // the skin webview (http://skin.localhost) included.
    cors: false,
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
