import { store, selectVehicle } from "./store.js";
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

  // Vehicle class (trams only — skip for other modes)
  if (v.vehicleLabel) {
    html += `
    <div class="panel-field">
      <div class="panel-field-label">Class</div>
      <div class="panel-field-value">${v.vehicleLabel}</div>
    </div>
    `;
  }

  // Speed — only show if moving
  if (v.speed >= 0.5) {
    html += `
    <div class="panel-field">
      <div class="panel-field-label">Speed</div>
      <div class="panel-field-value">${speedKmh} km/h</div>
    </div>
    `;
  }

  // Departure time
  if (v.startTime) {
    html += `
    <div class="panel-field">
      <div class="panel-field-label">Departed</div>
      <div class="panel-field-value">${v.startTime}</div>
    </div>
    `;
  }

  // Last update — human readable
  html += `
    <div class="panel-field">
      <div class="panel-field-label">Last update</div>
      <div class="panel-field-value">${timeAgo(v.timestamp)}</div>
    </div>
  `;

  // Status — only show if stale
  if (v.stale) {
    html += `
    <div class="panel-field">
      <div class="panel-field-value" style="color:#f0ad4e">⚠ Position may be outdated</div>
    </div>
    `;
  }

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

function extractRouteShort(routeId: string, mode: TransportMode): string {
  if (mode === "bus") return routeId;
  const match = routeId.match(/-(\w+):$/);
  return match ? match[1]! : routeId;
}

function timeAgo(posix: number): string {
  if (!posix) return "—";
  const seconds = Math.floor(Date.now() / 1000) - posix;
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
