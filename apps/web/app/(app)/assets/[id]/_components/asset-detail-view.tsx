"use client";

import {
  ArrowPathIcon,
  DocumentDuplicateIcon,
  PencilSquareIcon,
  ShareIcon,
  TrashIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import type { AssetAssignmentWithUser } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
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
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { useAsset, useAssetAssignments } from "@/lib/api/hooks/use-assets";
import { useAssetInfraNodeId } from "@/lib/api/hooks/use-infra-nodes";
import { useDeleteAsset } from "@/lib/api/hooks/use-asset-mutations";
import { useReleaseAssignment } from "@/lib/api/hooks/use-asset-assignment-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { formatFieldLabel, formatSpecValue } from "@/lib/utils/format";
import { AssetHistoryTimeline } from "../../_components/asset-history-timeline";
import { AssetStatusBadge } from "../../_components/asset-status-badge";
import { AssignUserDialog } from "../../_components/assign-user-dialog";

function ownerName(assignment: AssetAssignmentWithUser): string {
  return `${assignment.user.firstName} ${assignment.user.lastName}`;
}

export function AssetDetailView({ id }: { id: string }) {
  const router = useRouter();
  const t = useTranslations("assets.detail");
  const { date } = useFormatters();
  const tList = useTranslations("assets.list");
  const tc = useTranslations("common");
  // Edit/Clone + asset-assignment create/release are asset:write; deletion is asset:delete.
  const canWrite = useCan("asset:write");
  const canDelete = useCan("asset:delete");
  // Resolve whether this asset backs a topology node (issue #765). Gated on infra:read so a viewer
  // without topology access never fires the node-list fetch — the badge + deep-link stay hidden.
  const canReadInfra = useCan("infra:read");
  const topologyNodeId = useAssetInfraNodeId(id, canReadInfra);

  const { data: asset, isLoading, isError, error, refetch } = useAsset(id);
  // All assignments (active + released), each with its user, for owners + history.
  const { data: assignments } = useAssetAssignments(id, false);

  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: tList("title"), href: "/assets" },
          { label: asset?.name ?? "" },
        ]}
      />
    ),
    [tList, asset?.name],
  );
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
          title={t("notFoundTitle")}
          description={t("notFoundDescription")}
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
          toast.success(t("ownerReleasedToast"));
          setReleasingId(null);
        },
        onError: (error) => {
          notifyError(error, t("releaseError"));
          setReleasingId(null);
        },
      },
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        breadcrumb={breadcrumb}
        title={asset.name}
        subtitle={
          asset.assetTag ? (
            <span className="inline-flex items-center gap-1">
              <span className="font-mono">{asset.assetTag}</span>
              <CopyButton
                value={asset.assetTag}
                label={t("copyAssetTag")}
                className="-my-1"
              />
            </span>
          ) : undefined
        }
        badge={
          <span className="inline-flex items-center gap-2">
            <AssetStatusBadge status={asset.status} />
            {topologyNodeId ? (
              <Badge variant="secondary" className="gap-1">
                <ShareIcon className="size-3.5" aria-hidden />
                {t("onTopology")}
              </Badge>
            ) : null}
          </span>
        }
        actions={
          canWrite || canDelete || topologyNodeId ? (
            <>
              {topologyNodeId ? (
                <Button variant="outline" size="sm" asChild>
                  <Link
                    href={`/assets/diagram?node=${topologyNodeId}&focus=1`}
                  >
                    <ShareIcon />
                    {t("viewInTopology")}
                  </Link>
                </Button>
              ) : null}
              {canWrite ? (
                <>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/assets/${asset.id}/edit`}>
                      <PencilSquareIcon />
                      {tc("edit")}
                    </Link>
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/assets/${asset.id}/clone`}>
                      <DocumentDuplicateIcon />
                      {t("clone")}
                    </Link>
                  </Button>
                </>
              ) : null}
              {canDelete ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("deleteAssetLabel")}
                  onClick={() => setDeleteOpen(true)}
                >
                  <TrashIcon />
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />

      <DetailPanel title={t("detailsTitle")}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <DetailField label={t("model")}>
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
          <DetailField label={t("category")}>
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
          <DetailField label={t("location")}>
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
          <DetailField label={t("company")}>
            {asset.company ? (
              // Deep-link to the list filtered by this grouping value (ADR-0076) — a grouping facet,
              // not an access boundary.
              <Link
                href={`/assets?company=${encodeURIComponent(asset.company)}`}
                className="hover:underline"
              >
                {asset.company}
              </Link>
            ) : (
              "—"
            )}
          </DetailField>
          <DetailField label={t("serial")}>
            {asset.serial ? (
              <span className="inline-flex items-center gap-1">
                <span className="font-mono">{asset.serial}</span>
                <CopyButton
                  value={asset.serial}
                  label={t("copySerial")}
                  className="-my-1"
                />
              </span>
            ) : (
              <span className="font-mono">—</span>
            )}
          </DetailField>
          <DetailField label={t("assetTag")}>
            {asset.assetTag ? (
              <span className="inline-flex items-center gap-1">
                <span className="font-mono">{asset.assetTag}</span>
                <CopyButton
                  value={asset.assetTag}
                  label={t("copyAssetTag")}
                  className="-my-1"
                />
              </span>
            ) : (
              <span className="font-mono">—</span>
            )}
          </DetailField>
          <DetailField label={t("purchaseDate")}>
            {asset.purchaseDate ? date(asset.purchaseDate) : "—"}
          </DetailField>
          <DetailField label={t("warrantyEnd")}>
            {asset.warrantyEnd ? date(asset.warrantyEnd) : "—"}
          </DetailField>
        </dl>
        {asset.notes && (
          <div className="mt-4 space-y-1">
            <dt className="text-xs font-medium text-muted-foreground">
              {t("notes")}
            </dt>
            <dd className="text-sm whitespace-pre-wrap">{asset.notes}</dd>
          </div>
        )}
      </DetailPanel>

      <DetailPanel title={t("customFieldsTitle")}>
        {specsEntries.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("noCustomFields")}
          </p>
        ) : (
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
            {specsEntries.map(([key, value]) => (
              <div key={key} className="space-y-1">
                <dt className="text-xs font-medium text-muted-foreground">
                  {formatFieldLabel(key) || key}
                </dt>
                <dd className="text-sm break-words">
                  {formatSpecValue(value, { yes: tc("yes"), no: tc("no") })}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </DetailPanel>

      <DetailPanel
        title={t("ownersTitle")}
        actions={
          canWrite ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAssignOpen(true)}
            >
              <UserPlusIcon />
              {t("assignUser")}
            </Button>
          ) : undefined
        }
      >
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("noOwners")}
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
                            {t("deactivated")}
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-sm text-muted-foreground">
                        {assignment.notes
                          ? assignment.notes
                          : t("assignedOn", {
                              date: date(assignment.assignedAt),
                            })}
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
                      {t("release")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DetailPanel>

      <RelatedArticlesPanel assetId={asset.id} />

      <DetailPanel title={t("activityTitle")}>
        <AssetHistoryTimeline assetId={asset.id} />
      </DetailPanel>

      {history.length > 0 && (
        <DetailPanel title={t("ownershipHistoryTitle")}>
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
                  {date(assignment.assignedAt)} →{" "}
                  {assignment.releasedAt
                    ? date(assignment.releasedAt)
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
        entityKey="asset"
        name={asset.name}
        onConfirm={() => deleteAsset.mutateAsync(asset.id)}
        onDeleted={() => router.push("/assets")}
      />
    </div>
  );
}
