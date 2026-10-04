import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { TitleBar } from "./components/TitleBar";
import { VersionStamp } from "./components/VersionStamp";
import { I18nProvider } from "./lib/i18n";
import "./globals.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <I18nProvider>
      {/* In the layout rather than floating over it: the window has no
          decorations now, so this bar *is* the top of the window and
          the screens below get what is left. */}
      <div className="flex h-full flex-col">
        <TitleBar />
        <div className="min-h-0 flex-1">
          <App />
        </div>
      </div>
      {/* Outside `App` on purpose: that component returns a different
          screen per state, so anything inside it would have to be
          repeated in each branch and would go missing from whichever
          one somebody forgot. */}
      <VersionStamp />
    </I18nProvider>
  </React.StrictMode>,
);
