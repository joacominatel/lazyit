"use client";

import { useTranslations } from "next-intl";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { AdminGate } from "../_components/admin-gate";
import { ServiceAccountsManager } from "./_components/service-accounts-manager";

/**
 * Settings → Service accounts (ADR-0048). The ADMIN-only surface to create, view, rotate, revoke and
 * restore service accounts — non-human API credentials authorized by direct permission grants. Wrapped
 * in AdminGate (the same client gate as the rest of Settings; the API's `settings:manage` guard is the
 * real boundary), and the manager re-checks `can('settings:manage')` for the write affordances.
 */
export default function ServiceAccountsPage() {
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
