"use client";

import {
  MAX_PAGE_LIMIT,
  type AccessGrant,
  type AssetAssignment,
} from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useMemo } from "react";
import { DetailPanel } from "@/components/detail-panel";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { getAssets } from "@/lib/api/endpoints/assets";
import { assetKeys } from "@/lib/api/hooks/use-assets";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { closedRecordHistory } from "@/lib/record/record-state";

const CATALOG_FILTERS = { limit: MAX_PAGE_LIMIT };

/**
 * The History tab of the user record page (#1525): every released assignment and revoked grant as one
 * ledger, most recently closed first (ADR-0077 ledger lines — the span in Commit Mono tabular figures).
 *
 * Released assets are, by definition, no longer in the person's `assignedToUserId` set, so their names
 * resolve from a catalog page. That read lives here on purpose: the tab content only mounts when the
 * tab is open, so the catalog is fetched on demand instead of on every visit to the person.
 */
export function UserHistoryTab({
  assignments,
  grants,
  appNameById,
}: {
  assignments: AssetAssignment[];
  grants: AccessGrant[];
  appNameById: Map<string, string>;
}) {
  const t = useTranslations("users.detail.history");
  const { date } = useFormatters();
  const records = useMemo(
    () => closedRecordHistory(assignments, grants),
    [assignments, grants],
  );
  const hasAssets = records.some((record) => record.kind === "asset");
  // The same cache entry the offboarding sheet reads (`assetKeys.list({ limit: MAX_PAGE_LIMIT })`), and
  // only fetched when there is a released asset to name.
  const { data: assetsPage } = useQuery({
    queryKey: assetKeys.list(CATALOG_FILTERS),
    queryFn: ({ signal }) => getAssets(CATALOG_FILTERS, signal),
    enabled: hasAssets,
  });
  const assetNameById = useMemo(
    () => new Map((assetsPage?.items ?? []).map((asset) => [asset.id, asset.name])),
    [assetsPage],
  );

  return (
    <DetailPanel title={t("title")}>
      {records.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-border text-sm">
          {records.map((record) => (
            <li
              key={`${record.kind}-${record.id}`}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
            >
              <span className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="w-14 shrink-0 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                  {record.kind === "asset" ? t("kindAsset") : t("kindAccess")}
                </span>
                {record.kind === "asset" ? (
                  <Link
                    href={`/assets/${record.refId}`}
                    className="font-medium hover:underline"
                  >
                    {assetNameById.get(record.refId) ?? t("assetFallback")}
                  </Link>
                ) : (
                  <>
                    <Link
                      href={`/applications/${record.refId}`}
                      className="font-medium hover:underline"
                    >
                      {appNameById.get(record.refId) ?? t("applicationFallback")}
                    </Link>
                    {record.accessLevel ? (
                      <Badge variant="outline">{record.accessLevel}</Badge>
                    ) : null}
                  </>
                )}
              </span>
              <span className="font-mono text-xs tabular-nums text-muted-foreground">
                {date(record.start)}
                <span className="mx-1.5 text-muted-foreground/70" aria-hidden>
                  →
                </span>
                {date(record.end)}
              </span>
              {record.kind === "asset" && record.notes ? (
                <span className="w-full pl-16 text-muted-foreground">
                  <span aria-hidden className="font-mono text-muted-foreground/60">
                    {"// "}
                  </span>
                  {record.notes}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </DetailPanel>
  );
}
