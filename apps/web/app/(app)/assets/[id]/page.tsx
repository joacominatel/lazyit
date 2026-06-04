"use client";

import {
  ArrowPathIcon,
  DocumentDuplicateIcon,
  PencilSquareIcon,
  TrashIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import type { AssetAssignmentWithUser } from "@lazyit/shared";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailField, DetailPanel, DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { Breadcrumb } from "@/components/breadcrumb";
import { RelatedArticlesPanel } from "@/components/related-articles-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { UserAvatar } from "@/components/user-avatar";
import { ErrorState } from "@/components/resource-table";
import { useCan } from "@/lib/hooks/use-permissions";
import { useAsset, useAssetAssignments } from "@/lib/api/hooks/use-assets";
import { useDeleteAsset } from "@/lib/api/hooks/use-asset-mutations";
import { useReleaseAssignment } from "@/lib/api/hooks/use-asset-assignment-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { formatDate, formatFieldLabel, formatSpecValue } from "@/lib/utils/format";
import { AssetHistoryTimeline } from "../_components/asset-history-timeline";
import { AssetStatusBadge } from "../_components/asset-status-badge";
import { AssignUserDialog } from "../_components/assign-user-dialog";

function ownerName(assignment: AssetAssignmentWithUser): string {
  return `${assignment.user.firstName} ${assignment.user.lastName}`;
}

export default function AssetDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  // Edit/Clone + asset-assignment create/release are asset:write; deletion is asset:delete.
  const canWrite = useCan("asset:write");
  const canDelete = useCan("asset:delete");

  const { data: asset, isLoading, isError, error, refetch } = useAsset(id);
  // All assignments (active + released), each with its user, for owners + history.
  const { data: assignments } = useAssetAssignments(id, false);
  const release = useReleaseAssignment();
  const deleteAsset = useDeleteAsset();

  const [assignOpen, setAssignOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [releasingId, setReleasingId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl">
        <DetailSkeleton panels={3} />
      </div>
    );
  }

  if (isError || !asset) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorState
          title="Asset not found"
          description="It may have been deleted, or the API is unreachable."
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  const active = (assignments ?? []).filter((a) => a.releasedAt === null);
  const history = (assignments ?? []).filter((a) => a.releasedAt !== null);
  const specsEntries = Object.entries(asset.specs ?? {});

  function handleRelease(assignmentId: string) {
    setReleasingId(assignmentId);
    release.mutate(
      { id: assignmentId },
      {
        onSuccess: () => {
          toast.success("Owner released");
          setReleasingId(null);
        },
        onError: (error) => {
          notifyError(error, "Couldn't release the owner");
          setReleasingId(null);
        },
      },
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: "Assets", href: "/assets" },
              { label: asset.name },
            ]}
          />
        }
        title={asset.name}
        subtitle={
          asset.assetTag ? (
            <span className="inline-flex items-center gap-1">
              <span className="font-mono">{asset.assetTag}</span>
              <CopyButton
                value={asset.assetTag}
                label="Copy asset tag"
                className="-my-1"
              />
            </span>
          ) : undefined
        }
        badge={<AssetStatusBadge status={asset.status} />}
        actions={
          canWrite || canDelete ? (
            <>
              {canWrite ? (
                <>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/assets/${asset.id}/edit`}>
                      <PencilSquareIcon />
                      Edit
                    </Link>
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/assets/${asset.id}/clone`}>
                      <DocumentDuplicateIcon />
                      Clone
                    </Link>
                  </Button>
                </>
              ) : null}
              {canDelete ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete asset"
                  onClick={() => setDeleteOpen(true)}
                >
                  <TrashIcon />
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />

      <DetailPanel title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <DetailField label="Model">
            {asset.model ? (
              // No server `model` filter on the asset list — deep-link the model to its category
              // (the closest filter that exists), falling back to plain text when uncategorized.
              asset.model.category ? (
                <Link
                  href={`/assets?category=${asset.model.category.id}`}
                  className="hover:underline"
                >
                  {asset.model.manufacturer} {asset.model.name}
                </Link>
              ) : (
                `${asset.model.manufacturer} ${asset.model.name}`
              )
            ) : (
              "—"
            )}
          </DetailField>
          <DetailField label="Category">
            {asset.model?.category ? (
              <Link
                href={`/assets?category=${asset.model.category.id}`}
                className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Badge variant="outline" className="hover:bg-muted">
                  {asset.model.category.name}
                </Badge>
              </Link>
            ) : (
              "—"
            )}
          </DetailField>
          <DetailField label="Location">
            {asset.location ? (
              <Link
                href={`/locations/${asset.location.id}`}
                className="hover:underline"
              >
                {asset.location.name}
              </Link>
            ) : (
              "—"
            )}
          </DetailField>
          <DetailField label="Serial">
            {asset.serial ? (
              <span className="inline-flex items-center gap-1">
                <span className="font-mono">{asset.serial}</span>
                <CopyButton
                  value={asset.serial}
                  label="Copy serial"
                  className="-my-1"
                />
              </span>
            ) : (
              <span className="font-mono">—</span>
            )}
          </DetailField>
          <DetailField label="Asset tag">
            {asset.assetTag ? (
              <span className="inline-flex items-center gap-1">
                <span className="font-mono">{asset.assetTag}</span>
                <CopyButton
                  value={asset.assetTag}
                  label="Copy asset tag"
                  className="-my-1"
                />
              </span>
            ) : (
              <span className="font-mono">—</span>
            )}
          </DetailField>
          <DetailField label="Purchase date">
            {asset.purchaseDate ? formatDate(asset.purchaseDate) : "—"}
          </DetailField>
          <DetailField label="Warranty end">
            {asset.warrantyEnd ? formatDate(asset.warrantyEnd) : "—"}
          </DetailField>
        </dl>
        {asset.notes && (
          <div className="mt-4 space-y-1">
            <dt className="text-xs font-medium text-muted-foreground">Notes</dt>
            <dd className="text-sm whitespace-pre-wrap">{asset.notes}</dd>
          </div>
        )}
      </DetailPanel>

      <DetailPanel title="Custom fields">
        {specsEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No custom fields recorded.
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {specsEntries.map(([key, value]) => (
              <div key={key} className="space-y-1">
                <dt className="text-xs font-medium text-muted-foreground">
                  {formatFieldLabel(key) || key}
                </dt>
                <dd className="text-sm break-words">{formatSpecValue(value)}</dd>
              </div>
            ))}
          </dl>
        )}
      </DetailPanel>

      <DetailPanel
        title="Owners"
        actions={
          canWrite ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAssignOpen(true)}
            >
              <UserPlusIcon />
              Assign user
            </Button>
          ) : undefined
        }
      >
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active owners. Assign someone to track who holds this asset.
          </p>
        ) : (
          <ul className="divide-y">
            {active.map((assignment) => {
              const gone = assignment.user.deletedAt != null;
              return (
                <li
                  key={assignment.id}
                  className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <UserAvatar
                      firstName={assignment.user.firstName}
                      lastName={assignment.user.lastName}
                      email={assignment.user.email}
                      className={gone ? "opacity-50 grayscale" : undefined}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <Link
                          href={`/users/${assignment.userId}`}
                          className="truncate font-medium hover:underline"
                        >
                          {ownerName(assignment)}
                        </Link>
                        {gone && (
                          <Badge variant="outline" className="text-muted-foreground">
                            Deactivated
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-sm text-muted-foreground">
                        {assignment.notes
                          ? assignment.notes
                          : `Assigned ${formatDate(assignment.assignedAt)}`}
                      </p>
                    </div>
                  </div>
                  {canWrite && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleRelease(assignment.id)}
                      disabled={release.isPending}
                    >
                      {releasingId === assignment.id && (
                        <ArrowPathIcon className="animate-spin" />
                      )}
                      Release
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DetailPanel>

      <RelatedArticlesPanel assetId={asset.id} />

      <DetailPanel title="Activity">
        <AssetHistoryTimeline assetId={asset.id} />
      </DetailPanel>

      {history.length > 0 && (
        <DetailPanel title="Ownership history">
          <ul className="divide-y text-sm">
            {history.map((assignment) => (
              <li
                key={assignment.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
              >
                <Link
                  href={`/users/${assignment.userId}`}
                  className="font-medium hover:underline"
                >
                  {ownerName(assignment)}
                </Link>
                <span className="tabular-nums text-muted-foreground">
                  {formatDate(assignment.assignedAt)} →{" "}
                  {assignment.releasedAt
                    ? formatDate(assignment.releasedAt)
                    : "—"}
                </span>
                {assignment.notes && (
                  <span className="w-full text-muted-foreground">
                    {assignment.notes}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </DetailPanel>
      )}

      <AssignUserDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        assetId={asset.id}
        excludeUserIds={active.map((a) => a.userId)}
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        entityLabel="asset"
        name={asset.name}
        onConfirm={() => deleteAsset.mutateAsync(asset.id)}
        onDeleted={() => router.push("/assets")}
      />
    </div>
  );
}
