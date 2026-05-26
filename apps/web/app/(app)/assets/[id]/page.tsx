"use client";

import {
  ArrowLeftIcon,
  ArrowPathIcon,
  PencilSquareIcon,
  TrashIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import type { AssetAssignmentWithUser } from "@lazyit/shared";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "@/components/user-avatar";
import { useAsset, useAssetAssignments } from "@/lib/api/hooks/use-assets";
import { useDeleteAsset } from "@/lib/api/hooks/use-asset-mutations";
import { useReleaseAssignment } from "@/lib/api/hooks/use-asset-assignment-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { formatDate } from "@/lib/utils/format";
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

  const { data: asset, isLoading, isError } = useAsset(id);
  // All assignments (active + released), each with its user, for owners + history.
  const { data: assignments } = useAssetAssignments(id, false);
  const release = useReleaseAssignment();
  const deleteAsset = useDeleteAsset();

  const [assignOpen, setAssignOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [releasingId, setReleasingId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (isError || !asset) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
        <p className="text-sm font-medium">Asset not found</p>
        <p className="text-sm text-muted-foreground">
          It may have been deleted.
        </p>
        <Button variant="outline" asChild>
          <Link href="/assets">
            <ArrowLeftIcon />
            Back to Assets
          </Link>
        </Button>
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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Button variant="ghost" size="sm" asChild className="-ml-2">
            <Link href="/assets">
              <ArrowLeftIcon />
              Assets
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">
              {asset.name}
            </h1>
            <AssetStatusBadge status={asset.status} />
          </div>
          {asset.assetTag && (
            <p className="font-mono text-sm text-muted-foreground">
              {asset.assetTag}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/assets/${asset.id}/edit`}>
              <PencilSquareIcon />
              Edit
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete asset"
            onClick={() => setDeleteOpen(true)}
          >
            <TrashIcon />
          </Button>
        </div>
      </div>

      <Panel title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <Detail label="Model">
            {asset.model
              ? `${asset.model.manufacturer} ${asset.model.name}`
              : "—"}
          </Detail>
          <Detail label="Category">
            {asset.model?.category ? (
              <Badge variant="outline">{asset.model.category.name}</Badge>
            ) : (
              "—"
            )}
          </Detail>
          <Detail label="Location">{asset.location?.name ?? "—"}</Detail>
          <Detail label="Serial">
            <span className="font-mono">{asset.serial ?? "—"}</span>
          </Detail>
          <Detail label="Asset tag">
            <span className="font-mono">{asset.assetTag ?? "—"}</span>
          </Detail>
          <Detail label="Purchase date">
            {asset.purchaseDate ? formatDate(asset.purchaseDate) : "—"}
          </Detail>
          <Detail label="Warranty end">
            {asset.warrantyEnd ? formatDate(asset.warrantyEnd) : "—"}
          </Detail>
        </dl>
        {asset.notes && (
          <div className="mt-4 space-y-1">
            <dt className="text-xs font-medium text-muted-foreground">Notes</dt>
            <dd className="text-sm whitespace-pre-wrap">{asset.notes}</dd>
          </div>
        )}
      </Panel>

      <Panel title="Specs">
        {specsEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">No specs recorded.</p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
            {specsEntries.map(([key, value]) => (
              <div key={key} className="flex gap-2 text-sm">
                <dt className="font-medium text-muted-foreground">{key}</dt>
                <dd className="font-mono break-all">
                  {typeof value === "string" ? value : JSON.stringify(value)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </Panel>

      <Panel
        title="Owners"
        action={
          <Button size="sm" variant="outline" onClick={() => setAssignOpen(true)}>
            <UserPlusIcon />
            Assign user
          </Button>
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
                        <span className="truncate font-medium">
                          {ownerName(assignment)}
                        </span>
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
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel title="Activity">
        <AssetHistoryTimeline assetId={asset.id} />
      </Panel>

      {history.length > 0 && (
        <Panel title="Ownership history">
          <ul className="divide-y text-sm">
            {history.map((assignment) => (
              <li
                key={assignment.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
              >
                <span className="font-medium">{ownerName(assignment)}</span>
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
        </Panel>
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

/** A bordered section with a heading and optional header action. */
function Panel({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border p-5">
      <div className="mb-4 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** A label/value pair in the details grid. */
function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
