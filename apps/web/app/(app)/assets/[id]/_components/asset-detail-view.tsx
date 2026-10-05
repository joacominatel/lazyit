"use client";

import {
  ChevronDownIcon,
  ClockIcon,
  DocumentDuplicateIcon,
  EllipsisHorizontalIcon,
  ExclamationTriangleIcon,
  PencilSquareIcon,
  PrinterIcon,
  ServerStackIcon,
  ShareIcon,
  TrashIcon,
  UserMinusIcon,
} from "@heroicons/react/24/outline";
import {
  type AssetAssignmentWithUser,
  type AssetStatus,
  type AssetStatusLabelRef,
  type AssetWithRelations,
  WARRANTY_EXPIRING_WITHIN_DAYS,
} from "@lazyit/shared";
import { useLocale, useNow, useTranslations } from "next-intl";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { CopyButton } from "@/components/copy-button";
import { DeleteConfirmDialog } from "@/components/delete-confirm-dialog";
import { DetailField, DetailPanel, DetailSkeleton } from "@/components/detail-panel";
import { PageHeader } from "@/components/page-header";
import { Breadcrumb } from "@/components/breadcrumb";
import {
  AttentionItem,
  RecordAttention,
  RecordFact,
  RecordFacts,
  RecordHero,
  RecordLayout,
  useRecordTab,
} from "@/components/record-page";
import { RelatedArticlesPanel } from "@/components/related-articles-panel";
import { ConsumableDeliveriesPanel } from "@/components/consumables/consumable-deliveries-panel";
import { AssetPurchasePanel } from "@/components/purchases/asset-purchase-panel";
import type { DeliveryTargetRef } from "@/lib/consumables/deliveries";
import { AssetDocumentsPanel } from "./asset-documents-panel";
import { AssetLocationPath } from "./asset-location-path";
import { AssetOwnersPanel } from "./asset-owners-panel";
import {
  AgentContainerPanel,
  getAgentContainerFacts,
} from "./agent-container-facts";
import {
  AgentInventoryPanel,
  getAgentInventory,
} from "./agent-inventory-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UserAvatar } from "@/components/user-avatar";
import { ErrorState } from "@/components/resource-table";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import { useAsset, useAssetAssignments } from "@/lib/api/hooks/use-assets";
import { useCurrentUser } from "@/lib/api/hooks/use-users";
import { useAssetInfraNodeId } from "@/lib/api/hooks/use-infra-nodes";
import { useDeleteAsset, useUpdateAsset } from "@/lib/api/hooks/use-asset-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { expiryState, type ExpiryState } from "@/lib/record/record-state";
import { formatFieldLabel, formatSpecValue } from "@/lib/utils/format";
import { formatMoney } from "@/lib/utils/money";
import { AssetHistoryTimeline } from "../../_components/asset-history-timeline";
import {
  AssetStatusBadge,
  useAssetStatusLabel,
} from "../../_components/asset-status-badge";
import {
  labelOfChoice,
  sameChoice,
  type StatusChoice,
  updateStatusFields,
} from "../../_components/asset-status-options";
import {
  AssetStatusMenuOptions,
  useAssetStatusOptions,
} from "../../_components/asset-status-picker";
import { AssignUserDialog } from "../../_components/assign-user-dialog";
import { AcknowledgeAssignmentDialog } from "../../_components/acknowledge-assignment-dialog";

type AssetTab = "overview" | "activity" | "documents" | "consumables";

function ownerName(assignment: AssetAssignmentWithUser): string {
  return `${assignment.user.firstName} ${assignment.user.lastName}`;
}

/**
 * Quick status change straight from the detail header (issue #951) — the status badge doubles as a
 * dropdown so an operator flips OPERATIONAL → IN_MAINTENANCE without entering Edit. Rides the SAME
 * `useUpdateAsset` PATCH the form/list use, so the server still emits the `STATUS_CHANGED`
 * AssetHistory event. Only rendered when the caller holds `asset:write` (the parent gates it). The
 * options are grouped by built-in status with the custom statuses under each (ADR-0101).
 */
