import { initMap } from "./map.js";
import { initStatusBar } from "./ui.js";
import { initPanel } from "./panel.js";
import { initFilters } from "./filters.js";
import { connect } from "./ws.js";
import { transition } from "./store.js";

// ── Bootstrap ──

const MAPBOX_TOKEN = import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string;

if (!MAPBOX_TOKEN) {
  transition("ERROR", "Missing VITE_MAPBOX_ACCESS_TOKEN env var");
  document.getElementById("status-label")!.textContent =
    "Error: Set VITE_MAPBOX_ACCESS_TOKEN in .env";
} else {
  const container = document.getElementById("map")! as HTMLDivElement;

  initStatusBar();
  initPanel();
  initFilters();

  initMap(container, MAPBOX_TOKEN, () => {
    transition("CONNECTING", "Map loaded");
    connect();
  });
}
