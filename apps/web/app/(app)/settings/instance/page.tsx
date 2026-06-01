"use client";

import { ArrowPathIcon } from "@heroicons/react/24/outline";
import type { IntegrationMode } from "@lazyit/shared";
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
import { AdminGate } from "../_components/admin-gate";

/** Human label for the IdP posture (mirrors IntegrationModeSchema). */
const IDENTITY_PROVIDER_LABEL: Record<IntegrationMode, string> = {
  zitadel: "Zitadel (bundled)",
  "generic-oidc": "Generic OIDC (bring your own)",
};

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
 * Settings → Instance. A READ-ONLY view of `GET /config/status`: whether the instance is configured
 * (an ADMIN exists), the identity-provider posture, the admin count and the runtime posture
 * (dev vs production). Nothing here mutates config — operators change posture via env (ADR-0043);
 * this surface just makes the current state discoverable in-app.
 */
export default function InstancePage() {
  const { data, isLoading, isError, error, refetch, isFetching } =
    useConfigStatus();

  const requestId = error instanceof ApiError ? error.requestId : undefined;

  const posture: { label: string; tone: StatusTone } = data?.devMode
    ? { label: "Development", tone: "warning" }
    : { label: "Production", tone: "success" };

  return (
    <AdminGate>
      <div className="space-y-6">
        <PageHeader
          title="Instance"
          subtitle="How this lazyit instance is configured. Read-only — operators set posture via environment."
          breadcrumb={<Breadcrumb />}
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <ArrowPathIcon className={isFetching ? "animate-spin" : undefined} />
              Refresh
            </Button>
          }
        />

        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Configuration</CardTitle>
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
                  Could not load instance status
                </p>
                <p className="text-sm text-muted-foreground">
                  The API may be down or unreachable.
                </p>
                <RequestIdNote requestId={requestId} />
                <Button variant="outline" onClick={() => refetch()}>
                  <ArrowPathIcon />
                  Retry
                </Button>
              </div>
            ) : data ? (
              <div className="divide-y">
                <InfoRow label="Configured">
                  {data.isConfigured ? (
                    <StatusBadge tone="success" dot>
                      Configured
                    </StatusBadge>
                  ) : (
                    <StatusBadge tone="warning" dot>
                      Setup pending
                    </StatusBadge>
                  )}
                </InfoRow>
                <InfoRow label="Identity provider">
                  {IDENTITY_PROVIDER_LABEL[data.integrationMode]}
                </InfoRow>
                <InfoRow label="Administrators">
                  <span className="tabular-nums">{data.adminCount}</span>
                </InfoRow>
                <InfoRow label="Runtime posture">
                  <StatusBadge tone={posture.tone} dot>
                    {posture.label}
                  </StatusBadge>
                </InfoRow>
              </div>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </AdminGate>
  );
}
