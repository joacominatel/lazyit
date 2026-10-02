import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { PurchaseForm } from "../_components/purchase-form";

// No data read — an empty create form. The layout's route-driven breadcrumb already reads
// "Purchases › New" for this path.
export default async function NewPurchasePage() {
  const t = await getTranslations("purchases.form");
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t("newTitle")} subtitle={t("newSubtitle")} />
      <PurchaseForm />
    </div>
  );
}
