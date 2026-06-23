"use client";

import { useTranslations } from "next-intl";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { PermissionGate } from "@/components/permission-gate";
import { ImportWizard } from "./_components/import-wizard";

/**
 * The guided bulk Migrator wizard route (ADR-0069, #637) — ADMIN-only by way of the new coarse
 * `import:run` permission. The {@link PermissionGate} is the route guard: it renders a neutral
 * skeleton while the permission set loads, an explicit "admin-only" locked state for anyone without
 * `import:run`, and the wizard for those who hold it. The API enforces the same gate (plus human-only
 * + owner-scope) server-side, so this is a UI affordance, not the boundary (fails closed).
 */
// ponytail: skipped from the ADR-0067 server-prefetch rollout — the Migrator wizard has no
// first-paint read (a session id only exists after the upload step), so there is nothing to prefetch.
export default function ImportsPage() {
  const t = useTranslations("imports");
  return (
    <div className="space-y-6">
      <PermissionGate
        permission="import:run"
        title={t("gate.title")}
        description={t("gate.description")}
      >
        <PageHeader
          breadcrumb={<Breadcrumb items={[{ label: t("nav") }]} />}
          title={t("title")}
          subtitle={t("subtitle")}
        />
        <ImportWizard />
      </PermissionGate>
    </div>
  );
}
