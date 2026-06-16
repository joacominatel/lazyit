/**
 * Help / Manual content model (ADR-0062 — the public, code-versioned product documentation
 * surface). These types live in `apps/web` ONLY: the Manual is web-only markdown with no API,
 * no DB and no `@lazyit/shared` contract (ADR-0062 §2). The frontmatter is the page metadata;
 * the markdown body is the content.
 *
 * The IA is a TWO-LEVEL tree (issue #563): Category → Subcategory → page, ordered by the manifest
 * `content/manual/_nav.ts`. Frontmatter carries stable kebab-case KEYS (`category`, `subcategory`);
 * the human display labels live in i18n (`messages/<locale>/help.json`), NOT in frontmatter.
 */
import type { Locale } from "@/i18n/config";

/**
 * The frontmatter every Manual markdown file MUST carry (YAML, at the top of the file).
 * The parser is deliberately TOLERANT of extra fields — authors may add their own keys and
 * the loader keeps them — so this is the guaranteed-present subset the surface relies on.
 *
 *  - `title`       — the page's human title (shown in the nav index and as the page heading).
 *  - `order`       — sort weight WITHIN a subcategory (ascending; ties fall back to title, then slug).
 *  - `category`    — the stable category KEY (kebab-case) from the manifest; the display label
 *                    lives at `categories.<category>` in `help.json`.
 *  - `subcategory` — the stable subcategory KEY (kebab-case), scoped under `category`; the display
 *                    label lives at `subcategories.<category>.<subcategory>` in `help.json`.
 */
export interface ManualFrontmatter {
  title: string;
  order: number;
  category: string;
  subcategory: string;
  /** Authors may add extra frontmatter keys; they are preserved but not interpreted here. */
  [key: string]: unknown;
}

/** A single Manual page: its URL slug, resolved frontmatter and (when loaded) its markdown body. */
export interface ManualPage {
  /** URL slug — the markdown file's basename without `.md` (e.g. `getting-started`). */
  slug: string;
  /** The locale the body was actually read from — may differ from the requested one on fallback. */
  resolvedLocale: Locale;
  /** `true` when the requested locale's file was missing and we fell back to the default (`en`). */
  isFallback: boolean;
  frontmatter: ManualFrontmatter;
  /** The markdown body (frontmatter stripped). Only populated by `getManualPage`, not by listings. */
  content: string;
}

/** Lightweight page descriptor used to build the nav index (no body — listing only). */
export type ManualPageSummary = Omit<ManualPage, "content">;

/**
 * A subcategory bucket: its stable key (the i18n label is resolved at render time) and its pages,
 * sorted by `order`. Only subcategories with ≥1 page are emitted by the loader.
 */
export interface ManualSubcategory {
  /** The subcategory KEY — its label is `subcategories.<category>.<subcategory>` in `help.json`. */
  subcategory: string;
  pages: ManualPageSummary[];
}

/**
 * A category bucket in the nested `/help` IA (issue #563): its stable key (label resolved at render
 * time via i18n) and its ordered, non-empty subcategories. Categories and subcategories are emitted
 * in manifest order; only those with ≥1 page appear.
 */
export interface ManualCategory {
  /** The category KEY — its label is `categories.<category>` in `help.json`. */
  category: string;
  subcategories: ManualSubcategory[];
}
