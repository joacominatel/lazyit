/**
 * Help / Manual content model (ADR-0062 — the public, code-versioned product documentation
 * surface). These types live in `apps/web` ONLY: the Manual is web-only markdown with no API,
 * no DB and no `@lazyit/shared` contract (ADR-0062 §2). The frontmatter is the page metadata;
 * the markdown body is the content.
 */
import type { Locale } from "@/i18n/config";

/**
 * The frontmatter every Manual markdown file MUST carry (YAML, at the top of the file).
 * The parser is deliberately TOLERANT of extra fields — authors may add their own keys and
 * the loader keeps them — so this is the guaranteed-present subset the surface relies on.
 *
 *  - `title`   — the page's human title (shown in the nav index and as the page heading).
 *  - `order`   — sort weight WITHIN a section (ascending; ties fall back to title, then slug).
 *  - `section` — the IA bucket the page belongs to (ADR-0062 §5: "Getting started",
 *                "Permissions", …). Pages are grouped by this on the `/help` index.
 */
export interface ManualFrontmatter {
  title: string;
  order: number;
  section: string;
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

/** A section bucket on the `/help` index: the IA name + its pages, sorted by `order`. */
export interface ManualSection {
  /** The `section` frontmatter value shared by every page in the bucket. */
  section: string;
  pages: ManualPageSummary[];
}
