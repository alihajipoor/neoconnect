/** DEV ONLY: the redesigned main page in an ordinary browser, with mocked
 * state and a state switcher, for reviewing and screenshotting without
 * Tauri. Loaded only by preview.html, which `vite build` does not take as
 * an input, so none of this reaches the shipped app.
 *
 * Every Tauri call is answered here, locally: nothing leaves the page --
 * no API request, no latency probe, no store write. A call the preview does
 * not answer is refused, which the app already treats as "could not ask". */

import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "../lib/i18n";
import { startEffects } from "../lib/effects";
import { PreviewApp } from "./PreviewApp";
import "../globals.css";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __NX_PREVIEW_GAMING__?: string;
  }
}

if (!import.meta.env.DEV) {
  throw new Error("The main page preview is for the dev server only.");
}

let callbackId = 0;
window.__TAURI_INTERNALS__ = {
  async invoke(cmd: string, args?: { host?: string; port?: number }) {
    switch (cmd) {
      case "plugin:app|version":
        return "0.9.51-preview";
      case "measure_latency": {
        // Fixed per sample host, so screenshots repeat; the UDP-only
        // samples get no answer, as a network that drops pings gives.
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (args?.port === 51820 || args?.port === 500) return null;
        const octet = Number(args?.host?.split(".").pop() ?? 0);
        return 34 + ((octet * 53) % 170);
      }
      case "gaming_status":
        return { state: window.__NX_PREVIEW_GAMING__ ?? "off", detail: null };
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
// The preview frames stand in for the Windows window, title strip and all.
document.documentElement.dataset.titlebar = "1";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <PreviewApp />
    </I18nProvider>
  </React.StrictMode>,
);
