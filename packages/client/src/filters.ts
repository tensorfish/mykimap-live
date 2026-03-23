import { store, setFilter, setRouteFilter, setVehicleFilter } from "./store.js";
import type { Filters } from "./store.js";
import type { TransportMode } from "./types.js";

export function initFilters(): void {
  const chips = document.querySelectorAll<HTMLElement>(".filter-chip[data-filter]");
  const expandBtn = document.getElementById("filter-expand")!;
  const filterRow = document.getElementById("filter-row")!;
  const routeInput = document.getElementById("filter-route")! as HTMLInputElement;
  const vehicleInput = document.getElementById("filter-vehicle")! as HTMLInputElement;
  const filterCount = document.getElementById("filter-count")!;

  let expanded = false;

  // Mode chip toggles
  for (const chip of chips) {
    chip.addEventListener("click", () => {
      const key = chip.dataset.filter as keyof Filters;
      setFilter(key, !store.state.filters[key]);
    });
  }

  // Expand/collapse
  expandBtn.addEventListener("click", () => {
    expanded = !expanded;
    filterRow.style.display = expanded ? "flex" : "none";
    expandBtn.classList.toggle("open", expanded);
    if (expanded) {
      routeInput.focus();
    } else {
      routeInput.value = "";
      vehicleInput.value = "";
      setRouteFilter("");
      setVehicleFilter("");
    }
  });

  // Text inputs
  routeInput.addEventListener("input", () => setRouteFilter(routeInput.value));
  vehicleInput.addEventListener("input", () => setVehicleFilter(vehicleInput.value));

  // Escape clears
  const onEsc = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      (e.target as HTMLInputElement).value = "";
      setRouteFilter(routeInput.value);
      setVehicleFilter(vehicleInput.value);
    }
  };
  routeInput.addEventListener("keydown", onEsc);
  vehicleInput.addEventListener("keydown", onEsc);

  // Sync UI
  store.subscribe(() => {
    const { filters, worldState, routeFilter, vehicleFilter } = store.state;

    const counts: Record<TransportMode, number> = { metro: 0, tram: 0, bus: 0, vline: 0 };
    let matchCount = 0;
    let total = 0;

    const rq = routeFilter.toLowerCase();
    const vq = vehicleFilter.toLowerCase();
    const hasFilter = rq.length > 0 || vq.length > 0;

    if (worldState) {
      for (const v of worldState.vehicles) {
        counts[v.mode]++;
        if (filters[v.mode]) {
          total++;
          if (hasFilter) {
            const routeMatch = !rq || v.routeId.toLowerCase().includes(rq) || v.entityId.toLowerCase().includes(rq);
            const vehicleMatch = !vq || v.vehicleId.toLowerCase().includes(vq) || v.vehicleLabel.toLowerCase().includes(vq);
            if (routeMatch && vehicleMatch) matchCount++;
          }
        }
      }
    }

    for (const chip of chips) {
      const key = chip.dataset.filter as keyof Filters;
      chip.classList.toggle("off", !filters[key]);
      const countEl = chip.querySelector(".chip-count");
      if (countEl && key in counts) {
        countEl.textContent = String(counts[key as TransportMode]);
      }
    }

    filterCount.textContent = hasFilter ? `${matchCount} / ${total}` : "";
  });
}
