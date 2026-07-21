import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { parseKbNewPrefill } from "@/lib/utils/kb-wiki-link-prefill";
import { ArticleForm } from "../_components/article-form";

// ponytail: no data read — empty create form; nothing to SSR-prefetch (#662).
// No `breadcrumb` prop here: the layout-level route-driven <Breadcrumb /> (app/(app)/layout.tsx)
// already derives "Knowledge Base › New" for this exact path from KNOWN_SEGMENTS — an explicit
// PageHeader breadcrumb with the same labels rendered a visible duplicate above it (#945).
//
// #1106 Phase 4: a create-on-click from an unresolved `[[slug]]` arrives as `?slug=…&title=…`.
// `parseKbNewPrefill` VALIDATES + SANITIZES those untrusted params (slug must match the slug rules,
// title trimmed/bounded) before they seed the form — a crafted URL can never inject into it.
export default async function NewArticlePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await getTranslations("kb");
  const prefill = parseKbNewPrefill(await searchParams);
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t("form.newTitle")} subtitle={t("form.newSubtitle")} />
      <ArticleForm prefill={prefill} />
    </div>
  );
}
