import { SLUG_MAX_LENGTH, SLUG_REGEX } from "@lazyit/shared";

/**
 * Create-on-click prefill for unresolved KB wiki-links (#1106 Phase 4). A reader who may author
 * (`article:write`) clicks a red `[[slug]]` and lands on `/kb/new` with the note's slug + a title
 * prefilled, so creating it resolves the original link. Two pure, framework-agnostic halves:
 *   - {@link buildKbCreateHref} builds the link the reading view navigates to.
 *   - {@link parseKbNewPrefill} validates + sanitizes the query params back on `/kb/new` — a crafted
 *     URL is untrusted, so the slug must match the shared slug rules and the title is bounded.
 * Kept out of the markdown component (which stays route/permission-free) and the page so it is testable.
 */

/** Max title length accepted from a prefill param — mirrors `CreateArticleSchema`'s title cap. */
export const PREFILL_TITLE_MAX_LENGTH = 200;

/**
 * Build the `/kb/new` create-on-click href for an unresolved `[[slug]]`. `slug` is the wiki-link's
 * already-slugified target (the rehype transform slugifies it), `label` its display text. Both are
 * URL-encoded via `URLSearchParams`. An empty label omits the title (the form derives one from slug).
 */
export function buildKbCreateHref(slug: string, label: string): string {
  const params = new URLSearchParams({ slug });
  const title = label.trim();
  if (title) params.set("title", title.slice(0, PREFILL_TITLE_MAX_LENGTH));
  return `/kb/new?${params.toString()}`;
}

/** The sanitized create-form prefill parsed from `/kb/new` query params. Absent fields are omitted. */
export interface KbNewPrefill {
  title?: string;
  slug?: string;
}

/**
 * Validate + sanitize the `/kb/new` prefill query params. The URL is UNTRUSTED (a reader can hand-edit
 * it), so:
 *   - `slug` is kept ONLY if it matches the shared slug rules (lowercase [a-z0-9] joined by single
 *     hyphens, ≤ {@link SLUG_MAX_LENGTH}); an invalid slug is dropped and the form derives one from the
 *     title — never injected verbatim.
 *   - `title` is trimmed and capped to {@link PREFILL_TITLE_MAX_LENGTH}; empty/whitespace is dropped.
 * A repeated param (`?title=a&title=b`) collapses to its first value.
 */
export function parseKbNewPrefill(
  params: Record<string, string | string[] | undefined>,
): KbNewPrefill {
  const prefill: KbNewPrefill = {};

  const rawSlug = firstValue(params.slug);
  if (rawSlug && rawSlug.length <= SLUG_MAX_LENGTH && SLUG_REGEX.test(rawSlug)) {
    prefill.slug = rawSlug;
  }

  const rawTitle = firstValue(params.title)?.trim();
  if (rawTitle) prefill.title = rawTitle.slice(0, PREFILL_TITLE_MAX_LENGTH);

  return prefill;
}

/** Collapse a possibly-repeated query param to its first string value. */
function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
