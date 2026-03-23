import { store, selectVehicle } from "./store.js";
import { getPlaybackState } from "./playback.js";
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

export function initPanel(): void {
  const panel = document.getElementById("panel")!;
  const closeBtn = document.getElementById("panel-close")!;
  const content = document.getElementById("panel-content")!;

  closeBtn.addEventListener("click", () => selectVehicle(null));

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

  const routeAlerts = alerts.filter((a) =>
    a.informedEntities.some((e) => e.routeId === v.routeId)
  );

  let html = `
    <span class="panel-mode-badge" style="background:${badgeColor};color:#000">${mode}</span>
    <h2>Route ${routeShort}</h2>
  `;

  // Tram class
  if (v.vehicleLabel) {
    html += field("Class", v.vehicleLabel);
  }

  // Speed — visually prominent
  const speedDisplay = v.speed >= 0.5
    ? `<span class="panel-speed-value">${speedKmh}</span> <span style="color:var(--text-secondary)">km/h</span>`
    : `<span class="panel-speed-value" style="color:var(--text-tertiary)">0</span> <span style="color:var(--text-secondary)">Stationary</span>`;
  html += `<div class="panel-field"><div class="panel-field-label">Speed</div><div class="panel-field-value">${speedDisplay}</div></div>`;

  // Direction
  if (v.bearing > 0) {
    html += field("Heading", bearingLabel(v.bearing));
  }

  // Departure time
  if (v.startTime) {
    html += field("Departed", v.startTime);
  }

  // Last update
  html += field("Updated", timeAgo(v.timestamp));

  // Stale warning
  if (v.stale) {
    html += `<div class="panel-field"><div class="panel-field-value" style="color:#f0ad4e">⚠ Position may be outdated</div></div>`;
  }

  // Subtle details — secondary info in smaller muted text
  html += `<hr class="panel-divider">`;
  html += `<div class="panel-subtle">`;
  html += subtleField("Vehicle", v.vehicleId || "—");
  html += subtleField("Position", `${v.latitude.toFixed(5)}, ${v.longitude.toFixed(5)}`);
  html += subtleField("Bearing", `${v.bearing.toFixed(0)}°`);
  html += subtleField("Trip", v.tripId);
  html += `</div>`;

  // Alerts
  if (routeAlerts.length > 0) {
    html += `<hr class="panel-divider">`;
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

function field(label: string, value: string): string {
  return `<div class="panel-field"><div class="panel-field-label">${label}</div><div class="panel-field-value">${value}</div></div>`;
}

function subtleField(label: string, value: string): string {
  return `<div class="panel-subtle-row"><span class="panel-subtle-label">${label}</span><span class="panel-subtle-value">${value}</span></div>`;
}

function extractRouteShort(routeId: string, mode: TransportMode): string {
  if (mode === "bus") return routeId;
  const match = routeId.match(/-(\w+):$/);
  return match ? match[1]! : routeId;
}

function bearingLabel(deg: number): string {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return dirs[Math.round(deg / 45) % 8]!;
}

function timeAgo(posix: number): string {
  if (!posix) return "—";
  // In playback mode, use the playback timestamp as "now"
  const pb = getPlaybackState();
  const now = pb.active ? pb.currentTimestamp : Date.now() / 1000;
  const seconds = Math.floor(now - posix);
  if (seconds < 0) return "just now";
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
