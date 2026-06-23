"use client";

import {
  AdjustmentsHorizontalIcon,
  ArrowTopRightOnSquareIcon,
  LockClosedIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import type { Role } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { ROLE_ORDER, useRoleCounts } from "@/lib/hooks/use-role-counts";
import { AdminGate } from "../_components/admin-gate";

/** Tone for each RBAC role (ADR-0040). ADMIN is emphasized with the `info` tone. The label/hint
 * display copy is translated at render via `settings.roles.meta.<role>`. */
const ROLE_TONE: Record<Role, StatusTone> = {
  ADMIN: "info",
  MEMBER: "neutral",
  VIEWER: "neutral",
};

/**
 * Settings → Roles. A READ-ONLY overview of the RBAC roles (ADR-0040): for each role, the real
 * server-side holder count (#693 — one `groupBy`, correct at any team size), the permission/explainer
 * copy, and a "View N members" deep-link into the Users list (`/users?role=…`), which IS the
 * membership browser (server-side search/sort/paging). The screen no longer dumps the member list
 * itself — counts only. Role *permissions* (what each role may do — RBAC v2, ADR-0046) are edited on
 * the per-role permissions screen: the MEMBER/VIEWER cards link to it; ADMIN is immutable/full and
 * shown locked. Counts reflect the active (not soft-deleted) directory.
 */
export default function RolesPage() {
  const t = useTranslations("settings");
  const { counts, isLoading } = useRoleCounts();

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
            const count = counts?.[role] ?? 0;
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
                      {isLoading ? <Skeleton className="h-4 w-6" /> : count}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {t(`roles.meta.${role}.hint`)}
                  </p>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col justify-end gap-4">
                  {/* The Users list is the membership browser — deep-link, filtered to this role. */}
                  {isLoading ? (
                    <Skeleton className="h-5 w-32" />
                  ) : (
                    <Link
                      href={`/users?role=${role}`}
                      className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline"
                    >
                      <UsersIcon className="size-4" />
                      {t("roles.viewMembers", { count })}
                    </Link>
                  )}

                  {/* RBAC v2 (ADR-0046): MEMBER/VIEWER permissions are editable; ADMIN is full/locked. */}
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
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </AdminGate>
  );
}
