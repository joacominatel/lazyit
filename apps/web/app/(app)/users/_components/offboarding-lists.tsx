"use client";

import {
  CheckCircleIcon,
  ComputerDesktopIcon,
  CubeIcon,
  KeyIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { HelpTip } from "@/components/help-tip";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { useFormatters } from "@/lib/hooks/use-formatters";
import type {
  OffboardConsumableRow,
  OffboardConsumables,
} from "@/lib/offboarding/consumables";
import type {
  OffboardAssetRow,
  OffboardGrantRow,
} from "@/lib/offboarding/use-offboarding-data";
import { cn } from "@/lib/utils";

/**
 * The left column of the Offboarding sheet (#1532): what happens on confirm, grouped — assets to
 * return, access to revoke, consumables delivered (ADR-0098). Each group is a hairline-ruled card with
 * a mono count; an empty group says so in one calm line with a success check instead of vanishing, so
 * "nothing here" is never confused with "not loaded" (the error state replaces this column entirely —
 * see the sheet and issue #601).
 */

/** A pillar-tinted icon chip — decorative and aria-hidden, so pillar hue is AA-exempt here (ADR-0049).
 * Secrets ride the knowledge pillar (their home in the nav), matching the Secret Manager surface. */
export function PillarChip({
  pillar,
  children,
}: {
  pillar: "inventory" | "access" | "knowledge";
  children: ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg [&>svg]:size-4",
        pillar === "inventory"
          ? "bg-pillar-inventory/10 text-pillar-inventory"
          : pillar === "access"
            ? "bg-pillar-access/10 text-pillar-access"
            : "bg-pillar-knowledge/10 text-pillar-knowledge",
      )}
    >
      {children}
    </span>
  );
}

/** The ruled card every group's rows sit in. */
export function RowsCard({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg bg-card ring-1 ring-foreground/10">
      {children}
    </div>
  );
}

/** A small mono count pill beside a group heading. */
export function CountPill({ count }: { count: number }) {
  return (
    <span className="rounded-full bg-muted px-1.5 font-mono text-[11px] leading-4 text-muted-foreground tabular-nums">
      {count}
    </span>
  );
}

/** A group: heading + count (+ optional help) over its rows. */
function Group({
  title,
  count,
  help,
  children,
}: {
  title: string;
  count?: number;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        {count !== undefined ? <CountPill count={count} /> : null}
        {help}
      </div>
      {children}
    </section>
  );
}

/** The calm one-line empty state of a group ("No active application access."). */
function EmptyRow({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-2 px-3 py-2.5 text-sm text-muted-foreground">
      <CheckCircleIcon className="size-4 shrink-0 text-success" aria-hidden />
      {children}
    </p>
  );
}

/** Skeleton rows while the catalog resolves — keeps the column from flashing empty. */
function ListSkeleton() {
  return (
    <RowsCard>
      <ul className="divide-y">
        {[0, 1].map((i) => (
          <li key={i} className="flex items-center gap-3 px-3 py-2.5">
            <Skeleton className="size-8 rounded-lg" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="h-3 w-3/5" />
            </div>
          </li>
        ))}
      </ul>
    </RowsCard>
  );
}

const ROW = "flex items-center gap-3 px-3 py-2.5";

/** One asset row in the "to return" list. Unresolved assets show the raw id, never a crash. */
function AssetLine({ asset }: { asset: OffboardAssetRow }) {
  const t = useTranslations("users.offboarding");
  const title =
    asset.assetTag ??
    asset.name ??
    (asset.resolved ? t("assetFallback") : asset.assetId);
  const meta = [
    asset.serial ? `SN ${asset.serial}` : null,
    asset.model,
    asset.category,
  ].filter(Boolean);
  return (
    <li className={ROW}>
      <PillarChip pillar="inventory">
        <ComputerDesktopIcon />
      </PillarChip>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium text-foreground">{title}</p>
        {asset.resolved ? (
          meta.length > 0 ? (
            <p className="truncate text-xs text-muted-foreground">
              {meta.join(" · ")}
            </p>
          ) : null
        ) : (
          <p className="truncate text-xs text-muted-foreground">
            {t("notInCatalog", { id: asset.assetId })}
          </p>
        )}
      </div>
    </li>
  );
}

