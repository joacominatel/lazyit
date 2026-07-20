/**
 * Pure route derivations for the persistent KB tree route-shell (#1106 Phase 3). The shell lives in
 * the never-remounting `/kb` layout and needs to know, from the current URL alone, (a) whether to
 * render the folder-tree rail, (b) which folder to HIGHLIGHT, and (c) where a folder pick navigates.
 * These are framework-agnostic string derivations (no `next/navigation`, no DOM), so they are
 * unit-tested directly (`kb-shell-route.test.ts`) — the shell just wires `usePathname` /
 * `useSearchParams` into them.
 */

/** Split a pathname into its non-empty segments (`/kb/foo/` → `["kb", "foo"]`). */
function segmentsOf(pathname: string): string[] {
  return pathname.split("/").filter(Boolean);
}

/**
 * The article slug when `pathname` is a KB READING route (`/kb/<slug>`), else `null`. The create form
 * (`/kb/new`) and the edit form (`/kb/<slug>/edit`, two segments) are NOT reading routes — they get
 * `null` so the shell neither highlights a folder nor treats them as an article. The slug is
 * URL-decoded so a percent-encoded segment resolves to the real slug used as the query key.
 */
export function articleSlugFromPath(pathname: string): string | null {
  const parts = segmentsOf(pathname);
  if (parts[0] !== "kb") return null;
  const rest = parts.slice(1);
  // Exactly one segment after `kb` is a reading route; `new` is the create form, not an article.
  if (rest.length !== 1) return null;
  const seg = rest[0];
  if (seg === "new") return null;
  return decodeURIComponent(seg);
}

/**
 * True when the folder-tree rail should render for `pathname`: the browse list (`/kb`) and every
 * reading route (`/kb/<slug>`). The focused editor surfaces (`/kb/new`, `/kb/<slug>/edit`) stay
 * full-width — no tree — so they are never cramped by the rail.
 */
export function isKbTreeRoute(pathname: string): boolean {
  const parts = segmentsOf(pathname);
  if (parts[0] !== "kb") return false;
  if (parts.length === 1) return true; // `/kb` browse
  return articleSlugFromPath(pathname) !== null; // a reading route
}

/**
 * The single selected folder id from the browse URL's `categoryId` param (comma-encoded multi-select,
 * mirroring the list view). Returns the id only when EXACTLY one is present — a multi-select or an
 * empty param highlights nothing (never a misleading single node), matching the list view's rule.
 */
export function singleCategoryId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length === 1 ? ids[0] : null;
}

/**
 * The href a folder pick navigates to, preserving the caller's current query string. Always targets
 * `/kb` (browse) — clicking a folder from a reading route takes you to that folder's browse list.
 * `offset` (paging) and `q` (an active search — Meili search is not folder-scoped, so a folder pick is
 * a "browse this folder" intent) are dropped; any other filters (status/linked/…) are preserved.
 * `folderId === null` clears the folder filter ("All articles"). `currentSearch` is a raw query string
 * (`URLSearchParams`-parseable, no leading `?`).
 */
export function kbFolderHref(
  currentSearch: string,
  folderId: string | null,
): string {
  const params = new URLSearchParams(currentSearch);
  params.delete("offset");
  params.delete("q");
  if (folderId) params.set("categoryId", folderId);
  else params.delete("categoryId");
  const qs = params.toString();
  return qs ? `/kb?${qs}` : "/kb";
}
