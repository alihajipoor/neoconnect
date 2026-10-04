import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { VersionStamp } from "./components/VersionStamp";
import { I18nProvider } from "./lib/i18n";
import "./globals.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
      {/* Outside `App` on purpose: that component returns a different
          screen per state, so anything inside it would have to be
          repeated in each branch and would go missing from whichever
          one somebody forgot. */}
      <VersionStamp />
    </I18nProvider>
  </React.StrictMode>,
);
