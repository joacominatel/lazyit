import { getTranslations } from "next-intl/server";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { ArticleForm } from "../_components/article-form";

// ponytail: no data read — empty create form; nothing to SSR-prefetch (#662).
export default async function NewArticlePage() {
  const t = await getTranslations("kb");
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: t("breadcrumb"), href: "/kb" },
              { label: t("form.newCrumb") },
            ]}
          />
        }
        title={t("form.newTitle")}
        subtitle={t("form.newSubtitle")}
      />
      <ArticleForm />
    </div>
  );
}
