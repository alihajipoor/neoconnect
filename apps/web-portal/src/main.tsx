// First, before any screen can end a session: see no-tunnel.ts.
import "./no-tunnel";
import React from "react";
import ReactDOM from "react-dom/client";
import { I18nProvider } from "@shared/lib/i18n";
import App from "./App";
import { isFramed, showOwnTabLink } from "./frame-guard";
import { stylesheetApplied } from "./stylesheet";
import "./index.css";

const root = document.getElementById("root") as HTMLElement;

if (isFramed()) {
  // Inside another site's frame: none of the app, only a way out of it
  // (frame-guard.ts).
  showOwnTabLink(root, window.location.href);
} else {
  // The built page paints its canvas from inline CSS and loads the main
  // stylesheet without blocking that paint (vite.config.ts, portalHtml);
  // nothing is drawn into #root until the stylesheet is on, so no screen
  // ever shows unstyled.
  void stylesheetApplied().then(() => {
    ReactDOM.createRoot(root).render(
      <React.StrictMode>
        <I18nProvider>
          <App />
        </I18nProvider>
      </React.StrictMode>,
    );
  });
}
