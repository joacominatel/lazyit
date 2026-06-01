"use client";

import {
  ArrowLeftIcon,
  ArrowTopRightOnSquareIcon,
  PencilSquareIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import { MAX_PAGE_LIMIT } from "@lazyit/shared";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "@/components/user-avatar";
import { useApplications } from "@/lib/api/hooks/use-applications";
import { useArticles } from "@/lib/api/hooks/use-articles";
import { useAssets } from "@/lib/api/hooks/use-assets";
import { useDeleteUser } from "@/lib/api/hooks/use-user-mutations";
import {
  useUser,
  useUserAssignments,
  useUserGrants,
} from "@/lib/api/hooks/use-users";
import { formatDate } from "@/lib/utils/format";
import { ArticleStatusBadge } from "../../kb/_components/article-status-badge";
import { UserFormDialog } from "../_components/user-form-dialog";
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
  const router = useRouter();
  const id = params.id;

  const { data: user, isLoading, isError } = useUser(id);
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
  const deleteUser = useDeleteUser();
  // Snapshot "now" once (not during render) so the expiry comparison stays pure and stable.
  const [now] = useState(() => Date.now());

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

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
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (isError || !user) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
        <p className="text-sm font-medium">User not found</p>
        <p className="text-sm text-muted-foreground">
          They may have been offboarded.
        </p>
        <Button variant="outline" asChild>
          <Link href="/users">
            <ArrowLeftIcon />
            Back to Users
          </Link>
        </Button>
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
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Button variant="ghost" size="sm" asChild className="-ml-2">
            <Link href="/users">
              <ArrowLeftIcon />
              Users
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            <UserAvatar
              size="lg"
              firstName={user.firstName}
              lastName={user.lastName}
              email={user.email}
            />
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">
                {user.firstName} {user.lastName}
              </h1>
              <p className="text-sm text-muted-foreground">{user.email}</p>
            </div>
            <UserStatusBadge isActive={user.isActive} />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setEditOpen(true)}
          >
            <PencilSquareIcon />
            Edit
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Offboard user"
            onClick={() => setDeleteOpen(true)}
          >
            <TrashIcon />
          </Button>
        </div>
      </div>

      <Panel title="Profile">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <Detail label="Email">{user.email}</Detail>
          <Detail label="Status">
            <UserStatusBadge isActive={user.isActive} />
          </Detail>
          <Detail label="Role">
            <UserRoleSelect user={user} />
          </Detail>
          <Detail label="Joined">{formatDate(user.createdAt)}</Detail>
          <Detail label="Last updated">{formatDate(user.updatedAt)}</Detail>
        </dl>
      </Panel>

      <Panel title="Assets held">
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
      </Panel>

      <Panel title="Application access">
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
                      {expired && (
                        <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                          Expired
                        </Badge>
                      )}
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
      </Panel>

      <Panel title="Authored articles">
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
      </Panel>

      {assignmentHistory.length > 0 && (
        <Panel title="Ownership history">
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
        </Panel>
      )}

      {grantHistory.length > 0 && (
        <Panel title="Access history">
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
        </Panel>
      )}

      <UserFormDialog
        key={`edit-${user.id}`}
        open={editOpen}
        onOpenChange={setEditOpen}
        user={user}
      />
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        entityLabel="user"
        name={`${user.firstName} ${user.lastName}`}
        onConfirm={() => deleteUser.mutateAsync(user.id)}
        onDeleted={() => router.push("/users")}
      >
        Offboarding revokes their access grants and releases their assets. To
        keep them on record but disabled, set them inactive instead.
      </DeleteConfirmDialog>
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

/** A label/value pair in the profile grid. */
function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}
