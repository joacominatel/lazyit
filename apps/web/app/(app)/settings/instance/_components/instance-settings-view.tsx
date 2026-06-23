"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { IntegrationMode } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Breadcrumb } from "@/components/breadcrumb";
import { PageHeader } from "@/components/page-header";
import { RequestIdNote } from "@/components/request-id-note";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge, type StatusTone } from "@/components/ui/status-badge";
import { ApiError } from "@/lib/api/client";
import { useConfigStatus } from "@/lib/api/hooks/use-config-status";
import { AdminGate } from "../../_components/admin-gate";
import { AssetTagSchemeEditor } from "./asset-tag-scheme-editor";

/** A label / value row inside a panel; value can be text or a badge. */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{children}</span>
    </div>
  );
}

/**
 * Settings → Instance body (client). A READ-ONLY view of `GET /config/status`: whether the instance
 * is configured (an ADMIN exists), the identity-provider posture, the admin count and the runtime
 * posture (dev vs production). Nothing here mutates config — operators change posture via env
 * (ADR-0043); this surface just makes the current state discoverable in-app.
 *
 * Extracted from `page.tsx` for the ADR-0067 server-prefetch rollout: the page prefetches
 * `configKeys.status()` so `useConfigStatus()` here hydrates without a fetch waterfall.
 */
export function InstanceSettingsView() {
  const t = useTranslations("settings");
  const tc = useTranslations("common");
  const { data, isLoading, isError, error, refetch, isFetching } =
    useConfigStatus();

  const requestId = error instanceof ApiError ? error.requestId : undefined;

  /** Human label for the IdP posture (mirrors IntegrationModeSchema). */
  const identityProviderLabel: Record<IntegrationMode, string> = {
    zitadel: t("instance.identityProvider.zitadel"),
    "generic-oidc": t("instance.identityProvider.generic-oidc"),
  };

  const posture: { label: string; tone: StatusTone } = data?.devMode
    ? { label: t("instance.posture.development"), tone: "warning" }
    : { label: t("instance.posture.production"), tone: "success" };

  return (
    <AdminGate>
      <div className="space-y-6">
        <PageHeader
          title={t("instance.title")}
          subtitle={t("instance.subtitle")}
          breadcrumb={<Breadcrumb />}
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <ArrowPathIcon className={isFetching ? "animate-spin" : undefined} />
              {tc("refresh")}
            </Button>
          }
        />

        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>{t("instance.cardTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
                <Skeleton className="h-5 w-full" />
              </div>
            ) : isError ? (
              <div className="flex flex-col items-center gap-3 py-2 text-center">
                <p className="text-sm font-medium">
                  {t("instance.loadError")}
                </p>
                <p className="text-sm text-muted-foreground">
                  {t("instance.loadErrorHint")}
                </p>
                <RequestIdNote requestId={requestId} />
                <Button variant="outline" onClick={() => refetch()}>
                  <ArrowPathIcon />
                  {tc("retry")}
                </Button>
              </div>
            ) : data ? (
              <div className="divide-y">
                <InfoRow label={t("instance.rows.configured")}>
                  {data.isConfigured ? (
                    <StatusBadge tone="success" dot>
                      {t("instance.configuredBadge")}
                    </StatusBadge>
                  ) : (
                    <StatusBadge tone="warning" dot>
                      {t("instance.setupPending")}
                    </StatusBadge>
                  )}
                </InfoRow>
                <InfoRow label={t("instance.rows.identityProvider")}>
                  {identityProviderLabel[data.integrationMode]}
                </InfoRow>
                <InfoRow label={t("instance.rows.administrators")}>
                  <span className="tabular-nums">{data.adminCount}</span>
                </InfoRow>
                <InfoRow label={t("instance.rows.runtimePosture")}>
                  <StatusBadge tone={posture.tone} dot>
                    {posture.label}
                  </StatusBadge>
                </InfoRow>
              </div>
            ) : null}
          </CardContent>
        </Card>

        <AssetTagSchemeEditor />
      </div>
    </AdminGate>
  );
}
