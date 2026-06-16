/**
 * Pure, IO-free client-side search logic for the Help / Manual surface (ADR-0062 §6). This is the
 * SIMPLE, in-memory filter deliberately chosen over Meilisearch — ADR-0062 §6 defers full-text
 * search to a later iteration. There is NO server call and NO Meili index here: the loader builds a
 * tiny per-locale index at request time (`buildManualSearchIndex`) and the client `<HelpSearch>`
 * filters it locally as the user types.
 *
 * Kept separate from the filesystem loader (mirroring `resolve.ts`) so the normalize/rank decision is
 * unit-testable without disk or `next/headers`. Two responsibilities:
 *
 *  1. {@link normalizeForSearch} — accent-insensitive, lowercase folding so "configuracion" matches
 *     "configuración" (NFD-decompose, strip combining diacritics, lowercase).
 *  2. {@link searchManual} — substring match across the index with TITLE-FIRST ranking
 *     (title > category > subcategory > heading > excerpt).
 */
import type { Locale } from "@/i18n/config";

/**
 * One Manual page distilled into the searchable fields the client filters over. Built server-side by
 * `buildManualSearchIndex` (loader) from frontmatter + the markdown body, then passed as a plain prop
 * to the client `<HelpSearch>` — so the whole index is a small, serializable array.
 *
 *  - `slug`        — the page's URL slug; the result links to `/help/<slug>`.
 *  - `title`       — frontmatter title (the strongest match signal).
 *  - `category`    — the LOCALIZED category label (resolved from `categories.<key>` in `help.json`).
 *  - `subcategory` — the LOCALIZED subcategory label (resolved from `subcategories.<cat>.<key>`).
 *  - `headings`    — the `#`/`##`/… heading texts extracted from the body (plaintext, syntax stripped).
 *  - `excerpt`     — a short plaintext lead of the body (frontmatter + markdown syntax stripped, capped).
 *  - `resolvedLocale` / `isFallback` — which locale the body was read from (an `es` page may fall back
 *    to `en` — ADR-0062 §4); carried so the UI could flag a fallback result if it wants to.
 */
export interface ManualSearchEntry {
  slug: string;
  title: string;
  category: string;
  subcategory: string;
  headings: string[];
  excerpt: string;
  resolvedLocale: Locale;
  isFallback: boolean;
}

/** A scored search hit: the matched entry plus where the match landed (drives the title-first sort). */
export interface ManualSearchResult {
  entry: ManualSearchEntry;
  /** Lower is better — the field bucket the match was found in (0 = title … 3 = excerpt). */
  rank: number;
}

/**
 * Fold a string for accent-insensitive, case-insensitive substring matching:
 * NFD-decompose so accented letters split into a base char + a combining mark, strip the combining
 * marks (Unicode block U+0300–U+036F), then lowercase. So `normalizeForSearch("Configuración")` and a
 * user typing `configuracion` both reduce to `configuracion` and match.
 *
 * PURE: no IO, no locale data — a deterministic Unicode transform, safe to run on every keystroke.
 */
export function normalizeForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

/** Rank buckets — the lower the value, the earlier the result sorts (title beats everything). */
const RANK_TITLE = 0;
const RANK_CATEGORY = 1;
const RANK_SUBCATEGORY = 2;
const RANK_HEADING = 3;
const RANK_EXCERPT = 4;

/**
 * Filter + rank the index for a query, TITLE-FIRST (ADR-0062 §6). Both the query and every field are
 * run through {@link normalizeForSearch}, so matching is accent- and case-insensitive substring.
 *
 * Ranking, best to worst: a title hit (0) beats a category hit (1) beats a subcategory hit (2) beats a
 * heading hit (3) beats an excerpt-only hit (4). Each entry contributes AT MOST ONE result, at its
 * best-matching field. Ties within a rank keep a stable, deterministic order: alphabetical by title,
 * then slug.
 *
 * An empty/whitespace query returns `[]` — the caller treats that as "not searching" and shows the
 * full nav instead of a results list. PURE: no IO; safe to call on every keystroke.
 */
