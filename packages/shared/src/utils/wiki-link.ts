/**
 * Wiki-link helpers for the Knowledge Base (ADR-0059 §3). Articles author article↔article links
 * inline in markdown as Obsidian-style `[[slug]]` tokens, resolved against the org-unique article
 * slug. These helpers are PURE and framework-agnostic, so api (the materialized-edge rebuild and the
 * bulk-import rewire) and web (the `[[slug]]` autocomplete / tooltip renderer) share one definition.
 *
 * The extracted token is the *target* of the link — the part the edge's `targetSlug` stores — not
 * the display text. Resolution to a live article (`resolvedTargetId`) and the unresolved-tooltip
 * render are NOT here: a `[[slug]]` whose target doesn't exist is render-time state, never an error
 * (ADR-0029 / ADR-0059 §3).
 */

import { SLUG_REGEX, slugify } from "./slug";

/**
 * Matches an Obsidian-style wiki-link token `[[ … ]]`. The inner capture is the raw body between the
 * brackets — it may carry a `|display text` alias and/or a `#heading` anchor, both stripped by
 * {@link parseWikiLinks}. `[^\][]` forbids nested brackets so `[[a]] [[b]]` parses as two tokens (not
 * one greedy span), and an unterminated `[[` never swallows the rest of the body. The `g` flag drives
 * the global scan.
 */
const WIKI_LINK_TOKEN = /\[\[([^\][]+?)\]\]/g;

/**
 * Reduce a raw `[[ … ]]` body to its target slug, or `null` when nothing usable remains.
 *
 * The body is the link *target*, optionally followed by a `|display text` alias (kept out of the
 * edge — it's presentation) and/or a `#heading` anchor (an in-page jump, not a separate article). We
 * take the substring before the first `|` or `#`, then normalize it with {@link slugify} so a
 * human-typed `[[Network Setup]]` resolves to the `network-setup` slug exactly as a derived title
 * would. Returns `null` for an empty/anchor-only token (e.g. `[[#section]]`, `[[ ]]`) so the caller
 * drops it rather than minting a meaningless edge.
 */
function targetSlugOf(body: string): string | null {
  // Strip a `|display` alias and a `#heading` anchor — both are non-target presentation.
  const target = body.split("|")[0].split("#")[0];
  const slug = slugify(target);
  return slug === "" ? null : slug;
}

/**
 * Extract the **distinct** target slugs of every `[[slug]]` wiki-link in a markdown body, in
 * first-seen order. Each token is reduced to its slug via {@link targetSlugOf} (alias/anchor
 * stripped, then `slugify`d), so the output is always a list of valid slugs (each matches
 * {@link SLUG_REGEX}) with no duplicates — the exact set the `ArticleWikiLink` rebuild inserts as
 * `targetSlug` rows for one source article (ADR-0059 §3).
 *
 * De-duplication is by slug: `[[Network Setup]]` and `[[network-setup]]` collapse to one edge, since
 * they resolve to the same target. An empty/anchor-only token contributes nothing. Pure: no I/O, no
 * resolution — matching a slug to a live article id is the caller's (DB) job.
 */
export function parseWikiLinks(content: string): string[] {
  const seen = new Set<string>();
  const slugs: string[] = [];
  for (const match of content.matchAll(WIKI_LINK_TOKEN)) {
    const slug = targetSlugOf(match[1]);
    if (slug !== null && !seen.has(slug)) {
      seen.add(slug);
      slugs.push(slug);
    }
  }
  return slugs;
}
