import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const shared = resolve(here, "../desktop-windows/src");
const shim = (file: string) => resolve(here, "src/shims", file);

/**
 * The customer portal, built as static files and shipped inside the PHP
 * marketing site at /account/.
 *
 * It is the SAME React screens the Windows and Android clients use --
 * sign-in, registration, verification, password reset, plans and
 * purchase, vouchers, referrals, support, settings -- imported rather
 * than reimplemented. Only the Dashboard is replaced, because that
 * screen drives a VPN tunnel and a browser has no tunnel to drive.
 *
 * Everything Tauri-specific is aliased to a browser stand-in below,
 * which is what makes the reuse possible without touching a line of the
 * shared code.
 *
 * Static output, no server runtime: the page talks straight to the
 * customer API on connect.neoxify.site, so the PHP host only ever
 * serves files. That also keeps the commerce surface working if the
 * marketing host is somewhere with no Node available, which is most
 * shared hosting.
 */
export default defineConfig({
  plugins: [react()],

  // Served from /account/ rather than the domain root, so asset URLs
  // must be relative to it. Getting this wrong produces a blank page
  // that looks like a JavaScript error and is actually a 404 on the
  // bundle.
  base: "/account/",

  resolve: {
    alias: [
      { find: "@shared", replacement: shared },

      // Tauri modules -> browser equivalents. Aliases resolve before
      // node resolution, so these packages need not be installed here.
      { find: "@tauri-apps/plugin-store", replacement: shim("plugin-store.ts") },
      { find: "@tauri-apps/plugin-http", replacement: shim("misc.ts") },
      { find: "@tauri-apps/api/core", replacement: shim("misc.ts") },
      { find: "@tauri-apps/api/app", replacement: shim("misc.ts") },
      { find: "@tauri-apps/plugin-opener", replacement: shim("misc.ts") },
      { find: "@tauri-apps/plugin-clipboard-manager", replacement: shim("misc.ts") },
      { find: "@tauri-apps/plugin-process", replacement: shim("misc.ts") },
      { find: "@tauri-apps/plugin-updater", replacement: shim("misc.ts") },
    ],
  },

  define: {
    __PORTAL_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.1.0"),
  },

  build: {
    // Straight into the website tree, so the deployable zip is built
    // from one directory and cannot ship a stale portal.
    outDir: resolve(here, "../../website/account"),
    emptyOutDir: true,
    // Flat, short asset names. The site is unzipped onto shared hosting
    // over FTP more often than not, and deep nested hashed paths are
    // where partial uploads go wrong.
    assetsDir: "assets",
  },
});
