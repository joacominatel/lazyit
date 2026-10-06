"use client";

import { Squares2X2Icon } from "@heroicons/react/24/outline";
import type { AccessGrant } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { DetailPanel } from "@/components/detail-panel";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/ui/status-badge";
import { useFormatters } from "@/lib/hooks/use-formatters";
import {
  expiryState,
  GRANT_EXPIRING_WITHIN_DAYS,
  sortGrantsByUrgency,
} from "@/lib/record/record-state";

/**
 * The Access tab of the user record page (#1525): the person's active grants, ordered by what needs
 * attention first — expired (awaiting the expiry sweeper, ADR-0023), then expiring within
 * {@link GRANT_EXPIRING_WITHIN_DAYS} days, then the rest newest first. Application names resolve from
 * the applications catalog.
 */
export function UserAccessTab({
  active,
  appNameById,
  now,
}: {
  active: AccessGrant[];
  appNameById: Map<string, string>;
  now: number;
}) {
  const t = useTranslations("users.detail.access");
  const { date } = useFormatters();
  const sorted = sortGrantsByUrgency(active, now);

  return (
    <DetailPanel title={t("title")}>
      {sorted.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y">
          {sorted.map((grant) => {
            const expiry = expiryState(grant.expiresAt, now, GRANT_EXPIRING_WITHIN_DAYS);
            return (
              <li
                key={grant.id}
                className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
              >
                <span
                  aria-hidden
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                >
                  <Squares2X2Icon className="size-[18px]" />
                </span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link
                      href={`/applications/${grant.applicationId}`}
                      className="truncate font-medium hover:underline"
                    >
                      {appNameById.get(grant.applicationId) ?? t("applicationFallback")}
                    </Link>
                    {grant.accessLevel && (
                      <Badge variant="outline">{grant.accessLevel}</Badge>
                    )}
                    {expiry.kind === "expired" ? (
                      <StatusBadge tone="danger">{t("expired")}</StatusBadge>
                    ) : expiry.kind === "expiring" ? (
                      <StatusBadge tone="warning">
                        {t("expiresIn", { count: expiry.days })}
                      </StatusBadge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t("granted", { date: date(grant.grantedAt) })}
                    {grant.expiresAt
                      ? t("expiresSuffix", { date: date(grant.expiresAt) })
                      : ""}
                  </p>
                  {grant.notes ? (
                    <p className="text-xs break-words text-muted-foreground">
                      <span aria-hidden className="font-mono text-muted-foreground/60">
                        {"// "}
                      </span>
                      {grant.notes}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </DetailPanel>
  );
}
