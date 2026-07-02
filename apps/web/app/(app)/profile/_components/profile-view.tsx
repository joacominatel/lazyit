"use client";

import { ArrowTopRightOnSquareIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo, useState } from "react";
import { AssetStatusBadge } from "@/app/(app)/assets/_components/asset-status-badge";
import { UserRoleBadge } from "@/app/(app)/users/_components/user-role-badge";
import {
  DetailField,
  DetailPanel,
  DetailSkeleton,
} from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { ErrorState } from "@/components/resource-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/ui/status-badge";
import { UserAvatar } from "@/components/user-avatar";
import { useApplications } from "@/lib/api/hooks/use-applications";
import { useMyAssets } from "@/lib/api/hooks/use-assets";
import { useMyGrants } from "@/lib/api/hooks/use-access-grants";
import { useCurrentUser } from "@/lib/api/hooks/use-users";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";

/**
 * `/profile` — the self-service "My profile" page (issue #947). It answers, for the CALLER: who am I
 * (identity + role, from `GET /users/me`), what assets do I hold (`GET /assets/mine`) and what
 * applications can I access (`GET /access-grants/mine`). The two `mine` reads are self-scope carve-outs
 * (any authenticated human, no `asset:read`/`accessGrant:read`), so a VIEWER — who cannot reach the
 * admin `/users/[id]` 360 view — can still see their own estate here.
 *
 * READ-ONLY by design (v1): no edit/offboard/role controls (that is the admin `UserDetailView`). It
 * reuses the shared detail primitives (`PageHeader`, `DetailPanel`, `UserAvatar`, the asset/role
 * badges, `useFormatters`) rather than the admin monolith, whose per-person panels resolve labels from
 * catalog reads a VIEWER can partly hit and are wired to `user:manage` affordances. The `mine` asset
 * rows already inline model/category/location, so only the grant rows need the applications catalog
 * (VIEWER holds `application:read`) to resolve an application name.
 */
export function ProfileView() {
  const t = useTranslations("profile");
  const { date } = useFormatters();

  const { data: user, isLoading, isError, error, refetch } = useCurrentUser();
  const { data: assetsPage } = useMyAssets();
  const { data: grantsPage } = useMyGrants();
  // Grant rows are lean (applicationId only); resolve the display name from the catalog. VIEWER holds
  // `application:read`, but gate the fetch on it so a caller who somehow lacks it doesn't fire a doomed
  // 403 (the grant still renders with the fallback label).
  const canReadApplications = useCan("application:read");
  const { data: applications } = useApplications({
    enabled: canReadApplications,
  });

  // Snapshot "now" once (not during render) so the expiry comparison stays pure and stable.
  const [now] = useState(() => Date.now());

  const appNameById = useMemo(
    () => new Map((applications ?? []).map((app) => [app.id, app.name])),
    [applications],
  );

  if (isLoading) {
    return (
      <div className="mx-auto max-w-4xl">
        <DetailSkeleton panels={3} />
      </div>
    );
  }

  if (isError || !user) {
    return (
      <div className="mx-auto max-w-4xl">
        <ErrorState
          title={t("error.title")}
          description={t("error.description")}
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  const assets = assetsPage?.items ?? [];
  const grants = grantsPage?.items ?? [];
  const activeGrants = grants.filter((g) => g.revokedAt === null);
  const grantHistory = grants.filter((g) => g.revokedAt !== null);

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <UserAvatar
              size="lg"
              firstName={user.firstName}
              lastName={user.lastName}
              email={user.email}
            />
            {user.firstName} {user.lastName}
          </span>
        }
        subtitle={t("subtitle")}
        badge={user.role ? <UserRoleBadge role={user.role} /> : undefined}
      />

      <DetailPanel title={t("identity.title")}>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2">
          <DetailField label={t("identity.email")}>{user.email}</DetailField>
          <DetailField label={t("identity.role")}>
            {user.role ? <UserRoleBadge role={user.role} /> : "—"}
          </DetailField>
          <DetailField label={t("identity.joined")} mono>
            {date(user.createdAt)}
          </DetailField>
        </dl>
      </DetailPanel>

      <DetailPanel title={t("assets.title")}>
        {assets.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("assets.empty")}</p>
        ) : (
          <ul className="divide-y">
            {assets.map((asset) => (
              <li
                key={asset.id}
                className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="min-w-0">
                  <Link
                    href={`/assets/${asset.id}`}
                    className="truncate font-medium hover:underline"
                  >
                    {asset.name}
                  </Link>
                  <p className="truncate text-sm text-muted-foreground">
                    {asset.model
                      ? `${asset.model.manufacturer} ${asset.model.name}`
                      : t("assets.noModel")}
                    {asset.location ? ` · ${asset.location.name}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <AssetStatusBadge status={asset.status} />
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/assets/${asset.id}`}>
                      {t("assets.view")}
                      <ArrowTopRightOnSquareIcon />
                    </Link>
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DetailPanel>

      <DetailPanel title={t("access.title")}>
        {activeGrants.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("access.empty")}</p>
        ) : (
          <ul className="divide-y">
            {activeGrants.map((grant) => {
              const expired =
                grant.expiresAt != null &&
                new Date(grant.expiresAt).getTime() < now;
              return (
                <li
                  key={grant.id}
                  className="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Link
                        href={`/applications/${grant.applicationId}`}
                        className="truncate font-medium hover:underline"
                      >
                        {appNameById.get(grant.applicationId) ??
                          t("access.applicationFallback")}
                      </Link>
                      {grant.accessLevel && (
                        <Badge variant="secondary">{grant.accessLevel}</Badge>
                      )}
                      {expired && (
                        <StatusBadge tone="warning">
                          {t("access.expired")}
                        </StatusBadge>
                      )}
                    </div>
                    <p className="truncate text-sm text-muted-foreground">
                      {t("access.granted", { date: date(grant.grantedAt) })}
                      {grant.expiresAt
                        ? t("access.expiresSuffix", {
                            date: date(grant.expiresAt),
                          })
                        : ""}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/applications/${grant.applicationId}`}>
                      {t("access.view")}
                      <ArrowTopRightOnSquareIcon />
                    </Link>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </DetailPanel>

      {grantHistory.length > 0 && (
        <DetailPanel title={t("access.historyTitle")}>
          {/* Past access as ledger lines (ADR-0077): application (body face) · the grantedAt →
              revokedAt span in Commit Mono tabular figures, baseline-aligned like a printed row. */}
          <ul className="divide-y divide-border text-sm">
            {grantHistory.map((grant) => (
              <li
                key={grant.id}
                className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
              >
                <span className="flex items-center gap-2 font-medium">
                  <Link
                    href={`/applications/${grant.applicationId}`}
                    className="hover:underline"
                  >
                    {appNameById.get(grant.applicationId) ??
                      t("access.applicationFallback")}
                  </Link>
                  {grant.accessLevel && (
                    <Badge variant="outline">{grant.accessLevel}</Badge>
                  )}
                </span>
                <span className="font-mono text-xs tabular-nums text-muted-foreground">
                  {date(grant.grantedAt)}
                  <span className="mx-1.5 text-muted-foreground/70" aria-hidden>
                    →
                  </span>
                  {grant.revokedAt ? date(grant.revokedAt) : "—"}
                </span>
              </li>
            ))}
          </ul>
        </DetailPanel>
      )}
    </div>
  );
}
