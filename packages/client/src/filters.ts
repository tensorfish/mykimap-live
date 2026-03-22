import { store, setFilter } from "./store.js";
import type { Filters } from "./store.js";

/**
 * Wire up the filter chip click handlers and sync visual state with store.
 */
export function initFilters(): void {
  const chips = document.querySelectorAll<HTMLElement>(".filter-chip[data-filter]");

  for (const chip of chips) {
    chip.addEventListener("click", () => {
      const key = chip.dataset.filter as keyof Filters;
      const current = store.state.filters[key];
      setFilter(key, !current);
    });
  }

  // Sync chip visual state on store change
  store.subscribe(() => {
    const { filters } = store.state;
    for (const chip of chips) {
      const key = chip.dataset.filter as keyof Filters;
      chip.classList.toggle("off", !filters[key]);
    }
  });
}
