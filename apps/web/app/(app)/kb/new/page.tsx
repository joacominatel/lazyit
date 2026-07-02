import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { ArticleForm } from "../_components/article-form";

// ponytail: no data read — empty create form; nothing to SSR-prefetch (#662).
// No `breadcrumb` prop here: the layout-level route-driven <Breadcrumb /> (app/(app)/layout.tsx)
// already derives "Knowledge Base › New" for this exact path from KNOWN_SEGMENTS — an explicit
// PageHeader breadcrumb with the same labels rendered a visible duplicate above it (#945).
export default async function NewArticlePage() {
  const t = await getTranslations("kb");
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t("form.newTitle")} subtitle={t("form.newSubtitle")} />
      <ArticleForm />
    </div>
  );
}
