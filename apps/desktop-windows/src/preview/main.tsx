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
  async invoke(cmd: string) {
    switch (cmd) {
      case "plugin:app|version":
        return "0.9.51-preview";
      case "measure_latency":
        return 40 + Math.round(Math.random() * 150);
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

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <PreviewApp />
    </I18nProvider>
  </React.StrictMode>,
);
