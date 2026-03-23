import { store, setFilter } from "./store.js";
import type { Filters } from "./store.js";
import type { TransportMode } from "./types.js";

export function initFilters(): void {
  const chips = document.querySelectorAll<HTMLElement>(".filter-chip[data-filter]");

  for (const chip of chips) {
    chip.addEventListener("click", () => {
      const key = chip.dataset.filter as keyof Filters;
      const current = store.state.filters[key];
      setFilter(key, !current);
    });
  }

  store.subscribe(() => {
    const { filters, worldState } = store.state;

    // Count vehicles per mode
    const counts: Record<TransportMode, number> = { metro: 0, tram: 0, bus: 0, vline: 0 };
    if (worldState) {
      for (const v of worldState.vehicles) {
        counts[v.mode]++;
      }
    }

    for (const chip of chips) {
      const key = chip.dataset.filter as keyof Filters;
      chip.classList.toggle("off", !filters[key]);

      // Update count label
      const countEl = chip.querySelector(".chip-count");
      if (countEl && key in counts) {
        countEl.textContent = String(counts[key as TransportMode]);
      }
    }
  });
}
