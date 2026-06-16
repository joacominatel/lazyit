"use client";

import { InformationCircleIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { Callout } from "@/components/callout";
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
    <Callout
      tone="info"
      icon={<InformationCircleIcon className="size-5!" />}
      className="rounded-lg px-4 py-3 text-sm"
    >
      <p className="font-medium">{t("title")}</p>
      <p className="text-card-foreground/80">{t("description")}</p>
    </Callout>
  );
}
