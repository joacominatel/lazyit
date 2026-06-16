import { getTranslations } from "next-intl/server";
import Link from "next/link";

import { getManualSections } from "@/lib/manual/loader";

/**
 * Help / Manual index (ADR-0062 — public product documentation). Lists every Manual page
 * grouped by its `section` frontmatter bucket and sorted by `order`, driven entirely by the
 * markdown trees at `apps/web/content/manual/<locale>/*.md`. Public, login-free (the
 * `(marketing)` route group + the `isPublicPath` allowance in `proxy.ts`), and secret-free.
 *
 * The persistent sidebar (search + section nav) is provided by the segment `layout.tsx` (issue
 * #560); this page renders only the content column — a welcome header plus the section index as a
 * landing list. Server Component: it reads the filesystem via the server-only loader and resolves
 * the active locale from the `NEXT_LOCALE` cookie. `force-dynamic` so a new/edited markdown page (and
 * a cookie-driven locale switch) is reflected without a rebuild — the content tree is a small,
 * in-repo set, so per-request reads are cheap.
 */
export const dynamic = "force-dynamic";

export default async function HelpIndexPage() {
  const t = await getTranslations("help");
  const sections = await getManualSections();

  return (
    <section className="flex w-full max-w-3xl flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight text-balance">
          {t("index.title")}
        </h1>
        <p className="text-pretty text-muted-foreground">{t("index.subtitle")}</p>
      </header>

      {sections.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("index.empty")}</p>
      ) : (
        <div className="flex flex-col gap-8">
          {sections.map((section) => (
            <div key={section.section} className="flex flex-col gap-3">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {section.section}
              </h2>
              <ul className="flex flex-col gap-1">
                {section.pages.map((page) => (
                  <li key={page.slug}>
                    <Link
                      href={`/help/${page.slug}`}
                      className="text-sm font-medium text-primary underline-offset-2 hover:underline"
                    >
                      {page.frontmatter.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
