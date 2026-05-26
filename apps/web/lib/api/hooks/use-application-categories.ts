import { useQuery } from "@tanstack/react-query";
import { getApplicationCategories } from "../endpoints/application-categories";

/** Query keys for Application categories (read-only in the current scope). */
export const applicationCategoryKeys = {
  all: ["application-categories"] as const,
  lists: () => [...applicationCategoryKeys.all, "list"] as const,
};

/** List all application categories (for the Access filter and the application form select). */
export function useApplicationCategories() {
  return useQuery({
    queryKey: applicationCategoryKeys.lists(),
    queryFn: getApplicationCategories,
  });
}
