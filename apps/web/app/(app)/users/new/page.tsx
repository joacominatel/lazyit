import { getTranslations } from "next-intl/server";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { UserCreateForm } from "../_components/user-create-form";

export default async function NewUserPage() {
  const t = await getTranslations("users");
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: t("list.title"), href: "/users" },
              { label: t("create.breadcrumb") },
            ]}
          />
        }
        title={t("create.title")}
        subtitle={t("create.subtitle")}
      />
      <UserCreateForm />
    </div>
  );
}
