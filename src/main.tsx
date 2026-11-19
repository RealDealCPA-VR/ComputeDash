import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { i18nReady } from "./i18n";
import App from "./App";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "./index.css";
import "./styles/shell.css";
import "./styles/occupancy.css";

// Installed as an app (home screen): let the CSS know, to clear the status bar.
try {
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true;
  if (standalone) document.documentElement.setAttribute("data-standalone", "1");
} catch {
  /* ignore */
}

// Register the PWA service worker (installable on mobile, offline shell).
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("[sparkDash] service worker registration failed:", err);
    });
  });
}

// A saved non-English language loads its catalogs first (English is bundled and ready at once),
// so the first paint is already in the user's language.
void i18nReady.then(() => {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
