import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
// The same stylesheet pass the Windows app runs. It only adds fallbacks for
// engines without container queries, so on a current WebKitGTK it changes
// nothing visible, and keeping it means both desktops ship the same CSS.
import { oldEngineCss } from "../desktop-windows/scripts/old-engine-css.mjs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/** The Windows app's `src` is the desktop interface, and this app renders
 * it whole, as the macOS shell does: this app's own `src` holds only an
 * entry point. An alias rather than a shared package, because the desktops
 * are meant to move together and a package would have to be versioned. */
const shared = fileURLToPath(new URL("../desktop-windows/src", import.meta.url));

export default defineConfig(async () => ({
  plugins: [react(), oldEngineCss()],
  resolve: { alias: { "@shared": shared } },
  clearScreen: false,
  server: {
    // 1424, not 1420 (Windows) or 1422 (macOS): each dev server wants a
    // fixed port with strictPort, so sharing one means the second fails.
    port: 1424,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1425 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
