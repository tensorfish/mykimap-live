import { store, selectVehicle, getAlerts } from "./store.js";
import type { VehiclePosition, TransportMode, ServiceAlert } from "./types.js";

const MODE_LABELS: Record<TransportMode, string> = {
  metro: "Metro Train",
  tram: "Tram",
  bus: "Bus",
  vline: "V/Line",
};

const MODE_BADGE_COLORS: Record<TransportMode, string> = {
  metro: "#34ACE1",
  tram: "#78BE20",
  bus: "#FF8200",
  vline: "#A57FB2",
};

/**
 * Initialize the vehicle info panel.
 * Binds the close button and subscribes to store for selection changes.
 */
export function initPanel(): void {
  const panel = document.getElementById("panel")!;
  const closeBtn = document.getElementById("panel-close")!;
  const content = document.getElementById("panel-content")!;

  closeBtn.addEventListener("click", () => {
    selectVehicle(null);
  });

  store.subscribe(() => {
    const { selectedEntityId, worldState } = store.state;

    if (!selectedEntityId || !worldState) {
      panel.classList.remove("open");
      return;
    }

    const vehicle = worldState.vehicles.find(
      (v) => v.entityId === selectedEntityId
    );

    if (!vehicle) {
      panel.classList.remove("open");
      return;
    }

    panel.classList.add("open");
    content.innerHTML = renderPanel(vehicle, worldState.alerts);
  });
}

function renderPanel(v: VehiclePosition, alerts: ServiceAlert[]): string {
  const mode = MODE_LABELS[v.mode];
  const badgeColor = MODE_BADGE_COLORS[v.mode];
  const speedKmh = (v.speed * 3.6).toFixed(0);
  const routeShort = extractRouteShort(v.routeId, v.mode);
  const lastUpdate = formatTimestamp(v.timestamp);

  // Find alerts affecting this vehicle's route
  const routeAlerts = alerts.filter((a) =>
    a.informedEntities.some((e) => e.routeId === v.routeId)
  );

  let html = `
    <span class="panel-mode-badge" style="background:${badgeColor};color:#000">${mode}</span>
    <h2>Route ${routeShort}</h2>

    <div class="panel-field">
      <div class="panel-field-label">Vehicle ID</div>
      <div class="panel-field-value">${v.vehicleId || "—"}</div>
    </div>
  `;

  if (v.vehicleLabel) {
    html += `
    <div class="panel-field">
      <div class="panel-field-label">Class</div>
      <div class="panel-field-value">${v.vehicleLabel}</div>
    </div>
    `;
  }

  html += `
    <div class="panel-field">
      <div class="panel-field-label">Speed</div>
      <div class="panel-field-value">${speedKmh} km/h</div>
    </div>

    <div class="panel-field">
      <div class="panel-field-label">Bearing</div>
      <div class="panel-field-value">${v.bearing.toFixed(0)}° ${bearingLabel(v.bearing)}</div>
    </div>

    <div class="panel-field">
      <div class="panel-field-label">Position</div>
      <div class="panel-field-value">${v.latitude.toFixed(5)}, ${v.longitude.toFixed(5)}</div>
    </div>

    <div class="panel-field">
      <div class="panel-field-label">Trip ID</div>
      <div class="panel-field-value" style="font-size:11px;word-break:break-all">${v.tripId}</div>
    </div>

    <div class="panel-field">
      <div class="panel-field-label">Start Time</div>
      <div class="panel-field-value">${v.startTime}</div>
    </div>

    <div class="panel-field">
      <div class="panel-field-label">Last Update</div>
      <div class="panel-field-value">${lastUpdate}</div>
    </div>

    <div class="panel-field">
      <div class="panel-field-label">Status</div>
      <div class="panel-field-value">${v.stale ? "⚠ Stale — position may be outdated" : "● Active"}</div>
    </div>
  `;

  if (routeAlerts.length > 0) {
    html += `<hr class="panel-divider">`;
    html += `<div class="panel-field-label" style="margin-bottom:8px">ALERTS (${routeAlerts.length})</div>`;
    for (const a of routeAlerts) {
      html += `
      <div class="panel-alert">
        <div class="panel-alert-header">${escapeHtml(a.headerText)}</div>
        <div>${escapeHtml(a.descriptionText)}</div>
      </div>
      `;
    }
  }

  return html;
}

function extractRouteShort(routeId: string, mode: TransportMode): string {
  if (mode === "bus") return routeId;
  // aus:vic:vic-03-96: → 96
  const match = routeId.match(/-(\w+):$/);
  return match ? match[1]! : routeId;
}

function bearingLabel(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8]!;
}

function formatTimestamp(posix: number): string {
  if (!posix) return "—";
  const d = new Date(posix * 1000);
  return d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
