"use client";

import {
  ArrowLeftIcon,
  ArrowTopRightOnSquareIcon,
  PencilIcon,
  PencilSquareIcon,
  TrashIcon,
  UserPlusIcon,
} from "@heroicons/react/24/outline";
import { type AccessGrant, isSafeApplicationUrl, type User } from "@lazyit/shared";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "@/components/user-avatar";
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
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const { data: application, isLoading, isError } = useApplication(id);
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
      <div className="mx-auto max-w-4xl space-y-4">
        <Skeleton className="h-4 w-20" />
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (isError || !application) {
    return (
      <div className="mx-auto flex max-w-4xl flex-col items-center gap-3 rounded-lg border border-dashed py-16 text-center">
        <p className="text-sm font-medium">Application not found</p>
        <p className="text-sm text-muted-foreground">It may have been deleted.</p>
        <Button variant="outline" asChild>
          <Link href="/applications">
            <ArrowLeftIcon />
            Back to Access
          </Link>
        </Button>
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
    return user ? `${user.firstName} ${user.lastName}` : "Unknown user";
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Button variant="ghost" size="sm" asChild className="-ml-2">
            <Link href="/applications">
              <ArrowLeftIcon />
              Access
            </Link>
          </Button>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight">
              {application.name}
            </h1>
            {application.isCritical && (
              <Badge variant="destructive">Critical</Badge>
            )}
          </div>
          {application.vendor && (
            <p className="text-sm text-muted-foreground">{application.vendor}</p>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href={`/applications/${application.id}/edit`}>
              <PencilSquareIcon />
              Edit
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete application"
            onClick={() => setDeleteOpen(true)}
          >
            <TrashIcon />
          </Button>
        </div>
      </div>

      <Panel title="Details">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <Detail label="Vendor">{application.vendor ?? "—"}</Detail>
          <Detail label="Category">
            {categoryName ? <Badge variant="outline">{categoryName}</Badge> : "—"}
          </Detail>
          <Detail label="URL">
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
          </Detail>
        </dl>
        {application.description && (
          <div className="mt-4 space-y-1">
            <dt className="text-xs font-medium text-muted-foreground">
              Description
            </dt>
            <dd className="text-sm whitespace-pre-wrap">
              {application.description}
            </dd>
          </div>
        )}
        {application.notes && (
          <div className="mt-4 space-y-1">
            <dt className="text-xs font-medium text-muted-foreground">Notes</dt>
            <dd className="text-sm whitespace-pre-wrap">{application.notes}</dd>
          </div>
        )}
      </Panel>

      <Panel
        title="Active access"
        action={
          <Button size="sm" variant="outline" onClick={() => setGrantOpen(true)}>
            <UserPlusIcon />
            Grant access
          </Button>
        }
      >
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active grants. Grant access to record who can reach this
            application.
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
                            Deactivated
                          </Badge>
                        )}
                        {expired && (
                          <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400">
                            Expired
                          </Badge>
                        )}
                      </div>
                      <p className="truncate text-sm text-muted-foreground">
                        Granted {formatDate(grant.grantedAt)}
                        {grant.grantedById
                          ? ` by ${userName(grant.grantedById)}`
                          : ""}
                        {grant.expiresAt
                          ? ` · expires ${formatDate(grant.expiresAt)}`
                          : ""}
                        {grant.notes ? ` · ${grant.notes}` : ""}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Edit grant"
                      onClick={() => setEditing(grant)}
                    >
                      <PencilIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setRevoking(grant)}
                    >
                      Revoke
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {history.length > 0 && (
        <Panel title="History">
          <ul className="divide-y text-sm">
            {history.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
              >
                <span className="flex items-center gap-2 font-medium">
                  {userName(grant.userId)}
                  {grant.accessLevel && (
                    <Badge variant="outline">{grant.accessLevel}</Badge>
                  )}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {formatDate(grant.grantedAt)} →{" "}
                  {grant.revokedAt ? formatDate(grant.revokedAt) : "—"}
                  {grant.revokedById
                    ? ` · by ${userName(grant.revokedById)}`
                    : ""}
                </span>
              </li>
            ))}
          </ul>
        </Panel>
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
        entityLabel="application"
        name={application.name}
        onConfirm={() => deleteApplication.mutateAsync(application.id)}
        onDeleted={() => router.push("/applications")}
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
