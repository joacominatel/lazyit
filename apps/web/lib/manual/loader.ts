/**
 * Server-side Help / Manual content loader (ADR-0062). Reads the per-locale markdown trees at
 * `apps/web/content/manual/<locale>/*.md`, parses YAML frontmatter, and resolves the active
 * locale (with es→en fallback) for the page route and the `/help` index.
 *
 * SERVER-ONLY by construction: it imports `node:fs/promises` and `next-intl/server`, both of
 * which are server-only modules — importing this file into a Client Component is a build error.
 * The pure decision logic (locale fallback, sort, grouping) lives in `resolve.ts` so it stays
 * testable without disk; this file is the thin IO shell.
 *
 * The IA is a TWO-LEVEL tree (issue #563): Category → Subcategory → page, ordered by the manifest
 * `content/manual/_nav.ts`; the loader resolves the localized display labels (from `help.json`) for
 * the search index, but the nav components resolve their own labels client-side via `useTranslations`.
 *
 * The Manual is PUBLIC and SECRET-FREE by construction (ADR-0062 §3): this loader reads static
 * repo markdown and has no path to a session, a vault, or any `Article` row.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { getLocale, getTranslations } from "next-intl/server";
import { MANUAL_NAV_KEYS } from "@/content/manual/_nav";
import { defaultLocale, isLocale, type Locale, locales } from "@/i18n/config";
import { groupIntoCategories, resolvePageLocale } from "./resolve";
import { buildExcerpt, extractHeadings } from "./search";
import type { ManualSearchEntry } from "./search";
import type {
  ManualCategory,
  ManualFrontmatter,
  ManualPage,
  ManualPageSummary,
} from "./types";

/** Absolute path to the Manual content root. `process.cwd()` is the `apps/web` package root. */
const CONTENT_ROOT = path.join(process.cwd(), "content", "manual");

/** A slug is a single path segment of lowercase letters, digits and hyphens — no traversal. */
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Directory holding a locale's markdown tree. */
function localeDir(locale: Locale): string {
  return path.join(CONTENT_ROOT, locale);
}

/** Absolute file path for a (locale, slug) pair. Caller MUST have validated the slug first. */
function pageFile(locale: Locale, slug: string): string {
  return path.join(localeDir(locale), `${slug}.md`);
}

/**
 * Coerce raw gray-matter frontmatter into the guaranteed {@link ManualFrontmatter} subset,
 * TOLERANT of extra fields (they pass through untouched — ADR-0062 §2). Missing/blank values
 * get sensible, non-throwing defaults so a half-authored page never crashes the render: a
 * missing `title` falls back to the slug, a non-numeric `order` sorts last, and a missing
 * `category`/`subcategory` lands in a catch-all key the loader dev-warns about.
 */
function normalizeFrontmatter(
  raw: Record<string, unknown>,
  slug: string,
): ManualFrontmatter {
  const title =
    typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : slug;
  const order =
    typeof raw.order === "number" && Number.isFinite(raw.order)
      ? raw.order
      : Number.MAX_SAFE_INTEGER;
  const category =
    typeof raw.category === "string" && raw.category.trim()
      ? raw.category.trim()
      : "uncategorized";
  const subcategory =
    typeof raw.subcategory === "string" && raw.subcategory.trim()
      ? raw.subcategory.trim()
      : "general";
  return { ...raw, title, order, category, subcategory };
}

/** List the `.md` slugs present in a locale's tree. Returns `[]` if the directory is absent. */
async function listSlugs(locale: Locale): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(localeDir(locale));
  } catch {
    // No tree for this locale yet — treat as empty rather than throwing.
    return [];
  }
  return entries
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -".md".length))
    .filter((slug) => SLUG_RE.test(slug));
}

/** The set of locales that actually have a file for `slug`, used by the pure fallback resolver. */
async function availableLocalesForSlug(slug: string): Promise<Locale[]> {
  const checks = await Promise.all(
    locales.map(async (locale) => {
      try {
        await readFile(pageFile(locale, slug), "utf8");
        return locale;
      } catch {
        return null;
      }
    }),
  );
  return checks.filter((l): l is Locale => l !== null);
}

/** Read + parse a single (locale, slug) file. Returns `null` if it does not exist. */
async function readPage(
  locale: Locale,
  slug: string,
): Promise<{ frontmatter: ManualFrontmatter; content: string } | null> {
  let raw: string;
  try {
    raw = await readFile(pageFile(locale, slug), "utf8");
  } catch {
    return null;
  }
  const parsed = matter(raw);
  return {
    frontmatter: normalizeFrontmatter(
      parsed.data as Record<string, unknown>,
      slug,
    ),
    content: parsed.content,
  };
}

/**
 * Resolve the active locale from the `NEXT_LOCALE` cookie (ADR-0051 cookie-mode) via next-intl.
 * Narrows the value to a supported `Locale`, defaulting to `en` — so a stale/unknown cookie can
 * never point the loader at a non-existent tree.
 */
async function activeLocale(): Promise<Locale> {
  const value = await getLocale();
  return isLocale(value) ? value : defaultLocale;
}

/**
 * Load a single Manual page for the active locale, applying the es→en fallback (ADR-0062 §4).
 * Returns `null` when the slug is invalid or exists in no locale — the route maps that to a 404.
 * A fallback render logs a dev warning (a missing-translation documentation defect).
 */
