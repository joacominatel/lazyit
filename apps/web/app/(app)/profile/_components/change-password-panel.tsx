"use client";

import { useTranslations } from "next-intl";

import { ChangePasswordForm } from "@/components/change-password-form";
import { DetailPanel } from "@/components/detail-panel";
import { useConfigStatus } from "@/lib/api/hooks/use-config-status";

/**
 * Self-service "Change password" panel on `/profile` — local mode ONLY (ADR-0086 §F4b). Gated on
 * `authMode === "local"`: an OIDC instance owns credentials at the IdP, so the panel never renders and
 * the profile page is byte-identical to before. Renders nothing until the config status resolves (a
 * brief absence, not a flash of a control the user can't use).
 */
export function ChangePasswordPanel() {
  const t = useTranslations("auth.changePassword");
  const { data: status } = useConfigStatus();

  if (status?.authMode !== "local") return null;

  return (
    <DetailPanel title={t("panelTitle")}>
      <p className="mb-4 max-w-prose text-sm text-muted-foreground">
        {t("panelDescription")}
      </p>
      <div className="max-w-md">
        <ChangePasswordForm />
      </div>
    </DetailPanel>
  );
}
