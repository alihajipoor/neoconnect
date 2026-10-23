import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;
// @ts-expect-error process is a nodejs global
const previewMocks: boolean = process.env.NX_PREVIEW_MOCKS === "1";

/** DEV ONLY: answers the account API from samples in the dev preview
 * (src/preview/mocks), so Settings, Plans, Support and Invite friends can
 * be looked at and screenshotted with content and without a network. On
 * only for `vite` serving with NX_PREVIEW_MOCKS=1 -- `apply: "serve"`, so a
 * build never takes it, and `tauri dev` never sets the variable. A module
 * the mocks do not cover is the real one. */
function previewMockPlugin(): Plugin {
  const MOCKED = ["/src/lib/customer.ts", "/src/lib/credential-cache.ts"];
  return {
    name: "nx-preview-mocks",
    apply: "serve",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const from = importer.replace(/\\/g, "/");
      // The mocks themselves reach the real modules.
      if (from.includes("/src/preview/mocks/")) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const id = resolved.id.replace(/\\/g, "/");
      const hit = MOCKED.find((tail) => id.endsWith(tail));
      if (!hit) return null;
      return id.slice(0, id.length - hit.length) + hit.replace("/src/lib/", "/src/preview/mocks/");
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), ...(previewMocks ? [previewMockPlugin()] : [])],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
