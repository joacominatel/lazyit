"use client";

import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAsset } from "@/lib/api/hooks/use-assets";
import { AssetForm } from "../../_components/asset-form";

export default function EditAssetPage() {
  const params = useParams<{ id: string }>();
  const { data: asset, isLoading, isError } = useAsset(params.id);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        <Skeleton className="h-8 w-1/3" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (isError || !asset) {
    return (
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
        <p className="text-sm font-medium">Asset not found</p>
        <p className="text-sm text-muted-foreground">It may have been deleted.</p>
        <Button variant="outline" asChild>
          <Link href="/assets">
            <ArrowLeftIcon />
            Back to Assets
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-1">
        <Button variant="ghost" size="sm" asChild className="-ml-2">
          <Link href={`/assets/${asset.id}`}>
            <ArrowLeftIcon />
            {asset.name}
          </Link>
        </Button>
        <h1 className="text-2xl font-semibold tracking-tight">Edit asset</h1>
      </div>
      <AssetForm asset={asset} />
    </div>
  );
}
