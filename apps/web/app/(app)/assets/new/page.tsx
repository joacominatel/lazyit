import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { AssetForm } from "../_components/asset-form";

// ponytail: no data read — empty create form; nothing to SSR-prefetch (ADR-0067 rollout #662).
// No `breadcrumb` prop here: the layout-level route-driven <Breadcrumb /> (app/(app)/layout.tsx)
// already derives "Assets › New" for this exact path from KNOWN_SEGMENTS — an explicit PageHeader
// breadcrumb with the same labels rendered a visible duplicate above it (#972).
export default async function NewAssetPage() {
  const t = await getTranslations("assets");
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t("form.newTitle")} subtitle={t("form.newSubtitle")} />
      <AssetForm />
    </div>
  );
}
