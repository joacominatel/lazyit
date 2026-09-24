"use client";

import {
  CheckCircleIcon,
  KeyIcon,
  ServerIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { Breadcrumb } from "@/components/breadcrumb";
import { Callout } from "@/components/callout";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useAiConfig } from "@/lib/api/hooks/use-ai-config";
import { AdminGate } from "../../_components/admin-gate";
import { AiConnectionEditor } from "./ai-connection-editor";
import { AiDangerZone } from "./ai-danger-zone";
import { AiLimitsEditor } from "./ai-limits-editor";
import { AiMcpSection } from "./ai-mcp-section";
import { AiSetupWizard } from "./ai-setup-wizard";
import { AiWebSearchSection } from "./ai-web-search-section";

/**
 * Settings → AI body (client; ADR-0097, docs/ai-assistant/frontend.md §5.1, §5.3). One read —
 * `GET /config/ai`, prefetched by the page — drives everything:
 *   - assistant OFF → the setup wizard (a saved draft resumes where it stopped);
 *   - assistant ON  → the provider & model editor and the danger zone;
 *   - always        → behaviour & limits, web search (#1389), and the MCP card (its switch is
 *                     independent of the provider).
 * `AdminGate` hides the page from callers without `settings:manage`; the API is the real gate.
 */
export function AiSettingsView({ justEnabled }: { justEnabled: boolean }) {
  const t = useTranslations("aiSettings");
  const tSettings = useTranslations("settings");
  const { data: settings, isLoading, isError, error, refetch } = useAiConfig();

  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: tSettings("hub.title"), href: "/settings" },
          { label: t("page.breadcrumb") },
        ]}
      />
    ),
    [t, tSettings],
  );

  return (
    <AdminGate>
      <div className="space-y-6">
        <PageHeader
          title={t("page.title")}
          subtitle={t("page.subtitle")}
          breadcrumb={breadcrumb}
          badge={
            settings ? (
              <StatusBadge tone={settings.enabled ? "success" : "neutral"}>
                {settings.enabled ? t("page.statusOn") : t("page.statusOff")}
              </StatusBadge>
            ) : undefined
          }
        />

        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-64 w-full rounded-xl" />
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        ) : isError || !settings ? (
          <ErrorState title={t("page.loadError")} onRetry={() => refetch()} error={error} />
        ) : (
          <>
            {justEnabled && settings.enabled ? (
              <Callout tone="success" icon={<CheckCircleIcon />} role="status">
                <p className="text-sm font-medium">{t("page.enabled.title")}</p>
                <p className="text-sm">{t("page.enabled.body")}</p>
              </Callout>
            ) : null}

            {!settings.keyConfigured ? (
              <Callout tone="warning" icon={<KeyIcon />}>
                <p className="text-sm font-medium">{t("page.secretKey.title")}</p>
                <p className="text-sm">{t("page.secretKey.body")}</p>
              </Callout>
            ) : null}

            {settings.enabled ? (
              <AiConnectionEditor settings={settings} />
            ) : (
              <AiSetupWizard settings={settings} />
            )}

            <AiLimitsEditor settings={settings} />

            <AiWebSearchSection settings={settings} />

            <AiMcpSection settings={settings} />

            <Callout tone="info" icon={<ServerIcon />}>
              <p className="text-sm">
                {t("page.serviceAccounts.body")}{" "}
                <Link
                  href="/settings/service-accounts"
                  className="font-medium underline underline-offset-4"
                >
                  {t("page.serviceAccounts.link")}
                </Link>
              </p>
            </Callout>

            {settings.enabled ? <AiDangerZone settings={settings} /> : null}
          </>
        )}
      </div>
    </AdminGate>
  );
}
