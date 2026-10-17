"use client";

import { CheckIcon, InboxIcon } from "@heroicons/react/24/outline";
import {
  ACCESS_REQUEST_STATUSES,
  type AccessRequest,
  type AccessRequestStatus,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { DetailPanel } from "@/components/detail-panel";
import { ExportButton } from "@/components/export-button";
import { ErrorState, Pagination } from "@/components/resource-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "@/components/user-avatar";
import {
  ACCESS_REQUEST_EXPORT_PATH,
  accessRequestFilterParams,
} from "@/lib/api/endpoints/access-requests";
import { notifyError } from "@/lib/api/notify-error";
import {
  useAccessRequests,
  useApproveAccessRequest,
  useDenyAccessRequest,
} from "@/lib/api/hooks/use-access-requests";
import { useUserNames } from "@/lib/api/hooks/use-users";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";
import { AccessRequestStatusBadge } from "../../_components/access-request-status-badge";
import { DenyRequestDialog } from "../../access-requests/_components/deny-request-dialog";

const PAGE_SIZE = 25;

/** This application's access requests, one status at a time, pending first (ADR-0085). */
export function ApplicationRequestsTab({
  applicationId,
  pendingCount,
}: {
  applicationId: string;
  pendingCount: number | undefined;
}) {
  const t = useTranslations("applications.detail.requests");
  const tr = useTranslations("applications.requests");
  const { date } = useFormatters();
  const canDecide = useCan("accessGrant:grant");
  const [status, setStatus] = useState<AccessRequestStatus>("PENDING");
  const [offset, setOffset] = useState(0);
  const [denyTarget, setDenyTarget] = useState<AccessRequest | null>(null);

  const filters = useMemo(() => ({ applicationId, status }), [applicationId, status]);
  const { data, isLoading, isError, error, refetch, isFetching } = useAccessRequests({
    ...filters,
    limit: PAGE_SIZE,
    offset,
  });
  const approve = useApproveAccessRequest();
  const deny = useDenyAccessRequest();

  const items = useMemo(() => data?.items ?? [], [data]);
  const personIds = useMemo(
    () => items.flatMap((r) => (r.decidedById ? [r.requesterId, r.decidedById] : [r.requesterId])),
    [items],
  );
  const people = useUserNames(personIds);
  const nameOf = (id: string) => {
    const user = people.get(id);
    return user ? `${user.firstName} ${user.lastName}` : tr("unknownUser");
  };

  function handleApprove(request: AccessRequest) {
    approve.mutate(request.id, {
      onSuccess: () => toast.success(tr("approvedToast")),
      onError: (err) => notifyError(err, tr("decideError")),
    });
  }

  return (
    <DetailPanel
      title={t("title")}
      actions={
        <ExportButton
          path={ACCESS_REQUEST_EXPORT_PATH}
          params={accessRequestFilterParams(filters)}
          total={data?.total}
          filename="access-requests"
          permission="accessRequest:read"
          size="sm"
        />
      }
    >
      <div className="space-y-4">
        <div
          role="group"
          aria-label={t("statusLabel")}
          className="inline-flex max-w-full items-center overflow-x-auto rounded-lg bg-muted p-0.5"
        >
          {ACCESS_REQUEST_STATUSES.map((option) => {
            const active = status === option;
            return (
              <button
                key={option}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  setStatus(option);
                  setOffset(0);
                }}
                className={cn(
                  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[0.8rem] text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                  active && "bg-background font-medium text-foreground shadow-xs ring-1 ring-foreground/10",
                )}
              >
                {tr(`status.${option}`)}
                {option === "PENDING" && pendingCount !== undefined ? (
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {pendingCount}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        {isError ? (
          <ErrorState title={tr("errorTitle")} onRetry={() => refetch()} error={error} />
        ) : isLoading ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-16 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
            <InboxIcon className="size-6 text-muted-foreground/60" aria-hidden />
            <p className="text-sm text-muted-foreground">{t(`empty.${status}`)}</p>
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {items.map((request) => {
              const user = people.get(request.requesterId);
              return (
                <li
                  key={request.id}
                  className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between"
                >
                  <div className="flex min-w-0 gap-3">
                    {user ? (
                      <UserAvatar
                        size="sm"
                        firstName={user.firstName}
                        lastName={user.lastName}
                        email={user.email}
                        className="mt-0.5"
                      />
                    ) : null}
                    <div className="min-w-0 space-y-1">
                      <div className="flex flex-wrap items-center gap-2">
                        {user ? (
                          <Link href={`/users/${user.id}`} className="font-medium hover:underline">
                            {nameOf(request.requesterId)}
                          </Link>
                        ) : (
                          <span className="font-medium">{nameOf(request.requesterId)}</span>
                        )}
                        {request.accessLevel ? (
                          <Badge variant="outline">{request.accessLevel}</Badge>
                        ) : null}
                        {status !== "PENDING" ? <AccessRequestStatusBadge status={request.status} /> : null}
                      </div>
                      {request.justification ? (
                        <p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">
                          {request.justification}
                        </p>
                      ) : null}
                      <p className="font-mono text-xs tabular-nums text-muted-foreground">
                        {tr("requestedOn", { date: date(request.createdAt) })}
                        {request.decidedAt ? (
                          <span className="font-sans">
                            {" · "}
                            {t("decided", {
                              date: date(request.decidedAt),
                              name: request.decidedById ? nameOf(request.decidedById) : t("system"),
                            })}
                          </span>
                        ) : null}
                      </p>
                      {request.deniedReason ? (
                        <p className="text-xs break-words text-muted-foreground">
                          <span aria-hidden className="font-mono text-muted-foreground/60">
                            {"// "}
                          </span>
                          {request.deniedReason}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {canDecide && request.status === "PENDING" ? (
                    <div className="flex shrink-0 items-center gap-2 pl-10 sm:pl-0">
                      <Button size="sm" onClick={() => handleApprove(request)} disabled={approve.isPending}>
                        <CheckIcon />
                        {tr("approve")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setDenyTarget(request)}>
                        {tr("deny")}
                      </Button>
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        <Pagination
          total={data?.total ?? 0}
          limit={PAGE_SIZE}
          offset={offset}
          itemCount={items.length}
          onOffsetChange={setOffset}
          isFetching={isFetching}
        />
      </div>

      <DenyRequestDialog
        open={denyTarget != null}
        onOpenChange={(open) => {
          if (!open) setDenyTarget(null);
        }}
        requesterName={denyTarget ? nameOf(denyTarget.requesterId) : ""}
        onConfirm={(reason) =>
          deny.mutateAsync({ id: (denyTarget as AccessRequest).id, data: { reason } })
        }
      />
    </DetailPanel>
  );
}
