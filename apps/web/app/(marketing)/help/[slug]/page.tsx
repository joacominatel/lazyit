import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { MarkdownView } from "@/components/markdown-view";
import { getManualPage } from "@/lib/manual/loader";

/**
 * A single Help / Manual page (ADR-0062). Renders one markdown file from
 * `apps/web/content/manual/<locale>/<slug>.md` through `MarkdownView` with
 * `disableKbExtensions` — so KB-only tokens (`[[slug]]` wiki-links, `{{ lazyit_secret.* }}`
 * chips) render as literal text and the page never touches an `Article` row or a vault
 * (ADR-0062 §2/§3). Public, login-free, secret-free.
 *
 * The persistent sidebar (search + section nav) is provided by the segment `layout.tsx` (issue
 * #560); this page renders only the content column. Server Component: the active locale comes from
 * the `NEXT_LOCALE` cookie via the server-only loader, which applies the es→en fallback (ADR-0062
 * §4). An unknown slug → `notFound()`. `force-dynamic` mirrors the index so content edits and locale
 * switches show without a rebuild.
 */
export const dynamic = "force-dynamic";

export default async function HelpPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = await getManualPage(slug);
  if (!page) notFound();

  const t = await getTranslations("help");

  return (
    <article className="flex w-full max-w-3xl flex-col gap-6">
      <Link
        href="/help"
        className="text-sm font-medium text-muted-foreground underline-offset-2 hover:underline"
      >
        ← {t("nav.backToIndex")}
      </Link>

      {page.isFallback && (
        <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {t("page.fallbackNotice")}
        </p>
      )}

      <MarkdownView content={page.content} disableKbExtensions />
    </article>
  );
}
