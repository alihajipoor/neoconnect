import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

/** The Windows client's UI, referenced rather than copied.
 *
 * Every screen that is not about the tunnel itself -- sign-in, plans,
 * vouchers, referrals, support -- is identical on both platforms, and
 * so are the API client, the types and the translations. Copying six
 * thousand lines would mean every future fix landing twice, and the
 * second one being forgotten.
 *
 * An alias rather than a shared package because extracting one means
 * editing apps/desktop-windows, and that client is out with testers.
 * The extraction is the right end state; this is the version of it
 * that cannot destabilise a release in progress.
 */
const shared = fileURLToPath(new URL("../desktop-windows/src", import.meta.url));

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@shared": shared },
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
    // Vite refuses to serve files outside the project root unless told
    // otherwise, which the alias above needs in dev.
    fs: { allow: [".", shared] },
  },
  clearScreen: false,
}));
