"use client";

import { useTranslations } from "next-intl";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { AdminGate } from "../../_components/admin-gate";
import { ServiceAccountsManager } from "./service-accounts-manager";

/**
 * Settings → Service accounts body (client). Extracted from `page.tsx` for the ADR-0067
 * server-prefetch rollout: the page prefetches `serviceAccountKeys.list(false)` so the
 * {@link ServiceAccountsManager}'s `useServiceAccounts(false)` hydrates without a fetch waterfall.
 * Wrapped in AdminGate (the same client gate as the rest of Settings; the API's `settings:manage`
 * guard is the real boundary), and the manager re-checks `can('settings:manage')` for the write
 * affordances.
 */
export function ServiceAccountsView() {
  const t = useTranslations("settings");
  return (
    <AdminGate>
      <div className="space-y-6">
        <PageHeader
          title={t("serviceAccounts.title")}
          subtitle={t("serviceAccounts.subtitle")}
          breadcrumb={<Breadcrumb />}
        />
        <ServiceAccountsManager />
      </div>
    </AdminGate>
  );
}
