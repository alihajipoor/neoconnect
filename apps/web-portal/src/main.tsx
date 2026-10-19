// First, before any screen can end a session: see no-tunnel.ts.
import "./no-tunnel";
import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "@shared/lib/i18n";
import { startEffects } from "@shared/lib/effects";
import App from "./App";
import "./index.css";

// The theme, glass and motion the shared screens draw with, on <html>
// before the first paint, and kept in step with the OS (lib/effects.ts):
// without it a choice made in Settings was lost on reload, and the OS's
// reduced motion reached only part of the page.
startEffects();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
