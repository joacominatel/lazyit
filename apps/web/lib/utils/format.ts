/**
 * Shared, framework-agnostic display formatters used across feature screens.
 * Pure functions only — no React, no fetching. Imported as `@/lib/utils/format`.
 */

/**
 * ISO timestamp → short local date (e.g. "May 25, 2026"). Used for the
 * "Updated"/"Created" columns of every resource table.
 */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}
