import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { hasFiles } from "./attachments";

if (window.bentomo) document.documentElement.dataset.shell = `electron-${window.bentomo.platform}`;

// Page zoom changes the viewport size, so resize is the hook for tracking it.
const syncZoom = () => document.documentElement.style.setProperty("--page-zoom", String(window.bentomo?.getZoomFactor?.() ?? 1));
syncZoom();
window.addEventListener("resize", syncZoom);

// Files dropped anywhere but the composer are ignored; left to the browser, the window would open them in place of the app.
for (const type of ["dragover", "drop"]) {
  window.addEventListener(type, (e) => {
    const { dataTransfer } = e as DragEvent;
    // The composer took it already.
    if (e.defaultPrevented || !hasFiles(dataTransfer)) return;
    e.preventDefault();
    dataTransfer!.dropEffect = "none";
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
