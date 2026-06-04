"use client";

import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useMyPermissions } from "@/lib/hooks/use-permissions";
import { InformesAccessDenied } from "./_components/informes-access-denied";
import { InformesScreen } from "./_components/informes-screen";

/**
 * Reports / Informes (issue #177, Wave 3c-1b) — the estate-wide, filterable activity history at
 * `/informes`. The screen reuses the unified `GET /dashboard/activity` feed (the same cross-pillar
 * stream the dashboard panel shows) and layers tabs, filters, a CSV/print export and two views on
 * top of it.
 *
 * GATED on the ADMIN-only `logs:read` permission (the same gate that hides the nav link). While the
 * permission set is loading we show a header + skeleton (no flash of either the screen or the
 * access-denied state — `useMyPermissions` fails closed). Once resolved, a caller without `logs:read`
 * gets the calm {@link InformesAccessDenied} state. v1 NOTE: this is a UI-level gate — the underlying
 * `GET /dashboard/activity` feed is still the shared `dashboard:read` stream (the same feed; since
 * Wave 3c-1c the dashboard panel is also `logs:read`-gated at the UI level). A dedicated
 * `logs:read`-gated endpoint is DEBT-1.
 */
export default function InformesPage() {
  const { can, isLoading } = useMyPermissions();
  const allowed = can("logs:read");

  return (
    <div className="space-y-6">
      {isLoading ? (
        <>
          <PageHeader
            title="Informes"
            breadcrumb={<Breadcrumb />}
            subtitle="Every change across your estate — newest first."
          />
          <div className="space-y-3" aria-hidden>
            <Skeleton className="h-9 w-full max-w-md" />
            <Skeleton className="h-9 w-full max-w-2xl" />
            <Skeleton className="h-64 w-full" />
          </div>
        </>
      ) : allowed ? (
        <InformesScreen />
      ) : (
        <>
          <PageHeader
            title="Informes"
            breadcrumb={<Breadcrumb />}
            subtitle="Every change across your estate — newest first."
          />
          <InformesAccessDenied />
        </>
      )}
    </div>
  );
}
