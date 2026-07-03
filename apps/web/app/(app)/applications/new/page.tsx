import { getTranslations } from "next-intl/server";
import { PageHeader } from "@/components/page-header";
import { ApplicationForm } from "../_components/application-form";

// ponytail: no data read — empty create form; nothing to SSR-prefetch (ADR-0067 rollout #662).
// No `breadcrumb` prop here: the layout-level route-driven <Breadcrumb /> (app/(app)/layout.tsx)
// already derives "Applications › New" for this exact path from KNOWN_SEGMENTS — an explicit
// PageHeader breadcrumb rendered a visible duplicate above it (#972).
export default async function NewApplicationPage() {
  const t = await getTranslations("applications");
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t("form.newTitle")} />
      <ApplicationForm />
    </div>
  );
}
