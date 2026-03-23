import { store, setFilter, setAdvancedFilter } from "./store.js";
import type { Filters } from "./store.js";
import type { TransportMode } from "./types.js";

export function initFilters(): void {
  const chips = document.querySelectorAll<HTMLElement>(".filter-chip[data-filter]");
  const advancedCheck = document.getElementById("advanced-check")! as HTMLInputElement;
  const advancedRow = document.getElementById("advanced-row")!;
  const advancedInput = document.getElementById("advanced-input")! as HTMLInputElement;
  const advancedCount = document.getElementById("advanced-count")!;

  // Mode chip toggles
  for (const chip of chips) {
    chip.addEventListener("click", () => {
      const key = chip.dataset.filter as keyof Filters;
      const current = store.state.filters[key];
      setFilter(key, !current);
    });
  }

  // Advanced toggle
  advancedCheck.addEventListener("change", () => {
    advancedRow.style.display = advancedCheck.checked ? "flex" : "none";
    if (!advancedCheck.checked) {
      advancedInput.value = "";
      setAdvancedFilter("");
    } else {
      advancedInput.focus();
    }
  });

  // Advanced text input — filter as you type
  advancedInput.addEventListener("input", () => {
    setAdvancedFilter(advancedInput.value);
  });

  // Clear on Escape
  advancedInput.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      advancedInput.value = "";
      setAdvancedFilter("");
    }
  });

  // Sync UI with store
  store.subscribe(() => {
    const { filters, worldState, advancedFilter } = store.state;

    const counts: Record<TransportMode, number> = { metro: 0, tram: 0, bus: 0, vline: 0 };
    let matchCount = 0;

    if (worldState) {
      const query = advancedFilter.toLowerCase();

      for (const v of worldState.vehicles) {
        counts[v.mode]++;

        if (query && filters[v.mode]) {
          if (matchesFilter(v.routeId, v.vehicleId, v.vehicleLabel, v.entityId, query)) {
            matchCount++;
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

    // Update match count
    if (advancedFilter) {
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      advancedCount.textContent = `${matchCount} / ${total}`;
    } else {
      advancedCount.textContent = "";
    }
  });
}

/** Case-insensitive substring match across route ID, vehicle ID, label, entity ID */
function matchesFilter(routeId: string, vehicleId: string, label: string, entityId: string, query: string): boolean {
  return routeId.toLowerCase().includes(query)
    || vehicleId.toLowerCase().includes(query)
    || label.toLowerCase().includes(query)
    || entityId.toLowerCase().includes(query);
}
