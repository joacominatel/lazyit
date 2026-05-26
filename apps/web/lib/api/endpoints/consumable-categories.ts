import type { ConsumableCategory } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Read-access for Consumable categories — used by the Consumables list filter and the consumable
 * form's category select. Full category management is out of scope (handled via API/seed), like the
 * asset / article / application categories.
 */
export function getConsumableCategories(): Promise<ConsumableCategory[]> {
  return apiFetch<ConsumableCategory[]>("/consumable-categories");
}
