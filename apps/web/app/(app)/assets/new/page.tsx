import { getTranslations } from "next-intl/server";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { AssetForm } from "../_components/asset-form";

// ponytail: no data read — empty create form; nothing to SSR-prefetch (ADR-0067 rollout #662).
export default async function NewAssetPage() {
  const t = await getTranslations("assets");
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: t("list.title"), href: "/assets" },
              { label: t("form.breadcrumbNew") },
            ]}
          />
        }
        title={t("form.newTitle")}
        subtitle={t("form.newSubtitle")}
      />
      <AssetForm />
    </div>
  );
}