/** One access row in the "to revoke" list — access level and the Critical mark as before. */
function GrantLine({ grant }: { grant: OffboardGrantRow }) {
  const t = useTranslations("users.offboarding");
  const { date } = useFormatters();
  const title =
    grant.appName ??
    (grant.resolved ? t("applicationFallback") : grant.applicationId);
  return (
    <li className={ROW}>
      <PillarChip pillar="access">
        <KeyIcon />
      </PillarChip>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="truncate font-medium text-foreground">{title}</p>
          {grant.accessLevel ? (
            <Badge variant="secondary">{grant.accessLevel}</Badge>
          ) : null}
          {grant.isCritical ? (
            <StatusBadge tone="warning">{t("critical")}</StatusBadge>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {grant.expiresAt
            ? t("expires", { date: date(grant.expiresAt) })
            : t("noExpiry")}
          {!grant.resolved
            ? t("verifyByIdSuffix", { id: grant.applicationId })
            : ""}
        </p>
      </div>
    </li>
  );
}

/**
 * One consumable delivery (ADR-0098) with its "include on the Return Act" checkbox (default on). A
 * to-return row shows what is still owed back; a delivered row, what was handed out. Offboarding moves
 * no stock — the list only tells the team what to ask for.
 */
function ConsumableLine({
  row,
  mode,
  included,
  onIncludedChange,
  disabled,
}: {
  row: OffboardConsumableRow;
  mode: "toReturn" | "delivered";
  included: boolean;
  onIncludedChange: (included: boolean) => void;
  disabled: boolean;
}) {
  const t = useTranslations("users.offboarding.consumables");
  const { date } = useFormatters();
  const checkboxId = `offboarding-consumable-${row.deliveryId}`;
  return (
    <li className={ROW}>
      <PillarChip pillar="inventory">
        <CubeIcon />
      </PillarChip>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor={checkboxId}
            className="truncate font-medium text-foreground"
          >
            {row.name}
          </label>
          {row.archived ? (
            <StatusBadge tone="neutral">{t("archived")}</StatusBadge>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-foreground tabular-nums">
          {mode === "toReturn"
            ? t("outstandingLine", {
                outstanding: row.outstanding,
                quantity: row.quantity,
                unit: row.unit,
                date: date(row.deliveredAt),
              })
            : t("deliveredLine", {
                quantity: row.quantity,
                unit: row.unit,
                date: date(row.deliveredAt),
              })}
        </p>
      </div>
      <Checkbox
        id={checkboxId}
        checked={included}
        onCheckedChange={(checked) => onIncludedChange(checked === true)}
        disabled={disabled}
        aria-label={t("includeAria", { name: row.name })}
        title={t("includeTitle")}
      />
    </li>
  );
}

/**
 * The consumables group (ADR-0098): returnable deliveries still outstanding, then the non-returnable
 * ones for the record — each row with an include checkbox for the act. A 403 on the read omits the rows
 * with a note (never fails the sheet); a truncated read says how many were left out. The "offboarding
 * moves no stock" explanation lives in the heading's help tip (#1532).
 */
function ConsumablesGroup({
  isLoading,
  unavailable,
  consumables,
  excluded,
  onIncludedChange,
  printing,
}: {
  isLoading: boolean;
  unavailable: boolean;
  consumables: OffboardConsumables;
  excluded: ReadonlySet<number>;
  onIncludedChange: (deliveryId: number, included: boolean) => void;
  /** The act's consumables section is on — the per-row checkboxes only matter then. */
  printing: boolean;
}) {
  const t = useTranslations("users.offboarding.consumables");
  const { toReturn, delivered, toReturnMore, deliveredMore } = consumables;
  const total = toReturn.length + delivered.length + toReturnMore + deliveredMore;
  const hasDelivered = delivered.length > 0 || deliveredMore > 0;

  const lines = (rows: OffboardConsumableRow[], mode: "toReturn" | "delivered") => (
    <ul className="divide-y">
      {rows.map((row) => (
        <ConsumableLine
          key={row.deliveryId}
          row={row}
          mode={mode}
          included={!excluded.has(row.deliveryId)}
          onIncludedChange={(included) => onIncludedChange(row.deliveryId, included)}
          disabled={!printing}
        />
      ))}
    </ul>
  );

  const subheading = (text: string) => (
    <p className="border-b bg-muted/40 px-3 py-1.5 text-label uppercase text-muted-foreground">
      {text}
    </p>
  );

  const moreNote = (text: string) => (
    <p className="border-t px-3 py-2 text-xs text-muted-foreground">{text}</p>
  );

  return (
    <Group
      title={t("title")}
      count={isLoading || unavailable ? undefined : total}
      help={
        <HelpTip topic={t("title")} href="/help/users-permissions-user-lifecycle">
          <p>{t("help")}</p>
        </HelpTip>
      }
    >
      {isLoading ? (
        <ListSkeleton />
      ) : (
        <RowsCard>
          {unavailable ? (
            <p className="px-3 py-2.5 text-sm text-muted-foreground">
              {t("unavailable")}
            </p>
          ) : total === 0 ? (
            <EmptyRow>{t("none")}</EmptyRow>
          ) : (
            <>
              {subheading(t("toReturnTitle"))}
              {toReturn.length === 0 && toReturnMore === 0 ? (
                <EmptyRow>{t("nothingOutstanding")}</EmptyRow>
              ) : (
                <>
                  {lines(toReturn, "toReturn")}
                  {toReturnMore > 0
                    ? moreNote(t("moreToReturn", { count: toReturnMore }))
                    : null}
                </>
              )}
              {/* Non-returnable deliveries — informational, only when there are any. */}
              {hasDelivered ? (
                <div className="border-t">
                  {subheading(t("deliveredTitle"))}
                  {lines(delivered, "delivered")}
                  {deliveredMore > 0
                    ? moreNote(t("moreDelivered", { count: deliveredMore }))
                    : null}
                </div>
              ) : null}
            </>
          )}
        </RowsCard>
      )}
    </Group>
  );
}

/** The whole left column: assets, access, consumables, and the honest empty note. */
export function OffboardingLists({
  isLoading,
  isEmpty,
  assets,
  grants,
  consumables,
  consumablesUnavailable,
  excludedDeliveries,
  onDeliveryIncludedChange,
  printingConsumables,
}: {
  isLoading: boolean;
  isEmpty: boolean;
  assets: OffboardAssetRow[];
  grants: OffboardGrantRow[];
  consumables: OffboardConsumables;
  consumablesUnavailable: boolean;
  excludedDeliveries: ReadonlySet<number>;
  onDeliveryIncludedChange: (deliveryId: number, included: boolean) => void;
  printingConsumables: boolean;
}) {
  const t = useTranslations("users.offboarding");
  return (
    <div className="space-y-5">
      <Group
        title={t("assetsToReturn")}
        count={isLoading ? undefined : assets.length}
      >
        {isLoading ? (
          <ListSkeleton />
        ) : (
          <RowsCard>
            {assets.length === 0 ? (
              <EmptyRow>{t("nothingToReturn")}</EmptyRow>
            ) : (
              <ul className="divide-y">
                {assets.map((asset) => (
                  <AssetLine key={asset.assignmentId} asset={asset} />
                ))}
              </ul>
            )}
          </RowsCard>
        )}
      </Group>

      <Group
        title={t("accessToRevoke")}
        count={isLoading ? undefined : grants.length}
      >
        {isLoading ? (
          <ListSkeleton />
        ) : (
          <RowsCard>
            {grants.length === 0 ? (
              <EmptyRow>{t("noActiveAccess")}</EmptyRow>
            ) : (
              <ul className="divide-y">
                {grants.map((grant) => (
                  <GrantLine key={grant.grantId} grant={grant} />
                ))}
              </ul>
            )}
          </RowsCard>
        )}
      </Group>

      <ConsumablesGroup
        isLoading={isLoading}
        unavailable={consumablesUnavailable}
        consumables={consumables}
        excluded={excludedDeliveries}
        onIncludedChange={onDeliveryIncludedChange}
        printing={printingConsumables}
      />

      {isEmpty ? (
        <p className="text-sm text-muted-foreground">{t("emptyNote")}</p>
      ) : null}
    </div>
  );
}
