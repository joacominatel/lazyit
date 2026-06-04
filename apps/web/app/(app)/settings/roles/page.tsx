"use client";

import {
  AdjustmentsHorizontalIcon,
  ArrowTopRightOnSquareIcon,
  LockClosedIcon,
} from "@heroicons/react/24/outline";
import type { Role } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { UserAvatar } from "@/components/user-avatar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import {
  ROLE_ORDER,
  useUsersByRole,
  userFullName,
} from "@/lib/hooks/use-users-by-role";
import { AdminGate } from "../_components/admin-gate";

/** Tone for each RBAC role (ADR-0040). ADMIN is emphasized with the `info` tone. The label/hint
 * display copy is translated at render via `settings.roles.meta.<role>`. */
const ROLE_TONE: Record<Role, StatusTone> = {
  ADMIN: "info",
  MEMBER: "neutral",
  VIEWER: "neutral",
};

/**
 * Settings → Roles. A READ-ONLY overview that groups users by RBAC role so an admin can see, at a
 * glance, who holds which level of access. Role *assignment* (who is which role) lives in the Users
 * section (#84); each card links there. Role *permissions* (what each role may do — RBAC v2, ADR-0046)
 * are edited on the per-role permissions screen: the MEMBER/VIEWER cards link to it; ADMIN is
 * immutable/full and shown locked. Active-only by default (the users list excludes soft-deleted users
 * server-side).
 */
export default function RolesPage() {
  const t = useTranslations("settings");
  const { byRole, isLoading } = useUsersByRole();

  return (
    <AdminGate>
      <div className="space-y-6">
        <PageHeader
          title={t("roles.title")}
          subtitle={t("roles.subtitle")}
          breadcrumb={<Breadcrumb />}
          actions={
            <Link
              href="/users"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
            >
              {t("roles.manageUsers")}
              <ArrowTopRightOnSquareIcon className="size-4" />
            </Link>
          }
        />

        <div className="grid gap-4 lg:grid-cols-3">
          {ROLE_ORDER.map((role) => {
            const members = byRole[role];
            const isAdminRole = role === "ADMIN";
            return (
              <Card key={role} className="flex h-full flex-col">
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="flex items-center gap-2">
                      <StatusBadge tone={ROLE_TONE[role]}>
                        {t(`roles.meta.${role}.label`)}
                      </StatusBadge>
                    </CardTitle>
                    <span className="text-sm text-muted-foreground tabular-nums">
                      {isLoading ? (
                        <Skeleton className="h-4 w-6" />
                      ) : (
                        members.length
                      )}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t(`roles.meta.${role}.hint`)}
                  </p>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col">
                  {isLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-8 w-full" />
                      <Skeleton className="h-8 w-full" />
                    </div>
                  ) : members.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t("roles.emptyMembers")}
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {members.map((user) => (
                        <li key={user.id}>
                          <Link
                            href={`/users/${user.id}`}
                            className="flex items-center gap-2.5 rounded-md px-1.5 py-1.5 transition-colors hover:bg-muted/50"
                          >
                            <UserAvatar
                              firstName={user.firstName}
                              lastName={user.lastName}
                              email={user.email}
                              size="sm"
                            />
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium">
                                {userFullName(user)}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {user.email}
                              </span>
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}

                  {/* RBAC v2 (ADR-0046): MEMBER/VIEWER permissions are editable; ADMIN is full/locked. */}
                  <div className="mt-auto pt-4">
                    {isAdminRole ? (
                      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <LockClosedIcon className="size-3.5" />
                        {t("roles.fullAccessLocked")}
                      </p>
                    ) : (
                      <Link
                        href={`/settings/roles/permissions?role=${role}`}
                        className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                      >
                        <AdjustmentsHorizontalIcon className="size-4" />
                        {t("roles.editPermissions")}
                      </Link>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </AdminGate>
  );
}