function AssetStatusMenu({
  assetId,
  status,
  label,
}: {
  assetId: string;
  status: AssetStatus;
  label: AssetStatusLabelRef | null;
}) {
  const t = useTranslations("assets.detail");
  const statusLabel = useAssetStatusLabel();
  const updateAsset = useUpdateAsset();
  const groups = useAssetStatusOptions(label);
  const current: StatusChoice = { status, labelId: label?.id ?? null };

  function handleChange(next: StatusChoice) {
    if (sameChoice(next, current)) return;
    const name = labelOfChoice(next, groups)?.name ?? statusLabel(next.status);
    updateAsset.mutate(
      { id: assetId, data: updateStatusFields(next) },
      {
        onSuccess: () => toast.success(t("statusChangedToast", { status: name })),
        onError: (error) => notifyError(error, t("statusChangeError")),
      },
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={updateAsset.isPending}
          aria-label={t("changeStatusLabel")}
          className="inline-flex items-center gap-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
        >
          <AssetStatusBadge status={status} label={label} showKind />
          <ChevronDownIcon
            className="size-3.5 text-muted-foreground"
            aria-hidden
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 overflow-y-auto">
        <AssetStatusMenuOptions
          groups={groups}
          value={current}
          onSelect={handleChange}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A mono value with its copy button, or a muted dash when absent. */
function CopyableValue({ value, label }: { value: string | null; label: string }) {
  if (!value) return <span className="font-mono text-muted-foreground">—</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      <span className="font-mono break-all">{value}</span>
      <CopyButton value={value} label={label} className="-my-1" />
    </span>
  );
}

/**
 * The share of the warranty period already used (0..1), for the key-fact meter. Needs both ends of
 * the period; `undefined` hides the meter.
 */
function warrantyElapsed(
  purchaseDate: string | null,
  warrantyEnd: string | null,
  now: number,
): number | undefined {
  if (!purchaseDate || !warrantyEnd) return undefined;
  const start = new Date(purchaseDate).getTime();
  const end = new Date(warrantyEnd).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return undefined;
  return (now - start) / (end - start);
}

/**
 * Asset detail — a record page (#1525): a summary card answering who holds it, where it is, how the
 * warranty stands and what it's worth, the few things that need action, then a tabbed body (Overview ·
 * Activity · Documents · Consumables) beside a side column with the owners and the linked articles.
 * Every panel keeps its own permission gate; the Consumables tab only appears with `consumable:read`.
 */
export function AssetDetailView({ id }: { id: string }) {
  const router = useRouter();
  const t = useTranslations("assets.detail");
  const locale = useLocale();
  const { date } = useFormatters();
  const tList = useTranslations("assets.list");
  const tc = useTranslations("common");
  // Edit/Clone + asset-assignment create/release are asset:write; deletion is asset:delete.
  const canWrite = useCan("asset:write");
  const canDelete = useCan("asset:delete");
  const canReadConsumables = useCan("consumable:read");
  // Resolve whether this asset backs a topology node (issue #765). Gated on infra:read so a viewer
  // without topology access never fires the node-list fetch — the badge + deep-link stay hidden.
  const canReadInfra = useCan("infra:read");
  const topologyNodeId = useAssetInfraNodeId(id, canReadInfra);
  // The server-render instant seeded in the root layout, then a per-minute tick (#1448) — the server
  // and the hydrating client derive the same warranty state.
  const now = useNow({ updateInterval: 60 * 1000 }).getTime();

  const { data: asset, isLoading, isError, error, refetch } = useAsset(id);
  // Consumables delivered to this asset (ADR-0098) — spare disks, toner fitted to a printer.
  const deliveryTarget = useMemo<DeliveryTargetRef>(
    () => ({ kind: "asset", id }),
    [id],
  );
  // All assignments (active + released), each with its user, for owners + history.
  const { data: assignments } = useAssetAssignments(id, false);
  // The caller — to offer the self-service "Acknowledge receipt" action on their OWN active assignment
  // (ADR-0089 Part B). A read every authenticated human can make; drives only which button renders (the
  // API self-scopes the acknowledge regardless).
  const { data: me } = useCurrentUser();

  const tabs = useMemo<AssetTab[]>(
    () =>
      canReadConsumables
        ? ["overview", "activity", "documents", "consumables"]
        : ["overview", "activity", "documents"],
    [canReadConsumables],
  );
  const [tab, setTab] = useRecordTab(tabs, "overview");

  const breadcrumb = useMemo(
    () => (
      <Breadcrumb
        items={[
          { label: tList("title"), href: "/assets" },
          { label: asset?.name ?? "" },
        ]}
      />
    ),
    [tList, asset?.name],
  );
  const deleteAsset = useDeleteAsset();

  const [assignOpen, setAssignOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // The active assignment id whose "Acknowledge receipt" dialog is open (null = closed).
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl">
        <DetailSkeleton panels={3} />
      </div>
    );
  }

  if (isError || !asset) {
    return (
      <div className="mx-auto max-w-6xl">
        <ErrorState
          title={t("notFoundTitle")}
          description={t("notFoundDescription")}
          onRetry={() => refetch()}
          error={error}
        />
      </div>
    );
  }

  const active = (assignments ?? []).filter((a) => a.releasedAt === null);
  const history = (assignments ?? []).filter((a) => a.releasedAt !== null);
  const warranty = expiryState(asset.warrantyEnd, now, WARRANTY_EXPIRING_WITHIN_DAYS);
  const hasMenu = canWrite || canDelete || topologyNodeId != null;

  // What needs action on this record, most severe first. Each item appears only while it applies.
  const awaitingAck = active.filter((a) => !a.acknowledgedAt && a.user.deletedAt == null);
  const attentionItems: ReactNode[] = [];
  if (warranty.kind === "expired" || warranty.kind === "expiring") {
    attentionItems.push(
      <AttentionItem
        key="warranty"
        tone={warranty.kind === "expired" ? "danger" : "warning"}
        icon={ExclamationTriangleIcon}
      >
        {warranty.kind === "expired"
          ? t("attention.warrantyExpired", { count: warranty.days })
          : t("attention.warrantyExpiring", { count: warranty.days })}
      </AttentionItem>,
    );
  }
  for (const a of active) {
    if (a.user.deletedAt == null) continue;
    attentionItems.push(
      <AttentionItem key={`gone-${a.id}`} tone="warning" icon={UserMinusIcon}>
        {t("attention.deactivatedOwner", { name: ownerName(a) })}
      </AttentionItem>,
    );
  }
  if (awaitingAck.length > 0) {
    attentionItems.push(
      <AttentionItem key="ack" tone="neutral" icon={ClockIcon}>
        {awaitingAck.length === 1
          ? t("attention.awaitingAck", { name: ownerName(awaitingAck[0]) })
          : t("attention.awaitingAckMany", { count: awaitingAck.length })}
      </AttentionItem>,
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      {breadcrumb}

      <RecordHero
        header={
          <PageHeader
            pillar="inventory"
            icon={ServerStackIcon}
            title={asset.name}
            badge={
              <span className="inline-flex flex-wrap items-center gap-2">
                {canWrite ? (
                  <AssetStatusMenu
                    assetId={asset.id}
                    status={asset.status}
                    label={asset.statusLabel ?? null}
                  />
                ) : (
                  <AssetStatusBadge
                    status={asset.status}
                    label={asset.statusLabel}
                    showKind
                  />
                )}
                {topologyNodeId ? (
                  <Badge variant="secondary" className="gap-1">
                    <ShareIcon className="size-3.5" aria-hidden />
                    {t("onTopology")}
                  </Badge>
                ) : null}
              </span>
            }
            subtitle={<AssetIdentityLine asset={asset} />}
            actions={
              <>
                {/* Print a QR label — read-only, so shown to everyone. Opens the chrome-less print route
                    in a new tab so the detail page stays. */}
                <Button variant="outline" size="sm" asChild>
                  <Link href={`/assets/${asset.id}/label`} target="_blank">
                    <PrinterIcon />
                    {t("printLabel")}
                  </Link>
                </Button>
                {canWrite ? (
                  <Button size="sm" asChild>
                    <Link href={`/assets/${asset.id}/edit`}>
                      <PencilSquareIcon />
                      {tc("edit")}
                    </Link>
                  </Button>
                ) : null}
                {hasMenu ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon-sm"
                        aria-label={t("moreActions")}
                      >
                        <EllipsisHorizontalIcon />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-48">
                      {canWrite ? (
                        <DropdownMenuItem asChild>
                          <Link href={`/assets/${asset.id}/clone`}>
                            <DocumentDuplicateIcon />
                            {t("clone")}
                          </Link>
                        </DropdownMenuItem>
                      ) : null}
                      {topologyNodeId ? (
                        <DropdownMenuItem asChild>
                          <Link href={`/assets/diagram?node=${topologyNodeId}&focus=1`}>
                            <ShareIcon />
                            {t("viewInTopology")}
                          </Link>
                        </DropdownMenuItem>
                      ) : null}
                      {canDelete ? (
                        <>
                          {canWrite || topologyNodeId ? <DropdownMenuSeparator /> : null}
                          <DropdownMenuItem
                            variant="destructive"
                            onSelect={() => setDeleteOpen(true)}
                          >
                            <TrashIcon />
                            {t("deleteAssetLabel")}
                          </DropdownMenuItem>
                        </>
                      ) : null}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </>
            }
          />
        }
        attention={<RecordAttention label={t("attention.label")} items={attentionItems} />}
        facts={
          <RecordFacts>
            <OwnerFact active={active} />
            <RecordFact
              label={t("facts.location")}
              value={
                asset.location ? (
                  <AssetLocationPath id={asset.location.id} name={asset.location.name} />
                ) : (
                  <span className="font-normal text-muted-foreground">{t("facts.noLocation")}</span>
                )
              }
            />
            <WarrantyFact
              warranty={warranty}
              warrantyEnd={asset.warrantyEnd}
              elapsed={warrantyElapsed(asset.purchaseDate, asset.warrantyEnd, now)}
            />
            <ValueFact asset={asset} locale={locale} />
          </RecordFacts>
        }
      />

      <RecordLayout
        main={
          <Tabs value={tab} onValueChange={setTab}>
            <TabsList aria-label={t("tabs.label")}>
              <TabsTrigger value="overview">{t("tabs.overview")}</TabsTrigger>
              <TabsTrigger value="activity">{t("tabs.activity")}</TabsTrigger>
              <TabsTrigger value="documents">{t("tabs.documents")}</TabsTrigger>
              {canReadConsumables ? (
                <TabsTrigger value="consumables">{t("tabs.consumables")}</TabsTrigger>
              ) : null}
            </TabsList>

            <TabsContent value="overview" className="space-y-4 pt-2">
              <DetailPanel title={t("detailsTitle")}>
                <div className="grid gap-6 md:grid-cols-2 md:gap-0 md:divide-x md:divide-border">
                  <section className="space-y-3 md:pr-6">
                    <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                      {t("groups.identification")}
                    </h3>
                    <dl className="grid grid-cols-1 gap-y-3 sm:grid-cols-2 sm:gap-x-6">
                      <DetailField label={t("serial")}>
                        <CopyableValue value={asset.serial} label={t("copySerial")} />
                      </DetailField>
                      <DetailField label={t("assetTag")}>
                        <CopyableValue value={asset.assetTag} label={t("copyAssetTag")} />
                      </DetailField>
                      <DetailField label={t("model")}>
                        {asset.model ? (
                          // Deep-link to the EXACT model (#943) — distinct from the Category link next
                          // to it, which narrows to the whole category instead.
                          <Link href={`/assets?model=${asset.model.id}`} className="hover:underline">
                            {asset.model.manufacturer} {asset.model.name}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </DetailField>
                      <DetailField label={t("category")}>
                        {asset.model?.category ? (
                          <Link
                            href={`/assets?category=${asset.model.category.id}`}
                            className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <Badge variant="outline" className="hover:bg-muted">
                              {asset.model.category.name}
                            </Badge>
                          </Link>
                        ) : (
                          "—"
                        )}
                      </DetailField>
                      <DetailField label={t("company")} className="sm:col-span-2">
                        {asset.company ? (
                          // Deep-link to the list filtered by this grouping value (ADR-0076) — a grouping
                          // facet, not an access boundary.
                          <Link
                            href={`/assets?company=${encodeURIComponent(asset.company)}`}
                            className="hover:underline"
                          >
                            {asset.company}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </DetailField>
                    </dl>
                  </section>
                  <section className="space-y-3 md:pl-6">
                    <h3 className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                      {t("groups.lifecycle")}
                    </h3>
                    <dl className="grid grid-cols-1 gap-y-3 sm:grid-cols-2 sm:gap-x-6">
                      <DetailField label={t("purchaseDate")} mono>
                        {asset.purchaseDate ? date(asset.purchaseDate) : "—"}
                      </DetailField>
                      <DetailField label={t("warrantyEnd")} mono>
                        {asset.warrantyEnd ? date(asset.warrantyEnd) : "—"}
                      </DetailField>
                      <DetailField label={t("purchaseCost")} mono>
                        {asset.purchaseCost != null ? (
                          <>
                            {formatMoney(asset.purchaseCost, locale, asset.purchaseCurrency)}
                            {/* No label is its own visible state (ADR-0099 §5), never a default currency. */}
                            {asset.purchaseCurrency?.trim() ? null : (
                              <span className="font-sans text-muted-foreground">
                                {" · "}
                                {t("noCurrency")}
                              </span>
                            )}
                          </>
                        ) : (
                          "—"
                        )}
                      </DetailField>
                      {/* Current book value (#954): straight-line depreciation as of today, computed by the
                          API. `null` exactly when there's no purchase cost — hide the row rather than show
                          a 0. The label carries the "as of today" caveat as a native tooltip. */}
                      {asset.currentBookValue != null ? (
                        <DetailField
                          label={<span title={t("bookValueHint")}>{t("bookValue")}</span>}
                          mono
                        >
                          {formatMoney(asset.currentBookValue, locale, asset.purchaseCurrency)}
                        </DetailField>
                      ) : null}
                    </dl>
                  </section>
                </div>
                {asset.notes && (
                  <div className="mt-5 space-y-1 rounded-lg bg-muted px-3 py-2.5">
                    <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                      {t("notes")}
                    </p>
                    <p className="text-sm whitespace-pre-wrap">{asset.notes}</p>
                  </div>
                )}
              </DetailPanel>

              {/* Where it was bought (ADR-0099 D-A): renders — and reads — only with purchaseOrder:read. */}
              <AssetPurchasePanel asset={asset} />

              <AssetSpecsSection asset={asset} />
            </TabsContent>

            <TabsContent value="activity" className="space-y-4 pt-2">
              <DetailPanel title={t("activityTitle")}>
                <AssetHistoryTimeline assetId={asset.id} />
              </DetailPanel>

              {history.length > 0 && (
                <DetailPanel title={t("ownershipHistoryTitle")}>
                  {/* The ownership record as ledger lines (ADR-0077): owner (body face) · the
                      assignedAt → releasedAt span in Commit Mono tabular figures so the dates lock into
                      columns · an optional `// note` annotation. Baseline-aligned like a printed row. */}
                  <ul className="divide-y divide-border text-sm">
                    {history.map((assignment) => (
                      <li
                        key={assignment.id}
                        className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2 first:pt-0 last:pb-0"
                      >
                        <Link
                          href={`/users/${assignment.userId}`}
                          className="font-medium hover:underline"
                        >
                          {ownerName(assignment)}
                        </Link>
                        <span className="font-mono text-xs tabular-nums text-muted-foreground">
                          {date(assignment.assignedAt)}
                          <span className="mx-1.5 text-muted-foreground/70" aria-hidden>
                            →
                          </span>
                          {assignment.releasedAt ? date(assignment.releasedAt) : "—"}
                        </span>
                        {assignment.notes && (
                          <span className="w-full text-muted-foreground">
                            <span aria-hidden className="font-mono text-muted-foreground/60">
                              {"// "}
                            </span>
                            {assignment.notes}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                </DetailPanel>
              )}
            </TabsContent>

            <TabsContent value="documents" className="space-y-4 pt-2">
              <AssetDocumentsPanel assetId={asset.id} canWrite={canWrite} />
            </TabsContent>

            {canReadConsumables ? (
              <TabsContent value="consumables" className="space-y-4 pt-2">
                <ConsumableDeliveriesPanel
                  target={deliveryTarget}
                  targetName={asset.name}
                  targetLive={asset.deletedAt == null}
                />
              </TabsContent>
            ) : null}
          </Tabs>
        }
        aside={
          <>
            <AssetOwnersPanel
              active={active}
              meId={me?.id}
              canWrite={canWrite}
              onAssign={() => setAssignOpen(true)}
              onAcknowledge={setAcknowledgingId}
            />
            <RelatedArticlesPanel assetId={asset.id} />
          </>
        }
      />

      <AssignUserDialog
        open={assignOpen}
        onOpenChange={setAssignOpen}
        assetId={asset.id}
        excludeUserIds={active.map((a) => a.userId)}
      />
      {acknowledgingId ? (
        <AcknowledgeAssignmentDialog
          open
          onOpenChange={(next) => {
            if (!next) setAcknowledgingId(null);
          }}
          assignmentId={acknowledgingId}
        />
      ) : null}
      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        entityKey="asset"
        name={asset.name}
        onConfirm={() => deleteAsset.mutateAsync(asset.id)}
        onDeleted={() => router.push("/assets")}
      />
    </div>
  );
}

/** The header's identity line: the copyable asset tag, then model · category · company when set. */
function AssetIdentityLine({ asset }: { asset: AssetWithRelations }) {
  const t = useTranslations("assets.detail");
  const parts: ReactNode[] = [];
  if (asset.model) {
    parts.push(
      <Link key="model" href={`/assets?model=${asset.model.id}`} className="hover:underline">
        {asset.model.manufacturer} {asset.model.name}
      </Link>,
    );
  }
  if (asset.model?.category) {
    parts.push(
      <Link
        key="category"
        href={`/assets?category=${asset.model.category.id}`}
        className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Badge variant="outline" className="hover:bg-muted">
          {asset.model.category.name}
        </Badge>
      </Link>,
    );
  }
  if (asset.company) {
    parts.push(
      <Link
        key="company"
        href={`/assets?company=${encodeURIComponent(asset.company)}`}
        className="hover:underline"
      >
        {asset.company}
      </Link>,
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      {asset.assetTag ? (
        <span className="inline-flex items-center gap-1 text-foreground">
          <span className="font-mono">{asset.assetTag}</span>
          <CopyButton value={asset.assetTag} label={t("copyAssetTag")} className="-my-1" />
        </span>
      ) : null}
      {parts.map((part, index) => (
        <span key={index} className="inline-flex items-center gap-2">
          {index > 0 || asset.assetTag ? (
            <span aria-hidden className="text-muted-foreground/50">
              ·
            </span>
          ) : null}
          {part}
        </span>
      ))}
    </span>
  );
}

function OwnerFact({ active }: { active: AssetAssignmentWithUser[] }) {
  const t = useTranslations("assets.detail");
  const { date } = useFormatters();
  const first = active[0];
  if (!first) {
    return (
      <RecordFact
        label={t("facts.owner")}
        value={<span className="font-normal text-muted-foreground">{t("facts.unassigned")}</span>}
      />
    );
  }
  return (
    <RecordFact
      label={t("facts.owner")}
      value={
        <>
          <UserAvatar
            size="sm"
            firstName={first.user.firstName}
            lastName={first.user.lastName}
            email={first.user.email}
          />
          <Link href={`/users/${first.userId}`} className="truncate hover:underline">
            {ownerName(first)}
          </Link>
        </>
      }
      sub={
        active.length > 1
          ? t("facts.moreOwners", { count: active.length - 1 })
          : t("facts.since", { date: date(first.assignedAt) })
      }
    />
  );
}

function WarrantyFact({
  warranty,
  warrantyEnd,
  elapsed,
}: {
  warranty: ExpiryState;
  warrantyEnd: string | null;
  elapsed: number | undefined;
}) {
  const t = useTranslations("assets.detail");
  const { date } = useFormatters();
  if (warranty.kind === "none" || !warrantyEnd) {
    return (
      <RecordFact
        label={t("facts.warranty")}
        value={<span className="font-normal text-muted-foreground">{t("facts.noWarranty")}</span>}
      />
    );
  }
  const tone =
    warranty.kind === "expired" ? "danger" : warranty.kind === "expiring" ? "warning" : undefined;
  return (
    <RecordFact
      label={t("facts.warranty")}
      tone={tone}
      value={
        warranty.kind === "expired"
          ? t("facts.warrantyExpired")
          : warranty.kind === "expiring"
            ? t("facts.warrantyExpiring")
            : t("facts.warrantyActive")
      }
      sub={
        <>
          <span className="font-mono tabular-nums">{date(warrantyEnd)}</span>
          {" · "}
          {warranty.kind === "expired"
            ? t("facts.expiredAgo", { count: warranty.days })
            : t("facts.daysLeft", { count: warranty.days })}
        </>
      }
      meter={elapsed}
    />
  );
}

function ValueFact({ asset, locale }: { asset: AssetWithRelations; locale: string }) {
  const t = useTranslations("assets.detail");
  const noCurrency = !asset.purchaseCurrency?.trim();
  if (asset.currentBookValue != null && asset.purchaseCost != null) {
    return (
      <RecordFact
        label={<span title={t("bookValueHint")}>{t("bookValue")}</span>}
        mono
        value={formatMoney(asset.currentBookValue, locale, asset.purchaseCurrency)}
        sub={
          <>
            {t("facts.valueOf", {
              cost: formatMoney(asset.purchaseCost, locale, asset.purchaseCurrency),
            })}
            {noCurrency ? ` · ${t("noCurrency")}` : null}
          </>
        }
      />
    );
  }
  if (asset.purchaseCost != null) {
    return (
      <RecordFact
        label={t("purchaseCost")}
        mono
        value={formatMoney(asset.purchaseCost, locale, asset.purchaseCurrency)}
        sub={noCurrency ? t("noCurrency") : undefined}
      />
    );
  }
  return (
    <RecordFact
      label={t("bookValue")}
      value={<span className="font-normal text-muted-foreground">{t("facts.noValue")}</span>}
    />
  );
}

/**
 * The specs section: an agent host's structured inventory (ADR-0074), a confirmed container's facts
 * (#1139), or the human-entered custom fields as a hairline-ruled grid.
 */
function AssetSpecsSection({ asset }: { asset: AssetWithRelations }) {
  const t = useTranslations("assets.detail");
  const tc = useTranslations("common");
  const specs = asset.specs as Record<string, unknown> | null;
  // Agent-reported hosts carry a structured blob under `specs.host` — render it readably instead of
  // dumping raw JSON into the custom-fields grid.
  const agentInventory = getAgentInventory(specs);
  if (agentInventory) return <AgentInventoryPanel inventory={agentInventory} />;
  // A CONTAINER child node confirmed with asset tracking on — its blob is `{ container }`, never
  // `{ host }`, so the custom-fields grid would otherwise `JSON.stringify` the whole thing.
  const agentContainer = getAgentContainerFacts(specs);
  if (agentContainer) return <AgentContainerPanel facts={agentContainer} />;

  const entries = Object.entries(asset.specs ?? {});
  return (
    <DetailPanel
      title={t("customFieldsTitle")}
      actions={
        entries.length > 0 ? (
          <span className="text-xs text-muted-foreground">
            {t("customFieldsCount", { count: entries.length })}
          </span>
        ) : undefined
      }
    >
      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noCustomFields")}</p>
      ) : (
        <dl className="grid grid-cols-1 gap-x-6 sm:grid-cols-2 lg:grid-cols-3">
          {entries.map(([key, value]) => (
            <div key={key} className="min-w-0 space-y-0.5 border-t border-border py-2.5">
              <dt className="text-xs text-muted-foreground">{formatFieldLabel(key) || key}</dt>
              <dd className="text-sm break-words">
                {formatSpecValue(value, { yes: tc("yes"), no: tc("no") })}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </DetailPanel>
  );
}
