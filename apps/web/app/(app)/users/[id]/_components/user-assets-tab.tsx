"use client";

import {
  CheckBadgeIcon,
  ClockIcon,
  ServerStackIcon,
} from "@heroicons/react/24/outline";
import type { AssetAssignment, AssetListItem } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { DetailPanel } from "@/components/detail-panel";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { AssetStatusBadge } from "../../../assets/_components/asset-status-badge";

/**
 * The Assets tab of the user record page (#1525): what this person holds right now. Rows come from
 * the live assignments (the source of truth for "holds"); the asset's tag, model, category and status
 * come from the server-side `assignedToUserId` list read, so every held asset resolves however large
 * the inventory is. An asset the caller cannot read (or one archived since) falls back to a plain label.
 */
export function UserAssetsTab({
  userId,
  active,
  assetById,
}: {
  userId: string;
  active: AssetAssignment[];
  assetById: Map<string, AssetListItem>;
}) {
  const t = useTranslations("users.detail.assets");
  const { date } = useFormatters();

  return (
    <DetailPanel
      title={t("title")}
      actions={
        active.length > 0 ? (
          <Link
            href={`/assets?owner=${userId}`}
            className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          >
            {t("openInList")}
          </Link>
        ) : undefined
      }
    >
      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y">
          {active.map((assignment) => {
            const asset = assetById.get(assignment.assetId);
            const model = asset?.model
              ? `${asset.model.manufacturer} ${asset.model.name}`
              : null;
            return (
              <li
                key={assignment.id}
                className="flex items-start gap-3 py-3 first:pt-0 last:pb-0"
              >
                <span
                  aria-hidden
                  className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground"
                >
                  <ServerStackIcon className="size-[18px]" />
                </span>
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <Link
                      href={`/assets/${assignment.assetId}`}
                      className="truncate font-medium hover:underline"
                    >
                      {asset?.name ?? t("assetFallback")}
                    </Link>
                    {asset ? <AssetStatusBadge status={asset.status} /> : null}
                  </div>
                  <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                    {asset?.assetTag ? (
                      <span className="font-mono">{asset.assetTag}</span>
                    ) : null}
                    {model ? (
                      <span>
                        {model}
                        {asset?.model?.category ? ` · ${asset.model.category.name}` : null}
                      </span>
                    ) : null}
                    <span>
                      {t("assignedOn", { date: date(assignment.assignedAt) })}
                    </span>
                  </p>
                  {assignment.notes ? (
                    <p className="text-xs break-words text-muted-foreground">
                      <span aria-hidden className="font-mono text-muted-foreground/60">
                        {"// "}
                      </span>
                      {assignment.notes}
                    </p>
                  ) : null}
                </div>
                {/* Acknowledgement state (ADR-0089 Part B): the hue rides the icon, the caption stays on
                    --muted-foreground so it holds AA (ADR-0049). */}
                <span className="hidden shrink-0 items-center gap-1 pt-0.5 text-xs text-muted-foreground sm:inline-flex">
                  {assignment.acknowledgedAt ? (
                    <>
                      <CheckBadgeIcon className="size-3.5 text-success" aria-hidden />
                      {t("acknowledged")}
                    </>
                  ) : (
                    <>
                      <ClockIcon className="size-3.5 text-warning-text" aria-hidden />
                      {t("awaitingAcknowledgement")}
                    </>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </DetailPanel>
  );
}
