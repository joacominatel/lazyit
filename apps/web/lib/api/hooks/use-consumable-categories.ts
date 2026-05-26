import { useQuery } from "@tanstack/react-query";
import { getConsumableCategories } from "../endpoints/consumable-categories";

/** Query keys for Consumable categories (read-only in the current scope). */
export const consumableCategoryKeys = {
  all: ["consumable-categories"] as const,
  lists: () => [...consumableCategoryKeys.all, "list"] as const,
};

/** List all consumable categories (for the Consumables filter and the consumable form select). */
export function useConsumableCategories() {
  return useQuery({
    queryKey: consumableCategoryKeys.lists(),
    queryFn: getConsumableCategories,
  });
}
