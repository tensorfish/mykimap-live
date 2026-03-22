import { initMap } from "./map.js";
import { initStatusBar } from "./ui.js";
import { connect } from "./ws.js";
import { store, transition } from "./store.js";

// ── Bootstrap ──

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string;

if (!MAPBOX_TOKEN) {
  transition("ERROR", "Missing VITE_MAPBOX_ACCESS_TOKEN env var");
  document.getElementById("status-label")!.textContent =
    "Error: Set VITE_MAPBOX_ACCESS_TOKEN in .env";
} else {
  const container = document.getElementById("map")! as HTMLDivElement;

  // Wire up the status bar
  initStatusBar();

  // Initialize map — will transition to CONNECTING when map loads
  initMap(container, MAPBOX_TOKEN);

  // When map signals CONNECTING, open the WebSocket
  store.subscribe(() => {
    if (store.state.clientState === "CONNECTING") {
      connect();
    }
  });
}
