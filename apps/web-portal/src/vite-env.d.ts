/// <reference types="vite/client" />

/** Injected by vite.config.ts's `define`. Declared here so the portal's
 * strict `tsc -b` (which `pnpm build` runs) can see it -- the bundler
 * substitutes it, so there is no runtime value to import. */
declare const __PORTAL_VERSION__: string;
