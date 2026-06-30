import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { getManualCategories } from "@/lib/manual/loader";

/**
 * Help / Manual index (ADR-0062 — public product documentation). Lists every Manual page in the
 * nested Category → Subcategory → page IA (issue #563), in importance order, driven entirely by the
 * markdown trees at `apps/web/content/manual/<locale>/*.md` + the manifest (`content/manual/_nav.ts`).
 * Public, login-free (the `(marketing)` route group + the `isPublicPath` allowance in `proxy.ts`),
 * and secret-free.
 *
 * The persistent sidebar (search + nested nav) is provided by the segment `layout.tsx` (issue #560);
 * this page renders only the content column — a welcome header plus the category index as a landing
 * list. Display labels live in i18n (`help.json`), resolved here via `getTranslations`. Server
 * Component: it reads the filesystem via the server-only loader and resolves the active locale from
 * the `NEXT_LOCALE` cookie. `force-dynamic` so a new/edited markdown page (and a cookie-driven locale
 * switch) is reflected without a rebuild — the content tree is small, so per-request reads are cheap.
 */
export const dynamic = "force-dynamic";

export default async function HelpIndexPage() {
  const [t, categories] = await Promise.all([getTranslations("help"), getManualCategories()]);

  return (
    <section className="flex w-full max-w-3xl flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          {t("index.title")}
        </h1>
        <p className="text-pretty text-muted-foreground">{t("index.subtitle")}</p>
      </header>

      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("index.empty")}</p>
      ) : (
        <div className="flex flex-col gap-10">
          {categories.map((category) => (
            <div key={category.category} className="flex flex-col gap-4">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {t(`categories.${category.category}` as never)}
              </h2>
              <div className="flex flex-col gap-5">
                {category.subcategories.map((subcategory) => (
                  <div
                    key={subcategory.subcategory}
                    className="flex flex-col gap-2"
                  >
                    <h3 className="text-xs font-medium text-muted-foreground/80">
                      {t(
                        `subcategories.${category.category}.${subcategory.subcategory}` as never,
                      )}
                    </h3>
                    <ul className="flex flex-col gap-1">
                      {subcategory.pages.map((page) => (
                        <li key={page.slug}>
                          <Link
                            href={`/help/${page.slug}`}
                            // ponytail: neutral resting links (oxblood stays reserved); the accent + underline land on hover only, so the index isn't a wall of brand color.
                            className="text-sm font-medium text-foreground underline-offset-2 transition-colors hover:text-primary hover:underline"
                          >
                            {page.frontmatter.title}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
