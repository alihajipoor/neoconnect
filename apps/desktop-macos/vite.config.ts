import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/** The Windows app's `src` is the desktop UI, and this is a desktop app.
 *
 * An alias rather than a shared package, for the same reason
 * apps/mobile gives: extracting one means versioning it, and the two
 * desktops are meant to move together. The difference from mobile is
 * that mobile shares only `@shared/lib` and draws its own screens for a
 * phone, whereas macOS wants the whole desktop interface -- a Mac window
 * is a desktop window. So this app's `src` holds an entry point and
 * nothing else; every component comes from there.
 *
 * The directory is still called desktop-windows. Renaming it would touch
 * the Windows build, its installer, its CI and every import in the
 * mobile app for no behavioural gain, so it keeps the name it earned
 * when it was the only desktop. */
const shared = fileURLToPath(new URL("../desktop-windows/src", import.meta.url));

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: { alias: { "@shared": shared } },
  clearScreen: false,
  server: {
    // 1421, not the 1420 the Windows app uses: both dev servers want a
    // fixed port and strictPort, so sharing one means whichever starts
    // second simply fails.
    port: 1422,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1423 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
}));
