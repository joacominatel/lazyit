/**
 * Pure, IO-free logic for the Help / Manual surface (ADR-0062). Kept separate from the
 * filesystem loader (`loader.ts`) so it can be unit-tested without touching disk or
 * `next/headers`. Two responsibilities:
 *
 *  1. Locale resolution + es→en fallback (ADR-0062 §4 / ADR-0051): which locale a page's
 *     body should be read from, given which locales actually have the file on disk.
 *  2. Sorting + grouping the page summaries into the section index the `/help` page renders.
 */
import { defaultLocale, type Locale } from "@/i18n/config";
import type { ManualPageSummary, ManualSection } from "./types";

/** Outcome of resolving which locale's file to read for a page. */
export interface LocaleResolution {
  /** The locale whose file should actually be read. */
  locale: Locale;
  /** `true` when we fell back to `defaultLocale` because the requested locale's file was absent. */
  isFallback: boolean;
}

/**
 * Resolve which locale's markdown file to read for a single page, applying the ADR-0062 §4
 * fallback: prefer the requested locale; if that file is missing, fall back to the default
 * (`en`). Returns `null` ONLY when the page exists in NEITHER the requested locale NOR the
 * default — i.e. there is nothing to render (the caller maps that to a 404).
 *
 * PURE: it does not read disk. The caller passes the set of locales that DO have the file
 * (`availableLocales`), so this whole decision is testable in isolation.
 *
 * A fallback (`isFallback: true`) is a documentation DEFECT — a page present in `en` but
 * missing in `es` — surfaced as a dev warning by the loader and caught by the parity script.
 */
export function resolvePageLocale(
  requested: Locale,
  availableLocales: readonly Locale[],
): LocaleResolution | null {
  if (availableLocales.includes(requested)) {
    return { locale: requested, isFallback: false };
  }
  if (availableLocales.includes(defaultLocale)) {
    return { locale: defaultLocale, isFallback: true };
  }
  return null;
}

/**
 * Deterministic page ordering WITHIN a section: ascending `order`, then a stable alphabetical
 * tiebreak on `title` and finally `slug` so the index never reshuffles between renders when two
 * pages share an `order`.
 */
export function compareManualPages(
  a: ManualPageSummary,
  b: ManualPageSummary,
): number {
  if (a.frontmatter.order !== b.frontmatter.order) {
    return a.frontmatter.order - b.frontmatter.order;
  }
  const byTitle = a.frontmatter.title.localeCompare(b.frontmatter.title);
  if (byTitle !== 0) return byTitle;
  return a.slug.localeCompare(b.slug);
}

/**
 * Group a flat list of page summaries into the section index the `/help` page renders:
 * one bucket per distinct `section`, each bucket's pages sorted by {@link compareManualPages}.
 *
 * Section ORDER on the page is the minimum `order` of the pages it contains (so the section
 * whose first page sorts first appears first), with an alphabetical tiebreak on the section
 * name — giving authors a single lever (`order`) to drive both intra- and inter-section sort.
 * PURE: no IO.
 */
export function groupIntoSections(
  pages: readonly ManualPageSummary[],
): ManualSection[] {
  const buckets = new Map<string, ManualPageSummary[]>();
  for (const page of pages) {
    const key = page.frontmatter.section;
    const existing = buckets.get(key);
    if (existing) {
      existing.push(page);
    } else {
      buckets.set(key, [page]);
    }
  }

  const sections: ManualSection[] = [...buckets.entries()].map(
    ([section, sectionPages]) => ({
      section,
      pages: [...sectionPages].sort(compareManualPages),
    }),
  );

  // Inter-section order: by the smallest `order` in each section, then by name.
  sections.sort((a, b) => {
    const minA = Math.min(...a.pages.map((p) => p.frontmatter.order));
    const minB = Math.min(...b.pages.map((p) => p.frontmatter.order));
    if (minA !== minB) return minA - minB;
    return a.section.localeCompare(b.section);
  });

  return sections;
}
