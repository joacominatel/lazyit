"use client";

import { LockClosedIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { Breadcrumb } from "@/components/breadcrumb";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useMyPermissions } from "@/lib/hooks/use-permissions";
import { AuditScreen } from "./audit-screen";

/** Stable empty breadcrumb shared by the gate's PageHeader instances. */
const BREADCRUMB = <Breadcrumb />;

/**
 * Client `logs:read` gate for the security audit-log surface (issue #871) — the SAME gate as Reports
 * (ADR-0081 reuses `logs:read`; no new verb). While the permission set loads we show a header +
 * skeleton (no flash — `useMyPermissions` fails closed). A caller without `logs:read` gets a calm
 * access-denied state; an allowed caller gets the {@link AuditScreen}.
 */
export function AuditGate() {
  const t = useTranslations("audit");
  const { can, isLoading } = useMyPermissions();
  const allowed = can("logs:read");

  return (
    <div className="space-y-6">
      {isLoading ? (
        <>
          <PageHeader
            title={t("page.title")}
            breadcrumb={BREADCRUMB}
            subtitle={t("page.subtitle")}
          />
          <div className="space-y-3" aria-hidden>
            <Skeleton className="h-9 w-full max-w-md" />
            <Skeleton className="h-9 w-full max-w-2xl" />
            <Skeleton className="h-64 w-full" />
          </div>
        </>
      ) : allowed ? (
        <AuditScreen />
      ) : (
        <>
          <PageHeader
            title={t("page.title")}
            breadcrumb={BREADCRUMB}
            subtitle={t("page.subtitle")}
          />
          <EmptyState
            icon={LockClosedIcon}
            pillar="manage"
            title={t("page.accessDeniedTitle")}
            description={t("page.accessDeniedDescription")}
            action={{ label: t("page.accessDeniedAction"), href: "/reports" }}
          />
        </>
      )}
    </div>
  );
}
