"use client";

import { InformationCircleIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useConfigStatus } from "@/lib/api/hooks/use-config-status";

/**
 * BYOI graceful-degradation banner on the Users page (ADR-0043 §5d / §7b). When the instance runs a
 * generic OIDC IdP (integrationMode = "generic-oidc"), lazyit cannot manage users/roles in that
 * provider — write-back is a no-op — so role and user changes are LOCAL-ONLY. This non-blocking
 * notice tells the operator to manage accounts in their own IdP. Renders nothing in zitadel mode.
 */
export function ByoiBanner() {
  const t = useTranslations("users.list.byoi");
  const { data: status } = useConfigStatus();

  if (status?.integrationMode !== "generic-oidc") {
    return null;
  }

  return (
    <div className="flex gap-3 rounded-lg border border-blue-300 bg-blue-50 px-4 py-3 text-sm dark:border-blue-500/40 dark:bg-blue-500/10">
      <InformationCircleIcon className="size-5 shrink-0 text-blue-600 dark:text-blue-400" />
      <div className="space-y-0.5">
        <p className="font-medium text-blue-900 dark:text-blue-200">
          {t("title")}
        </p>
        <p className="text-blue-800/90 dark:text-blue-300/90">
          {t("description")}
        </p>
      </div>
    </div>
  );
}
