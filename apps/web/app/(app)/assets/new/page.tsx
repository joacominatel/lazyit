import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { AssetForm } from "../_components/asset-form";

export default function NewAssetPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[{ label: "Assets", href: "/assets" }, { label: "New" }]}
          />
        }
        title="New asset"
        subtitle="Register a tracked thing. You can assign owners once it exists."
      />
      <AssetForm />
    </div>
  );
}