export function searchManual(
  index: readonly ManualSearchEntry[],
  query: string,
): ManualSearchResult[] {
  const needle = normalizeForSearch(query);
  if (needle === "") return [];

  const results: ManualSearchResult[] = [];
  for (const entry of index) {
    const rank = bestRank(entry, needle);
    if (rank !== null) results.push({ entry, rank });
  }

  results.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const byTitle = a.entry.title.localeCompare(b.entry.title);
    if (byTitle !== 0) return byTitle;
    return a.entry.slug.localeCompare(b.entry.slug);
  });

  return results;
}

/**
 * The best (lowest) rank bucket at which `needle` matches `entry`, or `null` if it matches nowhere.
 * Checked in priority order so a page matching in its title outranks one matching only in its excerpt.
 * `needle` MUST already be normalized (`normalizeForSearch`) — `searchManual` does that once.
 */
function bestRank(entry: ManualSearchEntry, needle: string): number | null {
  if (normalizeForSearch(entry.title).includes(needle)) return RANK_TITLE;
  if (normalizeForSearch(entry.category).includes(needle)) return RANK_CATEGORY;
  if (normalizeForSearch(entry.subcategory).includes(needle)) {
    return RANK_SUBCATEGORY;
  }
  if (
    entry.headings.some((heading) =>
      normalizeForSearch(heading).includes(needle),
    )
  ) {
    return RANK_HEADING;
  }
  if (normalizeForSearch(entry.excerpt).includes(needle)) return RANK_EXCERPT;
  return null;
}

/** Default cap for the generated excerpt — long enough to be useful, short enough to stay a "lead". */
export const EXCERPT_MAX_LENGTH = 160;

/**
 * Pull the ATX heading texts (`#`, `##`, …) out of a markdown body, in document order, as plaintext.
 * Each line that starts with 1–6 `#` followed by a space is a heading; the leading `#`s and any
 * trailing `#`s are stripped, then the residual inline markdown is reduced to plain text via
 * {@link stripInlineMarkdown}. Blank results are dropped. PURE: a string transform, no IO.
 *
 * Setext (`===`/`---` underline) headings are intentionally NOT parsed — the Manual convention is ATX
 * (see manual-authoring.md), and ATX keeps this a cheap line scan with no look-behind.
 */
export function extractHeadings(markdown: string): string[] {
  const headings: string[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const text = stripInlineMarkdown(match[2]);
    if (text) headings.push(text);
  }
  return headings;
}

/**
 * Build a short, plaintext EXCERPT from a markdown body for the search index: drop fenced code blocks,
 * heading lines, blockquote markers and list bullets, flatten the remaining prose to a single
 * whitespace-collapsed line with inline markdown stripped, then cap at {@link EXCERPT_MAX_LENGTH}
 * (default) characters on a word boundary with an ellipsis. Returns `""` for an all-structure body.
 * PURE: no IO — the loader (which has already split frontmatter off via gray-matter) hands us the body.
 */
export function buildExcerpt(
  markdown: string,
  maxLength: number = EXCERPT_MAX_LENGTH,
): string {
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, " ");
  const prose = withoutCode
    .split("\n")
    .map((line) => line.trim())
    // Drop heading lines and horizontal rules — they aren't lead prose.
    .filter((line) => line !== "" && !/^#{1,6}\s/.test(line) && !/^([-*_])\1{2,}$/.test(line))
    // Strip leading blockquote / list / ordered-list markers so the prose reads cleanly.
    .map((line) =>
      line.replace(/^>\s?/, "").replace(/^[-*+]\s+/, "").replace(/^\d+\.\s+/, ""),
    )
    .join(" ");

  const flat = stripInlineMarkdown(prose).replace(/\s+/g, " ").trim();
  return truncateOnWord(flat, maxLength);
}

/**
 * Reduce common inline markdown to its visible text for indexing: `[label](url)` → `label`,
 * `![alt](url)` → `alt`, and the `*_~\`` emphasis/code marks dropped. Deliberately small — this is a
 * search-index normalizer, not a markdown parser; leftover stray punctuation is harmless to matching.
 */
function stripInlineMarkdown(value: string): string {
  return value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → label
    .replace(/[*_~`]+/g, "") // emphasis / inline-code marks
    .trim();
}

/**
 * Truncate to at most `maxLength` chars without splitting a word: cut at the last space before the cap
 * and append "…". Strings already within the cap pass through untouched.
 */
function truncateOnWord(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const slice = value.slice(0, maxLength);
  const lastSpace = slice.lastIndexOf(" ");
  const head = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  return `${head.trimEnd()}…`;
}
