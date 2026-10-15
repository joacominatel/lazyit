"use client";

import { InformationCircleIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { Callout } from "@/components/callout";
import { useClientOnlyConfigStatus } from "@/lib/api/hooks/use-config-status";

// Under OIDC lazyit never writes to the IdP (ADR-0102), so user and role changes stay in lazyit.
export function ByoiBanner() {
  const t = useTranslations("users.list.byoi");
  const { data: status } = useClientOnlyConfigStatus();

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
