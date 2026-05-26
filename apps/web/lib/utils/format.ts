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
