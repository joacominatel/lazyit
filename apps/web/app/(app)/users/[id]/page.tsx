"use client";

import {
  ArrowTopRightOnSquareIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { MAX_PAGE_LIMIT } from "@lazyit/shared";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { DetailField, DetailPanel, DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { Breadcrumb } from "@/components/breadcrumb";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { ErrorState } from "@/components/resource-table";
import { UserAvatar } from "@/components/user-avatar";
import { useCan } from "@/lib/hooks/use-permissions";
import { useApplications } from "@/lib/api/hooks/use-applications";
import { useArticles } from "@/lib/api/hooks/use-articles";
import { useAssets } from "@/lib/api/hooks/use-assets";
import {
  useUser,
  useUserAssignments,
  useUserGrants,
} from "@/lib/api/hooks/use-users";
import { formatDate } from "@/lib/utils/format";
import { ArticleStatusBadge } from "../../kb/_components/article-status-badge";
import { OffboardingSheet } from "./_components/offboarding-sheet";
import { UserFormDialog } from "../_components/user-form-dialog";
import { UserPasswordResetButton } from "../_components/user-password-reset-button";
import { UserRoleSelect } from "../_components/user-role-select";
import { UserStatusBadge } from "../_components/user-status-badge";

/**
 * User detail — the asset-centric counterpart to the asset detail page. It answers, for one person:
 * what assets they currently hold ({@link useUserAssignments}), what applications they can access
 * ({@link useUserGrants} — the per-user "who can access what" angle), and what knowledge they
 * authored ({@link useArticles} filtered by author). The nested grant/assignment reads are lean
 * (FK ids only), so asset and application labels are resolved client-side from the catalog reads.
 */
export default function UserDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  // Edit and Offboard are both the coarse user:manage capability (so is the role control below).
  const canManage = useCan("user:manage");

  const { data: user, isLoading, isError, error, refetch } = useUser(id);
  // Active + released assignments and active + revoked grants for the full per-person picture.
  const { data: assignments } = useUserAssignments(id, false);
  const { data: grants } = useUserGrants(id, false);
  const { data: articlesPage } = useArticles({
    authorId: id,
    limit: MAX_PAGE_LIMIT,
  });
  // Catalogs to resolve the lean FK ids to display labels (asset name, application name).
  const { data: assetsPage } = useAssets({ limit: MAX_PAGE_LIMIT });
  const { data: applications } = useApplications();
  // Snapshot "now" once (not during render) so the expiry comparison stays pure and stable.
  const [now] = useState(() => Date.now());

  const [editOpen, setEditOpen] = useState(false);
  const [offboardOpen, setOffboardOpen] = useState(false);

  const assetNameById = useMemo(
    () =>
      new Map((assetsPage?.items ?? []).map((asset) => [asset.id, asset.name])),
    [assetsPage],
  );
  const appNameById = useMemo(
    () => new Map((applications ?? []).map((app) => [app.id, app.name])),
    [applications],
  );

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl">
        <DetailSkeleton panels={3} />
      </div>
    );
  }

  if (isError || !user) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorState
          title="User not found"
          description="They may have been offboarded, or the API is unreachable."
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  const activeAssignments = (assignments ?? []).filter(
    (a) => a.releasedAt === null,
  );
  const assignmentHistory = (assignments ?? []).filter(
    (a) => a.releasedAt !== null,
  );
  const activeGrants = (grants ?? []).filter((g) => g.revokedAt === null);
  const grantHistory = (grants ?? []).filter((g) => g.revokedAt !== null);
  const articles = articlesPage?.items ?? [];

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        breadcrumb={
          <Breadcrumb
            items={[
              { label: "Users", href: "/users" },
              { label: `${user.firstName} ${user.lastName}` },
            ]}
          />
        }
        title={
          <span className="flex items-center gap-3">
            <UserAvatar
              size="lg"
              firstName={user.firstName}
              lastName={user.lastName}
              email={user.email}
            />
            {user.firstName} {user.lastName}
          </span>
        }
        subtitle={user.email}
        badge={<UserStatusBadge isActive={user.isActive} />}
        actions={
          canManage ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <PencilSquareIcon />
                Edit
              </Button>
              <UserPasswordResetButton user={user} />
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Offboard user"
                onClick={() => setOffboardOpen(true)}
              >
                <TrashIcon />
              </Button>
            </>
          ) : undefined
        }
      />

      <DetailPanel title="Profile">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <DetailField label="Email">{user.email}</DetailField>
          <DetailField label="Status">
            <UserStatusBadge isActive={user.isActive} />
          </DetailField>
          <DetailField label="Role">
            <UserRoleSelect user={user} />
          </DetailField>
          <DetailField label="Joined">{formatDate(user.createdAt)}</DetailField>
          <DetailField label="Last updated">
            {formatDate(user.updatedAt)}
          </DetailField>
        </dl>
      </DetailPanel>

      <DetailPanel title="Assets held">
        {activeAssignments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Holds no assets right now.
          </p>
        ) : (
          <ul className="divide-y">
            {activeAssignments.map((assignment) => (
              <li
                key={assignment.id}
                className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <Link
                    href={`/assets/${assignment.assetId}`}
                    className="truncate font-medium hover:underline"
                  >
                    {assetNameById.get(assignment.assetId) ?? "Asset"}
                  </Link>
                  <p className="truncate text-sm text-muted-foreground">
                    {assignment.notes
                      ? assignment.notes
                      : `Assigned ${formatDate(assignment.assignedAt)}`}
                  </p>
                </div>
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/assets/${assignment.assetId}`}>
                    View
                    <ArrowTopRightOnSquareIcon />
                  </Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DetailPanel>

      <DetailPanel title="Application access">
        {activeGrants.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active application access.
          </p>
        ) : (
          <ul className="divide-y">
            {activeGrants.map((grant) => {
              const expired =
                grant.expiresAt != null &&
                new Date(grant.expiresAt).getTime() < now;
              return (
                <li
                  key={grant.id}
                  className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/applications/${grant.applicationId}`}
                        className="truncate font-medium hover:underline"
                      >
                        {appNameById.get(grant.applicationId) ?? "Application"}
                      </Link>
                      {grant.accessLevel && (
                        <Badge variant="secondary">{grant.accessLevel}</Badge>
                      )}
                      {expired && <StatusBadge tone="warning">Expired</StatusBadge>}
                    </div>
                    <p className="truncate text-sm text-muted-foreground">
                      Granted {formatDate(grant.grantedAt)}
                      {grant.expiresAt
                        ? ` · expires ${formatDate(grant.expiresAt)}`
                        : ""}
                      {grant.notes ? ` · ${grant.notes}` : ""}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/applications/${grant.applicationId}`}>
                      View
                      <ArrowTopRightOnSquareIcon />
                    </Link>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </DetailPanel>

      <DetailPanel title="Authored articles">
        {articles.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Has not authored any knowledge base articles.
          </p>
        ) : (
          <ul className="divide-y">
            {articles.map((article) => (
              <li
                key={article.id}
                className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <Link
                    href={`/kb/${article.slug}`}
                    className="truncate font-medium hover:underline"
                  >
                    {article.title}
                  </Link>
                  {article.excerpt && (
                    <p className="truncate text-sm text-muted-foreground">
                      {article.excerpt}
                    </p>
                  )}
                </div>
                <ArticleStatusBadge status={article.status} />
              </li>
            ))}
          </ul>
        )}
      </DetailPanel>

      {assignmentHistory.length > 0 && (
        <DetailPanel title="Ownership history">
          <ul className="divide-y text-sm">
            {assignmentHistory.map((assignment) => (
              <li
                key={assignment.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
              >
                <Link
                  href={`/assets/${assignment.assetId}`}
                  className="font-medium hover:underline"
                >
                  {assetNameById.get(assignment.assetId) ?? "Asset"}
                </Link>
                <span className="tabular-nums text-muted-foreground">
                  {formatDate(assignment.assignedAt)} →{" "}
                  {assignment.releasedAt
                    ? formatDate(assignment.releasedAt)
                    : "—"}
                </span>
              </li>
            ))}
          </ul>
        </DetailPanel>
      )}

      {grantHistory.length > 0 && (
        <DetailPanel title="Access history">
          <ul className="divide-y text-sm">
            {grantHistory.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
              >
                <span className="flex items-center gap-2 font-medium">
                  <Link
                    href={`/applications/${grant.applicationId}`}
                    className="hover:underline"
                  >
                    {appNameById.get(grant.applicationId) ?? "Application"}
                  </Link>
                  {grant.accessLevel && (
                    <Badge variant="outline">{grant.accessLevel}</Badge>
                  )}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {formatDate(grant.grantedAt)} →{" "}
                  {grant.revokedAt ? formatDate(grant.revokedAt) : "—"}
                </span>
              </li>
            ))}
          </ul>
        </DetailPanel>
      )}

      <UserFormDialog
        key={`edit-${user.id}`}
        open={editOpen}
        onOpenChange={setEditOpen}
        user={user}
      />
      <OffboardingSheet
        key={`offboard-${user.id}`}
        open={offboardOpen}
        onOpenChange={setOffboardOpen}
        user={{
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
        }}
      />
    </div>
  );
}
