import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { I18nProvider } from "@shared/lib/i18n";
import { setHealthIpTransport } from "@shared/lib/egress";
import { ipv4OnlyHealthIp } from "@shared/lib/health-ip-v4";
import "./globals.css";

// Before anything can take a baseline, as on Windows: the egress check
// compares two `/health/ip` readings, and they are only comparable when
// both are IPv4. Left on the plugin's fetch, a dual-stack phone took its
// baseline over IPv6 and read every tunnel -- IPv4 only, on both
// platforms -- as "indeterminate". See `mod health_ip` in
// src-tauri/src/lib.rs.
setHealthIpTransport(ipv4OnlyHealthIp);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
