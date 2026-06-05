"use client";

import {
  ArrowTopRightOnSquareIcon,
  DocumentDuplicateIcon,
  PencilIcon,
  PencilSquareIcon,
  TrashIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import { type AccessGrant, isSafeApplicationUrl, type User } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailField, DetailPanel, DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { Breadcrumb } from "@/components/breadcrumb";
import { RelatedArticlesPanel } from "@/components/related-articles-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { UserAvatar } from "@/components/user-avatar";
import { ErrorState } from "@/components/resource-table";
import { useCan } from "@/lib/hooks/use-permissions";
import { useApplicationCategories } from "@/lib/api/hooks/use-application-categories";
import { useDeleteApplication } from "@/lib/api/hooks/use-application-mutations";
import {
  useApplication,
  useApplicationGrants,
} from "@/lib/api/hooks/use-applications";
import { useRevokeGrant } from "@/lib/api/hooks/use-access-grant-mutations";
import { useUsers } from "@/lib/api/hooks/use-users";
import { formatDate } from "@/lib/utils/format";
import { EditGrantDialog } from "../_components/edit-grant-dialog";
import { GrantAccessDialog } from "../_components/grant-access-dialog";
import { RevokeGrantDialog } from "../_components/revoke-grant-dialog";

/** isSafeApplicationUrl guarantees scheme-less or http(s); make scheme-less hosts absolute so the
 *  browser treats them as external links, not relative paths (SEC-008 defense in depth). */
function toHref(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

export default function ApplicationDetailPage() {
  const t = useTranslations("applications");
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;
  const canWrite = useCan("application:write");
  const canDelete = useCan("application:delete");
  const canGrant = useCan("accessGrant:grant");

  const { data: application, isLoading, isError, error, refetch } =
    useApplication(id);
  // All grants (active + revoked), each raw (userId only) — resolved to users below.
  const { data: grants } = useApplicationGrants(id, { activeOnly: false });
  const { data: categories } = useApplicationCategories();
  const { data: users } = useUsers();
  const revokeGrant = useRevokeGrant();
  const deleteApplication = useDeleteApplication();

  const [grantOpen, setGrantOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [revoking, setRevoking] = useState<AccessGrant | null>(null);
  const [editing, setEditing] = useState<AccessGrant | null>(null);
  // Snapshot "now" once (not during render) so the expiry comparison stays pure and stable.
  const [now] = useState(() => Date.now());

  const userById = useMemo(
    () => new Map<string, User>((users ?? []).map((user) => [user.id, user])),
    [users],
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
        breadcrumb={
          <Breadcrumb
            items={[
              { label: t("list.title"), href: "/applications" },
              { label: application.name },
            ]}
          />
        }
        title={application.name}
        subtitle={application.vendor ?? undefined}
        badge={
          application.isCritical ? (
            <Badge variant="destructive">{t("detail.criticalBadge")}</Badge>
          ) : undefined
        }
        actions={
          canWrite || canDelete ? (
            <>
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
                  onClick={() => setDeleteOpen(true)}
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

      <DetailPanel
        title={t("detail.activeAccessTitle")}
        actions={
          canGrant ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setGrantOpen(true)}
            >
              <UserPlusIcon />
              {t("detail.grantAccess")}
            </Button>
          ) : undefined
        }
      >
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("detail.noActiveGrants")}
          </p>
        ) : (
          <ul className="divide-y">
            {active.map((grant) => {
              const user = userById.get(grant.userId);
              const gone = user?.deletedAt != null;
              const expired =
                grant.expiresAt != null &&
                new Date(grant.expiresAt).getTime() < now;
              return (
                <li
                  key={grant.id}
                  className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    {user ? (
                      <UserAvatar
                        firstName={user.firstName}
                        lastName={user.lastName}
                        email={user.email}
                        className={gone ? "opacity-50 grayscale" : undefined}
                      />
                    ) : null}
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        {user ? (
                          <Link
                            href={`/users/${user.id}`}
                            className="truncate font-medium hover:underline"
                          >
                            {userName(grant.userId)}
                          </Link>
                        ) : (
                          <span className="truncate font-medium">
                            {userName(grant.userId)}
                          </span>
                        )}
                        {grant.accessLevel && (
                          <Badge variant="secondary">{grant.accessLevel}</Badge>
                        )}
                        {gone && (
                          <Badge
                            variant="outline"
                            className="text-muted-foreground"
                          >
                            {t("detail.deactivatedBadge")}
                          </Badge>
                        )}
                        {expired && (
                          <StatusBadge tone="warning">
                            {t("detail.expiredBadge")}
                          </StatusBadge>
                        )}
                      </div>
                      <p className="truncate text-sm text-muted-foreground">
                        {t("detail.grantedLine", {
                          date: formatDate(grant.grantedAt),
                        })}
                        {grant.grantedById
                          ? t("detail.grantedByPart", {
                              name: userName(grant.grantedById),
                            })
                          : ""}
                        {grant.expiresAt
                          ? t("detail.expiresPart", {
                              date: formatDate(grant.expiresAt),
                            })
                          : ""}
                        {grant.notes
                          ? t("detail.notesPart", { notes: grant.notes })
                          : ""}
                      </p>
                    </div>
                  </div>
                  {canGrant && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("detail.editGrantAriaLabel")}
                        onClick={() => setEditing(grant)}
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setRevoking(grant)}
                      >
                        {t("detail.revoke")}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DetailPanel>

      <RelatedArticlesPanel applicationId={application.id} />

      {history.length > 0 && (
        <DetailPanel title={t("detail.historyTitle")}>
          <ul className="divide-y text-sm">
            {history.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
              >
                <span className="flex items-center gap-2 font-medium">
                  {userLink(grant.userId)}
                  {grant.accessLevel && (
                    <Badge variant="outline">{grant.accessLevel}</Badge>
                  )}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {formatDate(grant.grantedAt)} →{" "}
                  {grant.revokedAt ? formatDate(grant.revokedAt) : "—"}
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
        onOpenChange={setGrantOpen}
        applicationId={application.id}
      />
      <EditGrantDialog
        grant={editing}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        userName={editing ? userName(editing.userId) : ""}
      />
      <RevokeGrantDialog
        open={revoking != null}
        onOpenChange={(open) => {
          if (!open) setRevoking(null);
        }}
        userName={revoking ? userName(revoking.userId) : ""}
        accessLevel={revoking?.accessLevel}
        onConfirm={() =>
          revokeGrant.mutateAsync({ id: (revoking as AccessGrant).id })
        }
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        entityKey="application"
        name={application.name}
        onConfirm={() => deleteApplication.mutateAsync(application.id)}
        onDeleted={() => router.push("/applications")}
      />
    </div>
  );
}
