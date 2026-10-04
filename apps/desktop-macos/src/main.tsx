import React from "react";
import ReactDOM from "react-dom/client";
import App from "@shared/App";
import { I18nProvider } from "@shared/lib/i18n";
import "@shared/globals.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>,
);
