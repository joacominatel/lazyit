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

/**
 * ISO timestamp → a short relative label ("just now", "5m ago", "2h ago", "3d ago", "2mo ago",
 * "1y ago"). `now` (epoch ms) is passed in by the caller — snapshot it once with
 * `useState(() => Date.now())` so rendering stays pure (react-hooks/purity), rather than calling
 * `Date.now()` here during render.
 */
export function formatRelativeTime(iso: string, now: number): string {
  const seconds = Math.round((now - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/**
 * Raw spec/object key → a human label. Splits camelCase, snake_case and kebab-case,
 * then Title-Cases each word ("cpuModel" / "cpu_model" / "cpu-model" → "Cpu Model").
 * Used to render free-form `Asset.specs` keys readably on the detail page. A key
 * with no recognizable boundary falls back to a single capitalized word; an
 * empty/whitespace-only key returns "".
 */
export function formatFieldLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2") // camelCase boundary
    .replace(/[_-]+/g, " ") // snake_case / kebab-case
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  return words
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Render a free-form spec value (string | number | boolean | null | object) as a
 * display string. Scalars are shown verbatim; booleans as "Yes"/"No"; null/undefined
 * as "—"; anything non-scalar (arrays/objects, which the custom-fields editor never
 * produces but legacy specs might) falls back to compact JSON.
 */
export function formatSpecValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return JSON.stringify(value);
}
