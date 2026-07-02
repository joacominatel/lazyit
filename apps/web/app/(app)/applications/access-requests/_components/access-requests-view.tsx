"use client";

import { CheckIcon, InboxStackIcon } from "@heroicons/react/24/outline";
import type { AccessRequest, User } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Breadcrumb } from "@/components/breadcrumb";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { PermissionGate } from "@/components/permission-gate";
import { ErrorState, Pagination } from "@/components/resource-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "@/components/user-avatar";
import { toast } from "sonner";
import { notifyError } from "@/lib/api/notify-error";
import {
  useAccessRequests,
  useApproveAccessRequest,
  useDenyAccessRequest,
} from "@/lib/api/hooks/use-access-requests";
import { useApplications } from "@/lib/api/hooks/use-applications";
import { useUsers } from "@/lib/api/hooks/use-users";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { DenyRequestDialog } from "./deny-request-dialog";

const PAGE_SIZE = 25;

/** Stable breadcrumb element for the PageHeader slot. */
function useBreadcrumb() {
  const t = useTranslations("applications");
  return useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: t("list.title"), href: "/applications" },
          { label: t("requests.title") },
        ]}
      />
    ),
    [t],
  );
}

/**
 * `/applications/access-requests` — the admin review queue for pending AccessRequests (ADR-0085, Part
 * 2 of #948). Reading the estate-wide queue is `accessRequest:read` (ADMIN+MEMBER, gated below);
 * DECIDING (approve/deny) is the existing `accessGrant:grant` (ADMIN-only), so a MEMBER can watch the
 * queue but the action buttons only render for a decider. Approve creates the grant through the
 * existing grant path in one transaction; deny requires a reason.
 */
export function AccessRequestsView() {
  const t = useTranslations("applications");
  const breadcrumb = useBreadcrumb();

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        breadcrumb={breadcrumb}
        title={t("requests.title")}
        subtitle={t("requests.subtitle")}
        pillar="access"
        icon={InboxStackIcon}
      />
      <PermissionGate
        permission="accessRequest:read"
        title={t("requests.lockedTitle")}
        description={t("requests.lockedDescription")}
      >
        <PendingQueue />
      </PermissionGate>
    </div>
  );
}

function PendingQueue() {
  const t = useTranslations("applications");
  const { date } = useFormatters();
  const canDecide = useCan("accessGrant:grant");

  const [offset, setOffset] = useState(0);
  const { data: page, isLoading, isError, error, refetch } = useAccessRequests({
    status: "PENDING",
    limit: PAGE_SIZE,
    offset,
  });
  // Requests are lean (ids only); resolve requester + application display names from the catalogs
  // (a queue reader holds `user:read` and `application:read`).
  const { data: users } = useUsers();
  const { data: applications } = useApplications();
  const approve = useApproveAccessRequest();
  const denyMutation = useDenyAccessRequest();

  const [denyTarget, setDenyTarget] = useState<AccessRequest | null>(null);

  const userById = useMemo(
    () => new Map<string, User>((users ?? []).map((u) => [u.id, u])),
    [users],
  );
  const appNameById = useMemo(
    () => new Map((applications ?? []).map((a) => [a.id, a.name])),
    [applications],
  );

  function requesterName(id: string): string {
    const u = userById.get(id);
    return u ? `${u.firstName} ${u.lastName}` : t("requests.unknownUser");
  }

  function handleApprove(request: AccessRequest) {
    approve.mutate(request.id, {
      onSuccess: () => toast.success(t("requests.approvedToast")),
      onError: (err) => notifyError(err, t("requests.decideError")),
    });
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
        <Skeleton className="h-20 w-full rounded-lg" />
      </div>
    );
  }

  if (isError) {
    return (
      <ErrorState
        title={t("requests.errorTitle")}
        onRetry={() => refetch()}
        error={error}
      />
    );
  }

  const items = page?.items ?? [];
  const total = page?.total ?? 0;

  if (total === 0) {
    return (
      <EmptyState
        icon={CheckIcon}
        pillar="access"
        title={t("requests.emptyTitle")}
        description={t("requests.emptyDescription")}
      />
    );
  }

  return (
    <div className="space-y-4">
      <ul className="divide-y rounded-lg border">
        {items.map((request) => {
          const user = userById.get(request.requesterId);
          return (
            <li key={request.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="flex min-w-0 gap-3">
                {user ? (
                  <UserAvatar
                    firstName={user.firstName}
                    lastName={user.lastName}
                    email={user.email}
                  />
                ) : null}
                <div className="min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {requesterName(request.requesterId)}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      {t("requests.wantsAccessTo")}
                    </span>
                    <Link
                      href={`/applications/${request.applicationId}`}
                      className="font-medium hover:underline"
                    >
                      {appNameById.get(request.applicationId) ??
                        t("requests.unknownApplication")}
                    </Link>
                    {request.accessLevel && (
                      <Badge variant="secondary">{request.accessLevel}</Badge>
                    )}
                  </div>
                  {request.justification && (
                    <p className="text-sm whitespace-pre-wrap text-muted-foreground">
                      {request.justification}
                    </p>
                  )}
                  <p className="font-mono text-xs tabular-nums text-muted-foreground">
                    {t("requests.requestedOn", { date: date(request.createdAt) })}
                  </p>
                </div>
              </div>

              {canDecide ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => handleApprove(request)}
                    disabled={approve.isPending}
                  >
                    <CheckIcon />
                    {t("requests.approve")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setDenyTarget(request)}
                  >
                    {t("requests.deny")}
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>

      <Pagination
        total={total}
        limit={PAGE_SIZE}
        offset={offset}
        itemCount={items.length}
        onOffsetChange={setOffset}
      />

      <DenyRequestDialog
        open={denyTarget != null}
        onOpenChange={(open) => {
          if (!open) setDenyTarget(null);
        }}
        requesterName={denyTarget ? requesterName(denyTarget.requesterId) : ""}
        onConfirm={(reason) =>
          denyMutation.mutateAsync({
            id: (denyTarget as AccessRequest).id,
            data: { reason },
          })
        }
      />
    </div>
  );
}
