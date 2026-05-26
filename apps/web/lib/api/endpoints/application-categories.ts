import type { ApplicationCategory } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Read-access for Application categories — used by the Access list filter and the application
 * form's category select. Full category management is out of scope (handled via API/seed), like
 * article and asset categories.
 */
export function getApplicationCategories(): Promise<ApplicationCategory[]> {
  return apiFetch<ApplicationCategory[]>("/application-categories");
}
