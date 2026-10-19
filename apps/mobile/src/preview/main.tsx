/** DEV ONLY: the phone's main page, its first-run disclosure and its per-app
 * card in an ordinary browser, with mocked state and a state switcher, for
 * reviewing, measuring (`pnpm check:phone-fit`) and screenshotting without
 * Tauri. Loaded only by preview.html, which `vite build` does not take as an
 * input, so none of this reaches the app.
 *
 * Every Tauri call is answered here, locally: nothing leaves the page -- no
 * API request, no latency probe, nothing written anywhere but memory. A call
 * the preview does not answer is refused, which the app already treats as
 * "could not ask". */

import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "@shared/lib/i18n";
import { startEffects } from "@shared/lib/effects";
import { PhonePreview, SAMPLE_APPS } from "./PhonePreview";
import "../globals.css";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    /** What the per-app card reads from its store, for the preview. */
    __NX_PREVIEW_PERAPP__?: { enabled: boolean; packages: string[] };
  }
}

if (!import.meta.env.DEV) {
  throw new Error("The phone preview is for the dev server only.");
}

/** The store plugin, in memory: one map per file. The per-app card's
 * settings are the switcher's (`__NX_PREVIEW_PERAPP__`), so each screen
 * opens on its own sample. */
const stores = new Map<number, Map<string, unknown>>();
const storePaths = new Map<string, number>();
const PER_APP = "per-app.json";
const perAppRid = () => storePaths.get(PER_APP);

let callbackId = 0;
window.__TAURI_INTERNALS__ = {
  async invoke(cmd: string, args?: Record<string, unknown>) {
    switch (cmd) {
      case "plugin:app|version":
        return "0.2.29-preview";
      case "plugin:store|load":
      case "plugin:store|get_store": {
        const path = String(args?.path ?? "");
        let rid = storePaths.get(path);
        if (rid === undefined) {
          rid = storePaths.size + 1;
          storePaths.set(path, rid);
          stores.set(rid, new Map());
        }
        return rid;
      }
      case "plugin:store|get": {
        if (Number(args?.rid) === perAppRid() && args?.key === "settings") return [window.__NX_PREVIEW_PERAPP__ ?? null, true];
        const store = stores.get(Number(args?.rid));
        const key = String(args?.key);
        return [store?.get(key) ?? null, store?.has(key) ?? false];
      }
      case "plugin:store|set":
        if (Number(args?.rid) === perAppRid() && args?.key === "settings") {
          window.__NX_PREVIEW_PERAPP__ = args.value as typeof window.__NX_PREVIEW_PERAPP__;
          return null;
        }
        stores.get(Number(args?.rid))?.set(String(args?.key), args?.value);
        return null;
      case "plugin:store|has":
        return stores.get(Number(args?.rid))?.has(String(args?.key)) ?? false;
      case "plugin:store|save":
        return null;
      case "vpn_list_apps":
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { apps: SAMPLE_APPS };
      case "plugin:opener|open_url":
        return null;
      case "measure_latency": {
        // Fixed per sample host, so screenshots repeat; the UDP-only
        // samples get no answer, as a network that drops pings gives.
        await new Promise((resolve) => setTimeout(resolve, 250));
        const a = args as { host?: string; port?: number } | undefined;
        if (a?.port === 51820 || a?.port === 500) return null;
        const octet = Number(a?.host?.split(".").pop() ?? 0);
        return 34 + ((octet * 53) % 170);
      }
      default:
        throw new Error(`preview: ${cmd} is not available here`);
    }
  },
  transformCallback() {
    callbackId += 1;
    return callbackId;
  },
  unregisterCallback() {},
  convertFileSrc: (path: string) => path,
  metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
};

startEffects();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <PhonePreview />
    </I18nProvider>
  </React.StrictMode>,
);
