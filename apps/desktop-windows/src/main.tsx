import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TitleBar } from "./components/TitleBar";
import { I18nProvider } from "./lib/i18n";
import { setHealthIpTransport } from "./lib/egress";
import { ipv4OnlyHealthIp } from "./lib/health-ip-v4";
import { probeFrames, startEffects } from "./lib/effects";
import "./globals.css";

// Before anything can take a baseline: the egress check compares two
// `/health/ip` readings, and they are only comparable when both are
// IPv4. See health-ip-v4.ts.
setHealthIpTransport(ipv4OnlyHealthIp);

// The glass and motion tiers, on <html> before the first paint
// (lib/effects.ts).
startEffects();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      {/* The window has no decorations: the title strip is drawn over the
          app, transparent, and each screen keeps its 32px clear. */}
      <div className="relative h-full">
        <App />
        <TitleBar />
      </div>
    </I18nProvider>
  </React.StrictMode>,
);

// Once, after the first glass has painted: a slow device drops a tier.
requestAnimationFrame(() => setTimeout(probeFrames, 1_500));
