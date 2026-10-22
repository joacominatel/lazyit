"use client";

import type { GrantProvisioning } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { StatusBadge } from "@/components/ui/status-badge";
import { PROVISIONING_TONE } from "@/lib/access-grants/provisioning";

/**
 * The coarse provisioning pill on the caller's own grants and approved requests (#1700): no
 * automation, in progress, done, or waiting on IT. Deliberately no workflow detail (run history is
 * admin-only); the hover title says what the status means for the person reading it.
 */
export function ProvisioningBadge({ status }: { status: GrantProvisioning }) {
  const t = useTranslations("profile.provisioning");
  return (
    <StatusBadge tone={PROVISIONING_TONE[status]} title={t(`${status}.hint`)}>
      {t(`${status}.label`)}
    </StatusBadge>
  );
}