export async function getManualPage(slug: string): Promise<ManualPage | null> {
  if (!SLUG_RE.test(slug)) return null;

  const [requested, available] = await Promise.all([activeLocale(), availableLocalesForSlug(slug)]);
  const resolution = resolvePageLocale(requested, available);
  if (!resolution) return null;

  const page = await readPage(resolution.locale, slug);
  if (!page) return null;

  if (resolution.isFallback && process.env.NODE_ENV !== "production") {
    console.warn(
      `[manual] page "${slug}" missing for locale "${requested}" — fell back to "${resolution.locale}". ` +
        `Add content/manual/${requested}/${slug}.md (run \`bun run check:manual-parity\`).`,
    );
  }

  return {
    slug,
    resolvedLocale: resolution.locale,
    isFallback: resolution.isFallback,
    frontmatter: page.frontmatter,
    content: page.content,
  };
}

/** Read only the frontmatter of every page that exists in the active locale or the `en` fallback. */
async function loadPageSummaries(): Promise<ManualPageSummary[]> {
  const requested = await activeLocale();

  // The union of slugs across the active locale and the default — so a page that exists only in
  // `en` still appears (via fallback) when browsing in `es` (ADR-0062 §4).
  const slugSet = new Set<string>([
    ...(await listSlugs(requested)),
    ...(await listSlugs(defaultLocale)),
  ]);

  const summaries = await Promise.all(
    [...slugSet].map(async (slug): Promise<ManualPageSummary | null> => {
      const available = await availableLocalesForSlug(slug);
      const resolution = resolvePageLocale(requested, available);
      if (!resolution) return null;
      const page = await readPage(resolution.locale, slug);
      if (!page) return null;
      return {
        slug,
        resolvedLocale: resolution.locale,
        isFallback: resolution.isFallback,
        frontmatter: page.frontmatter,
      };
    }),
  );

  return summaries.filter((s): s is ManualPageSummary => s !== null);
}

/**
 * Build the nested `/help` index for the active locale: every page that exists in EITHER the active
 * locale or the fallback (`en`), grouped into the Category → Subcategory → page tree in manifest
 * order via the pure {@link groupIntoCategories} (issue #563). Only NON-EMPTY buckets are emitted.
 *
 * Dev-warns when a page's `category`/`subcategory` is not in the manifest (`content/manual/_nav.ts`)
 * — such pages still render (sorted last) but are a content defect to fix.
 */
export async function getManualCategories(): Promise<ManualCategory[]> {
  const summaries = await loadPageSummaries();
  const categories = groupIntoCategories(summaries);

  if (process.env.NODE_ENV !== "production") {
    for (const page of summaries) {
      const cat = MANUAL_NAV_KEYS.get(page.frontmatter.category);
      if (!cat || !cat.has(page.frontmatter.subcategory)) {
        console.warn(
          `[manual] page "${page.slug}" has category/subcategory ` +
            `"${page.frontmatter.category}/${page.frontmatter.subcategory}" not in the manifest ` +
            `(content/manual/_nav.ts) — it renders last. Fix its frontmatter or add it to the manifest.`,
        );
      }
    }
  }

  return categories;
}

/**
 * Build the SIMPLE client-side search index for the active locale (ADR-0062 §6 — explicitly NOT
 * Meilisearch; full-text search is deferred). Mirrors {@link getManualCategories} (same slug union +
 * es→en per-page fallback) but reads the full body — not just the frontmatter — so it can extract the
 * page's headings and a short plaintext excerpt via the pure helpers in `search.ts`. Resolves the
 * LOCALIZED category/subcategory labels (from `help.json`) so search can match on what the user sees.
 *
 * The result is a small, plain-serializable array handed straight to the client `<HelpSearch>` as a
 * prop. There is NO server endpoint and NO network call: the entire filter runs in the browser over
 * this build-at-request-time index. SERVER-ONLY (it does disk IO + reads the locale cookie).
 */
export async function buildManualSearchIndex(): Promise<ManualSearchEntry[]> {
  const [summaries, t] = await Promise.all([
    loadPageSummaries(),
    getTranslations("help"),
  ]);

  // Resolve the localized label for a category/subcategory key. Every key in the manifest has a
  // label in `help.json` (parity-checked); a key NOT in the manifest (an orphan page) has none, so
  // we index it by its raw key rather than triggering next-intl's missing-message path.
  const categoryLabel = (key: string): string =>
    MANUAL_NAV_KEYS.has(key) ? t(`categories.${key}` as never) : key;
  const subcategoryLabel = (category: string, sub: string): string =>
    MANUAL_NAV_KEYS.get(category)?.has(sub)
      ? t(`subcategories.${category}.${sub}` as never)
      : sub;

  const entries = await Promise.all(
    summaries.map(async (summary): Promise<ManualSearchEntry | null> => {
      const page = await readPage(summary.resolvedLocale, summary.slug);
      if (!page) return null;
      const { category, subcategory } = page.frontmatter;
      return {
        slug: summary.slug,
        title: page.frontmatter.title,
        category: categoryLabel(category),
        subcategory: subcategoryLabel(category, subcategory),
        headings: extractHeadings(page.content),
        excerpt: buildExcerpt(page.content),
        resolvedLocale: summary.resolvedLocale,
        isFallback: summary.isFallback,
      };
    }),
  );

  return entries.filter((e): e is ManualSearchEntry => e !== null);
}
