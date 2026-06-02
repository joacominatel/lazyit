import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { ConsumableForm } from "../_components/consumable-form";

export default function NewConsumablePage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: "Consumables", href: "/consumables" },
              { label: "New" },
            ]}
          />
        }
        title="New consumable"
      />
      <ConsumableForm />
    </div>
  );
}
