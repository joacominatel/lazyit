import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AssetForm } from "../_components/asset-form";

export default function NewAssetPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href="/assets">
            <ArrowLeftIcon />
            Assets
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">New asset</h1>
        <p className="text-sm text-muted-foreground">
          Register a tracked thing. You can assign owners once it exists.
        </p>
      </div>
      <AssetForm />
    </div>
  );
}
