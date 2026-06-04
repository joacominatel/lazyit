import { getTranslations } from "next-intl/server";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { ApplicationForm } from "../_components/application-form";

export default async function NewApplicationPage() {
  const t = await getTranslations("applications");
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: t("list.title"), href: "/applications" },
              { label: t("form.breadcrumbNew") },
            ]}
          />
        }
        title={t("form.newTitle")}
      />
      <ApplicationForm />
    </div>
  );
}
