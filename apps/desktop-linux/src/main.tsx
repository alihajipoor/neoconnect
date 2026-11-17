// First, before any shared module is evaluated: the screens ask which
// desktop they are on, and leave out what Linux does not have (gaming
// mode, and the game catalogue in Custom mode). See platform.ts for why
// this is an import, not a call.
import "./platform";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "@shared/App";
import { TitleBar } from "@shared/components/TitleBar";
import { I18nProvider } from "@shared/lib/i18n";
import { setHealthIpTransport } from "@shared/lib/egress";
import { ipv4OnlyHealthIp } from "@shared/lib/health-ip-v4";
import { startEffects } from "@shared/lib/effects";
import { startHasFallback } from "@shared/lib/old-engine-has";
import "@shared/globals.css";

// The same start-up side effects as the Windows entry (desktop-windows
// src/main.tsx), in the same order, because the screens assume them.

// Before anything can take a baseline: the egress check compares two
// `/health/ip` readings, and they are only comparable when both are IPv4.
setHealthIpTransport(ipv4OnlyHealthIp);

// The glass and motion tiers, on <html> before the first paint.
startEffects();

// Does nothing on an engine with `:has()`, which every WebKitGTK that
// Tauri v2 supports has; called anyway so the two entries cannot drift.
startHasFallback();

// The window has no decorations here either (tauri.conf.json), so the app
// draws its own title strip and the sign-in pages keep its 32px clear.
document.documentElement.dataset.titlebar = "1";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <div className="relative h-full">
        <App />
        <TitleBar />
      </div>
    </I18nProvider>
  </React.StrictMode>,
);
