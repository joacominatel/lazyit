"use client";

import {
  ArrowTopRightOnSquareIcon,
  Cog6ToothIcon,
  DocumentDuplicateIcon,
  ExclamationTriangleIcon,
  HandRaisedIcon,
  PencilSquareIcon,
  TrashIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import { type AccessGrant, isSafeApplicationUrl } from "@lazyit/shared";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useReducer, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailField, DetailPanel, DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { Breadcrumb } from "@/components/breadcrumb";
import { RelatedArticlesPanel } from "@/components/related-articles-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { ErrorState } from "@/components/resource-table";
import { useCan } from "@/lib/hooks/use-permissions";
import { useApplicationCategories } from "@/lib/api/hooks/use-application-categories";
import { useDeleteApplication } from "@/lib/api/hooks/use-application-mutations";
import {
  useApplication,
  useApplicationGrants,
} from "@/lib/api/hooks/use-applications";
import { useMyGrants } from "@/lib/api/hooks/use-access-grants";
import { useRevokeGrant } from "@/lib/api/hooks/use-access-grant-mutations";
import { useMyAccessRequests } from "@/lib/api/hooks/use-access-requests";
import { useUserNames } from "@/lib/api/hooks/use-users";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { formatMoney } from "@/lib/utils/money";
import { EditGrantDialog } from "../../_components/edit-grant-dialog";
import { GrantAccessDialog } from "../../_components/grant-access-dialog";
import { RequestAccessDialog } from "../../_components/request-access-dialog";
import { RevokeGrantDialog } from "../../_components/revoke-grant-dialog";
import { GroupedAccessList } from "./grouped-access-list";

/** isSafeApplicationUrl guarantees scheme-less or http(s); make scheme-less hosts absolute so the
 *  browser treats them as external links, not relative paths (SEC-008 defense in depth). */
function toHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

/** The four independent dialog slots on the detail view (grant / delete / revoke / edit), grouped into
 *  one machine so the component stays under the useState budget. Each field is set independently — the
 *  transitions mirror the original setState calls exactly (no new mutual-exclusivity). */
type DialogState = {
  grantOpen: boolean;
  requestOpen: boolean;
  deleteOpen: boolean;
  revoking: AccessGrant | null;
  editing: AccessGrant | null;
};

type DialogAction =
  | { type: "setGrantOpen"; open: boolean }
  | { type: "setRequestOpen"; open: boolean }
  | { type: "setDeleteOpen"; open: boolean }
  | { type: "setRevoking"; grant: AccessGrant | null }
  | { type: "setEditing"; grant: AccessGrant | null };

function dialogReducer(state: DialogState, action: DialogAction): DialogState {
  switch (action.type) {
    case "setGrantOpen":
      return { ...state, grantOpen: action.open };
    case "setRequestOpen":
      return { ...state, requestOpen: action.open };
    case "setDeleteOpen":
      return { ...state, deleteOpen: action.open };
    case "setRevoking":
      return { ...state, revoking: action.grant };
    case "setEditing":
      return { ...state, editing: action.grant };
  }
}

export function ApplicationDetailView({ id }: { id: string }) {
  const t = useTranslations("applications");
  const locale = useLocale();
  const { date } = useFormatters();
  const router = useRouter();
  const canWrite = useCan("application:write");
  const canDelete = useCan("application:delete");
  const canGrant = useCan("accessGrant:grant");
  const canReadWorkflows = useCan("workflow:read");

  const { data: application, isLoading, isError, error, refetch } =
    useApplication(id);
  // All grants (active + revoked), each raw (userId only) — resolved to users below.
  const { data: grants } = useApplicationGrants(id, { activeOnly: false });
  const { data: categories } = useApplicationCategories();
  const revokeGrant = useRevokeGrant();
  const deleteApplication = useDeleteApplication();

  // Self-service "Request access" affordance (ADR-0085) — shown to callers who can't grant directly.
  // Both reads are self-scope (any human), so a VIEWER can tell whether they already hold a grant or
  // have a pending request for this app; skip them for a grantor, who uses "Grant access" instead.
  const showRequestAffordance = !canGrant;
  const { data: myGrantsPage } = useMyGrants({ enabled: showRequestAffordance });
  const { data: myRequestsPage } = useMyAccessRequests({
    enabled: showRequestAffordance,
  });
  const hasOwnActiveGrant = useMemo(
    () =>
      (myGrantsPage?.items ?? []).some(
        (grant) => grant.applicationId === id && grant.revokedAt === null,
      ),
    [myGrantsPage, id],
  );
  const hasPendingRequest = useMemo(
    () =>
      (myRequestsPage?.items ?? []).some(
        (request) =>
          request.applicationId === id && request.status === "PENDING",
      ),
    [myRequestsPage, id],
  );

  const [dialog, dispatchDialog] = useReducer(dialogReducer, {
    grantOpen: false,
    requestOpen: false,
    deleteOpen: false,
    revoking: null,
    editing: null,
  });
  const { grantOpen, requestOpen, deleteOpen, revoking, editing } = dialog;
  // Snapshot "now" once (not during render) so the expiry comparison stays pure and stable.
  const [now] = useState(() => Date.now());

  // Resolve just this app's grantees (#961) — a targeted id→name batch, not the whole directory.
  const granteeIds = useMemo(
    () => [...new Set((grants ?? []).map((grant) => grant.userId))],
    [grants],
  );
  const userById = useUserNames(granteeIds);

  // Stable element for the PageHeader `breadcrumb` slot (jsx-no-jsx-as-prop). `application` is defined
  // wherever this is rendered (after the loading/error guards); the `?? ""` only covers the unused
  // pre-data branch, so the value matches `application.name` exactly whenever it is actually shown.
  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: t("list.title"), href: "/applications" },
          { label: application?.name ?? "" },
        ]}
      />
    ),
    [t, application?.name],
  );

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl">
        <DetailSkeleton panels={2} />
      </div>
    );
  }

  if (isError || !application) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorState
          title={t("detail.notFoundTitle")}
          description={t("detail.notFoundDescription")}
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  const active = (grants ?? []).filter((grant) => grant.revokedAt === null);
  const history = (grants ?? []).filter((grant) => grant.revokedAt !== null);
  const categoryName = application.categoryId
    ? categories?.find((category) => category.id === application.categoryId)?.name
    : undefined;

  // License / seat tracking (#949). `seatsUsed` is the API-derived distinct active-grant user count.
  // The over-allocation warning is purely client-derived: more distinct users hold access than there
  // are purchased seats. Only meaningful when seats are actually tracked (`seatsPurchased != null`).
  const seatsUsed = application.seatsUsed ?? 0;
  const isOverAllocated =
    application.seatsPurchased != null && seatsUsed > application.seatsPurchased;
  const overBy = isOverAllocated
    ? seatsUsed - (application.seatsPurchased as number)
    : 0;
  const hasLicenseInfo =
    application.seatsPurchased != null ||
    application.costPerSeat != null ||
    application.renewalDate != null;

  function userName(userId: string): string {
    const user = userById.get(userId);
    return user ? `${user.firstName} ${user.lastName}` : t("detail.unknownUser");
  }

  /** Render a user's name as a link to their detail when the user is known, else plain text. */
  function userLink(userId: string) {
    const user = userById.get(userId);
    if (!user) return <span>{userName(userId)}</span>;
    return (
      <Link href={`/users/${user.id}`} className="hover:underline">
        {userName(userId)}
      </Link>
    );
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        breadcrumb={breadcrumb}
        title={application.name}
        subtitle={application.vendor ?? undefined}
        badge={
          application.isCritical ? (
            <Badge variant="destructive">{t("detail.criticalBadge")}</Badge>
          ) : undefined
        }
        actions={
          canReadWorkflows || canWrite || canDelete ? (
            <>
              {canReadWorkflows ? (
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/applications/${application.id}/workflows`}>
                    <Cog6ToothIcon />
                    {t("detail.workflows")}
                  </Link>
                </Button>
              ) : null}
              {canWrite ? (
                <>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/applications/${application.id}/edit`}>
                      <PencilSquareIcon />
                      {t("detail.edit")}
                    </Link>
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/applications/${application.id}/clone`}>
                      <DocumentDuplicateIcon />
                      {t("detail.clone")}
                    </Link>
                  </Button>
                </>
              ) : null}
              {canDelete ? (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("detail.deleteAriaLabel")}
                  onClick={() => dispatchDialog({ type: "setDeleteOpen", open: true })}
                >
                  <TrashIcon />
                </Button>
              ) : null}
            </>
          ) : undefined
        }
      />

      <DetailPanel title={t("detail.detailsTitle")}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <DetailField label={t("detail.vendorLabel")}>
            {application.vendor ?? "—"}
          </DetailField>
          <DetailField label={t("detail.categoryLabel")}>
            {categoryName ? <Badge variant="outline">{categoryName}</Badge> : "—"}
          </DetailField>
          <DetailField label={t("detail.urlLabel")}>
            {application.url ? (
              isSafeApplicationUrl(application.url) ? (
                <a
                  href={toHref(application.url)}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  {application.url}
                  <ArrowTopRightOnSquareIcon className="size-3.5" />
                </a>
              ) : (
                <span className="break-all">{application.url}</span>
              )
            ) : (
              "—"
            )}
          </DetailField>
        </dl>
        {application.description && (
          <div className="mt-4 space-y-1">
            <dt className="text-xs font-medium text-muted-foreground">
              {t("detail.descriptionLabel")}
            </dt>
            <dd className="text-sm whitespace-pre-wrap">
              {application.description}
            </dd>
          </div>
        )}
        {application.notes && (
          <div className="mt-4 space-y-1">
            <dt className="text-xs font-medium text-muted-foreground">
              {t("detail.notesLabel")}
            </dt>
            <dd className="text-sm whitespace-pre-wrap">{application.notes}</dd>
          </div>
        )}
      </DetailPanel>

      {hasLicenseInfo && (
        <DetailPanel title={t("detail.licenseTitle")}>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
            <DetailField label={t("detail.seatsLabel")}>
              {application.seatsPurchased != null ? (
                <span className="inline-flex flex-wrap items-center gap-2">
                  <span className="font-mono tabular-nums">
                    {seatsUsed} / {application.seatsPurchased}
                  </span>
                  {isOverAllocated ? (
                    <StatusBadge tone="warning">
                      <ExclamationTriangleIcon
                        className="size-3.5"
                        aria-hidden
                      />
                      {t("detail.overAllocated", { over: overBy })}
                    </StatusBadge>
                  ) : null}
                </span>
              ) : (
                <span className="font-mono tabular-nums text-muted-foreground">
                  {t("detail.seatsUsedUntracked", { used: seatsUsed })}
                </span>
              )}
            </DetailField>
            {application.costPerSeat != null ? (
              <DetailField label={t("detail.costPerSeatLabel")} mono>
                {formatMoney(application.costPerSeat, locale)}
              </DetailField>
            ) : null}
            {application.renewalDate ? (
              <DetailField label={t("detail.renewalDateLabel")} mono>
                {date(application.renewalDate)}
              </DetailField>
            ) : null}
          </dl>
        </DetailPanel>
      )}

      <DetailPanel
        title={t("detail.activeAccessTitle")}
        actions={
          canGrant ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => dispatchDialog({ type: "setGrantOpen", open: true })}
            >
              <UserPlusIcon />
              {t("detail.grantAccess")}
            </Button>
          ) : hasOwnActiveGrant ? undefined : hasPendingRequest ? (
            <StatusBadge tone="warning">
              {t("detail.accessRequested")}
            </StatusBadge>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                dispatchDialog({ type: "setRequestOpen", open: true })
              }
            >
              <HandRaisedIcon />
              {t("detail.requestAccess")}
            </Button>
          )
        }
      >
        <GroupedAccessList
          activeGrants={active}
          userById={userById}
          now={now}
          applicationId={application.id}
          canGrant={canGrant}
          canReadWorkflows={canReadWorkflows}
          onEdit={(grant) => dispatchDialog({ type: "setEditing", grant })}
          onRevoke={(grant) => dispatchDialog({ type: "setRevoking", grant })}
          userName={userName}
        />
      </DetailPanel>

      <RelatedArticlesPanel applicationId={application.id} />

      {history.length > 0 && (
        <DetailPanel title={t("detail.historyTitle")}>
          {/* The access record as ledger lines (ADR-0077): user (body face) · the grantedAt →
              revokedAt span in Commit Mono tabular figures so the dates lock into columns · the
              "by {name}" actor stays on the body face. Baseline-aligned like a printed row. */}
          <ul className="divide-y divide-border text-sm">
            {history.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
              >
                <span className="flex items-center gap-2 font-medium">
                  {userLink(grant.userId)}
                  {grant.accessLevel && (
                    <Badge variant="outline">{grant.accessLevel}</Badge>
                  )}
                </span>
                <span className="text-xs text-muted-foreground">
                  <span className="font-mono tabular-nums">
                    {date(grant.grantedAt)}
                    <span className="mx-1.5 text-muted-foreground/70" aria-hidden>
                      →
                    </span>
                    {grant.revokedAt ? date(grant.revokedAt) : "—"}
                  </span>
                  {grant.revokedById
                    ? t("detail.historyRevokedByPart", {
                        name: userName(grant.revokedById),
                      })
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </DetailPanel>
      )}

      <GrantAccessDialog
        open={grantOpen}
        onOpenChange={(open) => dispatchDialog({ type: "setGrantOpen", open })}
        applicationId={application.id}
      />
      <RequestAccessDialog
        open={requestOpen}
        onOpenChange={(open) => dispatchDialog({ type: "setRequestOpen", open })}
        applicationId={application.id}
      />
      <EditGrantDialog
        grant={editing}
        onOpenChange={(open) => {
          if (!open) dispatchDialog({ type: "setEditing", grant: null });
        }}
        userName={editing ? userName(editing.userId) : ""}
      />
      <RevokeGrantDialog
        open={revoking != null}
        onOpenChange={(open) => {
          if (!open) dispatchDialog({ type: "setRevoking", grant: null });
        }}
        userName={revoking ? userName(revoking.userId) : ""}
        accessLevel={revoking?.accessLevel}
        onConfirm={() =>
          revokeGrant.mutateAsync({ id: (revoking as AccessGrant).id })
        }
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={(open) => dispatchDialog({ type: "setDeleteOpen", open })}
        entityKey="application"
        name={application.name}
        onConfirm={() => deleteApplication.mutateAsync(application.id)}
        onDeleted={() => router.push("/applications")}
      />
    </div>
  );
}
