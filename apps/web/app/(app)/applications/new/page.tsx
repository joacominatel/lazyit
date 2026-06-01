import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { ApplicationForm } from "../_components/application-form";

export default function NewApplicationPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: "Access", href: "/applications" },
              { label: "New" },
            ]}
          />
        }
        title="New application"
      />
      <ApplicationForm />
    </div>
  );
}
