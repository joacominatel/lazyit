"use client";

import { useTranslations } from "next-intl";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useMyPermissions } from "@/lib/hooks/use-permissions";
import { ReportsAccessDenied } from "./reports-access-denied";
import { ReportsScreen } from "./reports-screen";

/** Stable empty breadcrumb shared by both PageHeader instances in this gate. */
const BREADCRUMB = <Breadcrumb />;

/**
 * Client `logs:read` gate for the Reports surface (extracted from `page.tsx` for the ADR-0067
 * server-prefetch rollout — see that page's doc). While the permission set is loading we show a
 * header + skeleton (no flash of either the screen or the access-denied state — `useMyPermissions`
 * fails closed). Once resolved, a caller without `logs:read` gets the calm
 * {@link ReportsAccessDenied} state; an allowed caller gets the {@link ReportsScreen}, which hydrates
 * the prefetched first activity page from the wrapping `<HydrationBoundary>`.
 */
export function ReportsGate() {
  const t = useTranslations("reports");
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
        <ReportsScreen />
      ) : (
        <>
          <PageHeader
            title={t("page.title")}
            breadcrumb={BREADCRUMB}
            subtitle={t("page.subtitle")}
          />
          <ReportsAccessDenied />
        </>
      )}
    </div>
  );
}
