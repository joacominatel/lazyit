import { getTranslations } from "next-intl/server";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { ConsumableForm } from "../_components/consumable-form";

export default async function NewConsumablePage() {
  const t = await getTranslations("consumables");
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: t("list.title"), href: "/consumables" },
              { label: t("form.breadcrumbNew") },
            ]}
          />
        }
        title={t("form.newTitle")}
      />
      <ConsumableForm />
    </div>
  );
}
