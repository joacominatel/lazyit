"use client";

import {
  ArrowPathIcon,
  CheckCircleIcon,
  ExclamationTriangleIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";
import {
  type LinkAssetsResult,
  type PurchaseApplyField,
  type PurchaseLinkPreview,
  type PurchaseLinkPreviewAsset,
  type PurchaseOrderDetail,
  type PurchaseOrderLine,
} from "@lazyit/shared";
import { useLocale, useTranslations } from "next-intl";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";
import { Callout } from "@/components/callout";
import { Combobox } from "@/components/combobox";
import { SearchInput } from "@/components/search-input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useAssetModels } from "@/lib/api/hooks/use-asset-models";
import { useAssets } from "@/lib/api/hooks/use-assets";
import {
  useLinkAssets,
  useLinkPreview,
  usePurchaseOrder,
  usePurchaseOrders,
  useUpdatePurchaseOrderLine,
} from "@/lib/api/hooks/use-purchase-orders";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import {
  type ApplyChoices,
  assetsToLink,
  buildLinkPayload,
  defaultChoices,
  everyValueChoices,
  failureViews,
  fieldGroups,
  linkSummary,
  setCell,
  setFieldGroup,
} from "@/lib/purchases/link-apply";
import { formatMoney } from "@/lib/utils/money";
import { cn } from "@/lib/utils";
import { overReceipt } from "@/app/(app)/assets/_components/receive-stock-payload";
import { usePurchaseTitle } from "@/app/(app)/purchases/_components/purchase-display";

/** An asset as the dialog names it before the preview has loaded. */
export interface LinkAssetRef {
  id: string;
  name: string;
  assetTag: string | null;
  modelId: string | null;
}

/** A line to link to: the purchase (for its title) and the line. */
export interface LinkLineTarget {
  purchase: Pick<PurchaseOrderDetail, "id" | "reference" | "supplier" | "orderDate" | "createdAt" | "currency">;
  line: PurchaseOrderLine;
}

type Step = "assets" | "line" | "diff" | "result";

/**
 * Link existing assets to a purchase line, with the per-field "apply values" diff (ADR-0099 §2, UX
 * proposal §3.e). One dialog, three entry points:
 *
 *   - a purchase line's *Link existing assets* (`line` given): pick the assets — searchable, filtered to
 *     the line's model by a removable chip — then the diff;
 *   - an asset's *Link to purchase*, and the Assets list's batch action (`assets` given): pick the purchase
 *     and the line — lines of the assets' model first — then the diff;
 *   - the diff itself: values grouped by field (fills pre-checked, replacements never), one *Apply every
 *     purchase value* switch, a per-asset grid behind *Show each asset*, and a result line restating what
 *     will happen. Assets on another purchase need an explicit *Move here*; assets already on this line
 *     are left out. Over-receipt is a warning with the one-click "raise the line" (§4).
 *
 * Partial success like bulk receive: refused assets are listed with their reason. Needs
 * `purchaseOrder:write` + `asset:write` (the caller gates it). Mounted only while open.
 */
export function LinkAssetsDialog({
  onClose,
  onLinked,
  line: fixedLine = null,
  assets: fixedAssets = null,
}: {
  onClose: () => void;
  /** After a link went through (even partially) — e.g. to clear a list selection. */
  onLinked?: () => void;
  line?: LinkLineTarget | null;
  assets?: LinkAssetRef[] | null;
}) {
  const t = useTranslations("purchases.link");
  const tc = useTranslations("common");
  const titleOf = usePurchaseTitle();
  const linkAssets = useLinkAssets();
  const updateLine = useUpdatePurchaseOrderLine();

  const [target, setTarget] = useState<LinkLineTarget | null>(fixedLine);
  const [picked, setPicked] = useState<LinkAssetRef[]>(fixedAssets ?? []);
  const [step, setStep] = useState<Step>(fixedAssets === null ? "assets" : fixedLine === null ? "line" : "diff");
  const [result, setResult] = useState<LinkAssetsResult | null>(null);
  const assetIds = useMemo(() => picked.map((asset) => asset.id), [picked]);

  const preview = useLinkPreview(
    step === "diff" && target ? { purchaseOrderId: target.purchase.id, lineId: target.line.id } : null,
    assetIds,
  );

  // The diff state, kept per line + asset set — a refetch (after raising the line) keeps what was chosen.
  const choiceKey = target ? `${target.line.id}:${assetIds.join(",")}` : "";
  const [diff, setDiff] = useState<{ key: string; choices: ApplyChoices; every: boolean; moved: Set<string> } | null>(
    null,
  );
  if (preview.data && diff?.key !== choiceKey) {
    setDiff({ key: choiceKey, choices: defaultChoices(preview.data.assets), every: false, moved: new Set() });
  }

  function submit(data: PurchaseLinkPreview) {
    if (!target || !diff) return;
    const toLink = assetsToLink(data.assets, diff.moved);
    linkAssets.mutate(
      { id: target.purchase.id, lineId: target.line.id, data: buildLinkPayload(toLink, diff.choices) },
      {
        onSuccess: (outcome) => {
          if (outcome.linked.length > 0) onLinked?.();
          if (outcome.failed.length === 0) {
            toast.success(t("linkedToast", { count: outcome.linked.length }));
            onClose();
            return;
          }
          setResult(outcome);
          setStep("result");
        },
        onError: (error) => notifyError(error, t("linkError")),
      },
    );
  }

  function raiseLine(line: PurchaseOrderLine, to: number) {
    if (!target) return;
    updateLine.mutate(
      { id: target.purchase.id, lineId: line.id, data: { quantity: to } },
      {
        onSuccess: (updated) => {
          toast.success(t("raisedToast", { quantity: to }));
          setTarget({ purchase: target.purchase, line: updated });
        },
        onError: (error) => notifyError(error, t("raiseError")),
      },
    );
  }

  const description =
    step === "assets" && target
      ? t("pickAssetsDescription", { purchase: titleOf(target.purchase), line: target.line.description })
      : step === "line"
        ? t("pickLineDescription", { count: picked.length })
        : target
          ? t("diffDescription", { purchase: titleOf(target.purchase), line: target.line.description })
          : "";

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("title", { count: Math.max(picked.length, 1) })}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {step === "assets" && target ? (
          <AssetPickerStep
            line={target.line}
            selected={picked}
            onChange={setPicked}
            onCancel={onClose}
            onNext={() => setStep("diff")}
          />
        ) : null}

        {step === "line" ? (
          <LinePickerStep
            assets={picked}
            initial={target}
            onCancel={onClose}
            onNext={(next) => {
              setTarget(next);
              setStep("diff");
            }}
          />
        ) : null}

        {step === "diff" ? (
          preview.isError ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{t("previewError")}</p>
              <Button variant="outline" size="sm" onClick={() => preview.refetch()}>
                <ArrowPathIcon />
                {tc("retry")}
              </Button>
            </div>
          ) : !preview.data || !diff || !target ? (
            <div className="space-y-2" aria-hidden>
              <Skeleton className="h-6 w-2/3" />
              <Skeleton className="h-32 w-full" />
            </div>
          ) : (
            <DiffStep
              preview={preview.data}
              line={target.line}
              choices={diff.choices}
              every={diff.every}
              moved={diff.moved}
              onChoices={(choices) => setDiff({ ...diff, choices })}
              onEvery={(every) =>
                setDiff({
                  ...diff,
                  every,
                  choices: every ? everyValueChoices(preview.data!.assets) : defaultChoices(preview.data!.assets),
                })
              }
              onMoved={(moved) => setDiff({ ...diff, moved })}
              raising={updateLine.isPending}
              onRaise={raiseLine}
              submitting={linkAssets.isPending}
              onBack={
                fixedLine === null || fixedAssets === null
                  ? () => setStep(fixedAssets === null ? "assets" : "line")
                  : undefined
              }
              onSubmit={() => submit(preview.data!)}
            />
          )
        ) : null}

        {step === "result" && result && preview.data && target ? (
          <LinkResultView
            result={result}
            preview={preview.data}
            purchaseId={target.purchase.id}
            onDone={onClose}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

// ── Step 1a: pick assets for a line ───────────────────────────────────────────────────────────────────

function AssetPickerStep({
  line,
  selected,
  onChange,
  onCancel,
  onNext,
}: {
  line: PurchaseOrderLine;
  selected: LinkAssetRef[];
  onChange: (next: LinkAssetRef[]) => void;
  onCancel: () => void;
  onNext: () => void;
}) {
  const t = useTranslations("purchases.link");
  const tc = useTranslations("common");
  const [q, setQ] = useState("");
  const [byModel, setByModel] = useState(line.assetModelId !== null);
  const { data: models } = useAssetModels();
  const { data, isLoading, isFetching } = useAssets({
    q: q || undefined,
    modelId: byModel && line.assetModelId ? line.assetModelId : undefined,
    limit: 50,
  });
  const chosen = new Set(selected.map((asset) => asset.id));
  const model = line.assetModelId ? models?.find((m) => m.id === line.assetModelId) : undefined;
  const items = data?.items ?? [];

  function toggle(asset: (typeof items)[number], on: boolean) {
    onChange(
      on
        ? [...selected, { id: asset.id, name: asset.name, assetTag: asset.assetTag, modelId: asset.modelId }]
        : selected.filter((s) => s.id !== asset.id),
    );
  }

  return (
    <>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
        <SearchInput value={q} debounceMs={300} onDebouncedChange={setQ} label={t("searchAssets")} placeholder={t("searchAssets")} />
        {byModel && model ? (
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="secondary" className="gap-1">
              {t("modelChip", { model: `${model.manufacturer} ${model.name}` })}
              <button
                type="button"
                className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t("removeModelChip")}
                onClick={() => setByModel(false)}
              >
                <XMarkIcon className="size-3.5" aria-hidden />
              </button>
            </Badge>
          </div>
        ) : null}
        {isLoading ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("noAssets")}</p>
        ) : (
          <ul className={cn("divide-y rounded-md border", isFetching && "opacity-70")}>
            {items.map((asset) => {
              const id = `link-asset-${asset.id}`;
              return (
                <li key={asset.id} className="flex items-center gap-3 px-3 py-2">
                  <Checkbox id={id} checked={chosen.has(asset.id)} onCheckedChange={(on) => toggle(asset, on === true)} />
                  <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm">
                    <span className="font-medium">{asset.name}</span>
                    <span className="block truncate font-mono text-xs text-muted-foreground">
                      {[asset.assetTag, asset.serial].filter(Boolean).join(" · ") || "—"}
                    </span>
                  </label>
                  {asset.model ? (
                    <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                      {asset.model.manufacturer} {asset.model.name}
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <DialogFooter className="items-center sm:justify-between">
        <p className="text-sm text-muted-foreground" role="status">
          {t("selectedCount", { count: selected.length, pending: line.pendingQuantity })}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" onClick={onCancel}>
            {tc("cancel")}
          </Button>
          <Button disabled={selected.length === 0} onClick={onNext}>
            {tc("next")}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

// ── Step 1b: pick the purchase and the line for assets ────────────────────────────────────────────────

function LinePickerStep({
  assets,
  initial,
  onCancel,
  onNext,
}: {
  assets: LinkAssetRef[];
  initial: LinkLineTarget | null;
  onCancel: () => void;
  onNext: (target: LinkLineTarget) => void;
}) {
  const t = useTranslations("purchases.link");
  const tr = useTranslations("purchases.receipt");
  const tc = useTranslations("common");
  const titleOf = usePurchaseTitle();
  const [query, setQuery] = useState("");
  const [purchaseId, setPurchaseId] = useState(initial?.purchase.id ?? "");
  const [lineId, setLineId] = useState(initial?.line.id ?? "");
  const { data: page, isFetching } = usePurchaseOrders({ q: query || undefined, limit: 20 });
  const { data: purchase } = usePurchaseOrder(purchaseId || undefined);
  const { data: models } = useAssetModels();

  // Lines of the assets' model first (ux-proposal §3.e), then in the purchase's order.
  const modelIds = new Set(assets.map((asset) => asset.modelId).filter(Boolean));
  const lines = (purchase?.lines ?? [])
    .filter((line) => line.kind === "ASSET")
    .sort((a, b) => Number(modelIds.has(b.assetModelId)) - Number(modelIds.has(a.assetModelId)));
  const items = (page?.items ?? []).map((p) => ({
    value: p.id,
    label: p.supplier && p.reference ? `${titleOf(p)} · ${p.supplier.name}` : titleOf(p),
  }));
  const chosenLine = lines.find((line) => line.id === lineId);
  const modelName = (id: string | null) => {
    const model = id ? models?.find((m) => m.id === id) : undefined;
    return model ? `${model.manufacturer} ${model.name}` : null;
  };

  return (
    <>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <Field>
          <FieldLabel htmlFor="link-purchase">{t("purchase")}</FieldLabel>
          <Combobox
            id="link-purchase"
            value={purchaseId}
            onValueChange={(value) => {
              setPurchaseId(value);
              setLineId("");
            }}
            items={items}
            onSearchChange={setQuery}
            loading={isFetching}
            selectedLabel={purchase ? titleOf(purchase) : undefined}
            placeholder={t("purchasePlaceholder")}
            searchPlaceholder={t("purchaseSearch")}
            emptyText={t("noPurchases")}
            loadingText={tc("searching")}
          />
        </Field>
        {purchase ? (
          lines.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noAssetLines")}</p>
          ) : (
            <Field>
              <FieldLabel id="link-line-label">{t("line")}</FieldLabel>
              <RadioGroup value={lineId} onValueChange={setLineId} aria-labelledby="link-line-label">
                {lines.map((line) => {
                  const id = `link-line-${line.id}`;
                  const model = modelName(line.assetModelId);
                  return (
                    <div key={line.id} className="flex items-start gap-3 rounded-md border px-3 py-2">
                      <RadioGroupItem id={id} value={line.id} className="mt-0.5" />
                      <label htmlFor={id} className="min-w-0 flex-1 cursor-pointer text-sm">
                        <span className="font-medium">{line.description}</span>
                        <span className="block text-xs text-muted-foreground">
                          {[
                            model,
                            tr("progress", { received: line.receivedQuantity, ordered: line.quantity }),
                            line.pendingQuantity > 0 ? tr("pending", { count: line.pendingQuantity }) : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </label>
                      {modelIds.has(line.assetModelId) ? <Badge variant="outline">{t("sameModel")}</Badge> : null}
                    </div>
                  );
                })}
              </RadioGroup>
            </Field>
          )
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {tc("cancel")}
        </Button>
        <Button
          disabled={!purchase || !chosenLine}
          onClick={() => purchase && chosenLine && onNext({ purchase, line: chosenLine })}
        >
          {tc("next")}
        </Button>
      </DialogFooter>
    </>
  );
}

// ── Step 2: the diff ──────────────────────────────────────────────────────────────────────────────────

const FIELD_ORDER: PurchaseApplyField[] = ["purchaseCost", "purchaseDate", "warrantyEnd", "company", "modelId"];

function DiffStep({
  preview,
  line,
  choices,
  every,
  moved,
  onChoices,
  onEvery,
  onMoved,
  raising,
  onRaise,
  submitting,
  onBack,
  onSubmit,
}: {
  preview: PurchaseLinkPreview;
  line: PurchaseOrderLine;
  choices: ApplyChoices;
  every: boolean;
  moved: Set<string>;
  onChoices: (choices: ApplyChoices) => void;
  onEvery: (every: boolean) => void;
  onMoved: (moved: Set<string>) => void;
  raising: boolean;
  onRaise: (line: PurchaseOrderLine, to: number) => void;
  submitting: boolean;
  onBack?: () => void;
  onSubmit: () => void;
}) {
  const t = useTranslations("purchases.link");
  const tc = useTranslations("common");
  const format = useValueFormat(preview);
  const [showEach, setShowEach] = useState(false);

  const toLink = assetsToLink(preview.assets, moved);
  const groups = fieldGroups(toLink, choices);
  const summary = linkSummary(toLink, choices);
  const over = overReceipt(line, toLink.length);
  const expected = line.quantity - line.cancelledQuantity;
  const already = preview.assets.filter((asset) => asset.linkState === "THIS_LINE");
  const elsewhere = preview.assets.filter((asset) => asset.linkState === "OTHER_LINE");

  return (
    <>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        <p className="text-sm">{t("after", { received: over.after, expected })}</p>

        {over.over ? (
          <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
            <p className="text-sm">{t("overWarning", { expected, after: over.after })}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              disabled={raising}
              onClick={() => onRaise(line, over.raiseTo)}
            >
              {t("raise", { quantity: over.raiseTo })}
            </Button>
          </Callout>
        ) : null}

        {already.length > 0 ? (
          <p className="text-sm text-muted-foreground">{t("alreadyHere", { count: already.length })}</p>
        ) : null}
        {preview.missing.length > 0 ? (
          <p className="text-sm text-muted-foreground">{t("missing", { count: preview.missing.length })}</p>
        ) : null}

        {elsewhere.length > 0 ? (
          <div className="space-y-2 rounded-md border p-3">
            <p className="text-sm font-medium">{t("elsewhereTitle")}</p>
            <p className="text-xs text-muted-foreground">{t("elsewhereHelp")}</p>
            <ul className="space-y-1.5">
              {elsewhere.map((asset) => {
                const id = `link-move-${asset.assetId}`;
                return (
                  <li key={asset.assetId} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      id={id}
                      checked={moved.has(asset.assetId)}
                      onCheckedChange={(on) => {
                        const next = new Set(moved);
                        if (on === true) next.add(asset.assetId);
                        else next.delete(asset.assetId);
                        onMoved(next);
                      }}
                    />
                    <label htmlFor={id} className="cursor-pointer">
                      {t("moveHere", { asset: assetLabel(asset) })}
                    </label>
                    {asset.linkedPurchaseOrderId ? (
                      <Link
                        href={`/purchases/${asset.linkedPurchaseOrderId}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-muted-foreground hover:underline"
                      >
                        {t("openCurrent")}
                      </Link>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}

        {toLink.length > 0 ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm font-medium">{t("applyTitle")}</p>
              <label className="flex items-center gap-2 text-sm">
                <Switch checked={every} onCheckedChange={onEvery} aria-label={t("applyEvery")} />
                {t("applyEvery")}
              </label>
            </div>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium">{t("columns.field")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("columns.purchase")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("columns.assets")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("columns.apply")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {FIELD_ORDER.map((field) => {
                    const group = groups.find((g) => g.field === field)!;
                    return (
                      <tr key={field} className="align-top">
                        <td className="px-3 py-2 font-medium">{t(`fields.${field}`)}</td>
                        <td className="px-3 py-2">{format.offered(field)}</td>
                        <td className="px-3 py-2 text-muted-foreground">
                          {[
                            group.fill > 0 ? t("counts.empty", { count: group.fill }) : null,
                            group.replace > 0 ? t("counts.differs", { count: group.replace }) : null,
                            group.same > 0 ? t("counts.same", { count: group.same }) : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "—"}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex flex-col gap-1.5">
                            {group.fill > 0 ? (
                              <GroupToggle
                                id={`apply-fill-${field}`}
                                label={t("fill", { count: group.fill })}
                                checked={group.fillChecked}
                                total={group.fill}
                                onChange={(on) => onChoices(setFieldGroup(choices, toLink, field, "FILL", on))}
                              />
                            ) : null}
                            {group.replace > 0 ? (
                              <GroupToggle
                                id={`apply-replace-${field}`}
                                label={t("replace", { count: group.replace })}
                                checked={group.replaceChecked}
                                total={group.replace}
                                onChange={(on) => onChoices(setFieldGroup(choices, toLink, field, "REPLACE", on))}
                              />
                            ) : null}
                            {group.fill === 0 && group.replace === 0 ? (
                              <span className="text-muted-foreground">
                                {group.unavailable === toLink.length ? t("nothingOffered") : t("nothingToApply")}
                              </span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">{t("alwaysLinked")}</p>

            <Button type="button" variant="ghost" size="sm" className="-ml-2" onClick={() => setShowEach((v) => !v)}>
              {showEach ? t("hideEach") : t("showEach")}
            </Button>
            {showEach ? (
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">{t("columns.asset")}</th>
                      {FIELD_ORDER.map((field) => (
                        <th key={field} className="px-3 py-2 text-left font-medium">
                          {t(`fields.${field}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {toLink.map((asset) => (
                      <tr key={asset.assetId} className="align-top">
                        <td className="px-3 py-2 font-medium">{assetLabel(asset)}</td>
                        {FIELD_ORDER.map((field) => {
                          const action = asset.fields[field].action;
                          const actionable = action === "FILL" || action === "REPLACE";
                          const id = `apply-${asset.assetId}-${field}`;
                          return (
                            <td key={field} className="px-3 py-2">
                              <div className="flex items-start gap-1.5">
                                {actionable ? (
                                  <Checkbox
                                    id={id}
                                    checked={choices[asset.assetId]?.[field] === true}
                                    onCheckedChange={(on) => onChoices(setCell(choices, asset, field, on === true))}
                                    aria-label={t("cellLabel", { field: t(`fields.${field}`), asset: assetLabel(asset) })}
                                  />
                                ) : null}
                                <span className={cn(!actionable && "text-muted-foreground")}>
                                  {format.current(asset, field)}
                                </span>
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("nothingToLink")}</p>
        )}
      </div>

      <DialogFooter className="items-center sm:justify-between">
        <p className="text-sm text-muted-foreground" role="status">
          {t("summary", summary)}
        </p>
        <div className="flex gap-2">
          {onBack ? (
            <Button variant="outline" onClick={onBack} disabled={submitting}>
              {tc("back")}
            </Button>
          ) : null}
          <Button disabled={toLink.length === 0 || submitting} onClick={onSubmit}>
            {submitting && <ArrowPathIcon className="animate-spin" />}
            {t("submit", { count: toLink.length })}
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

/** A grouped toggle: checked when every cell is, indeterminate when some are (the per-asset grid differs). */
function GroupToggle({
  id,
  label,
  checked,
  total,
  onChange,
}: {
  id: string;
  label: string;
  checked: number;
  total: number;
  onChange: (on: boolean) => void;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2">
      <Checkbox
        id={id}
        checked={checked === total ? true : checked === 0 ? false : "indeterminate"}
        onCheckedChange={(on) => onChange(on === true)}
      />
      {label}
    </label>
  );
}

function assetLabel(asset: Pick<PurchaseLinkPreviewAsset, "assetTag" | "name">): string {
  return asset.assetTag ? `${asset.assetTag} · ${asset.name}` : asset.name;
}

/** How the diff prints each value: dates, money with its label, model names; blank as an em dash. */
function useValueFormat(preview: PurchaseLinkPreview) {
  const t = useTranslations("purchases.link");
  const locale = useLocale();
  const { date } = useFormatters();
  const { data: models } = useAssetModels();
  const modelName = (id: string) => {
    const model = models?.find((m) => m.id === id);
    return model ? `${model.manufacturer} ${model.name}` : t("aModel");
  };
  const none = <span className="text-muted-foreground">—</span>;

  function cost(value: { amount: number | null; currency: string | null } | null): ReactNode {
    if (!value || value.amount === null) return none;
    return (
      <span className="font-mono tabular-nums">
        {formatMoney(value.amount, locale, value.currency)}
        {value.currency?.trim() ? null : <span className="font-sans text-muted-foreground"> · {t("noCurrency")}</span>}
      </span>
    );
  }

  function text(field: PurchaseApplyField, value: string | null): ReactNode {
    if (value === null) return none;
    if (field === "purchaseDate" || field === "warrantyEnd") return <span className="font-mono">{date(value)}</span>;
    if (field === "modelId") return modelName(value);
    return value;
  }

  return {
    offered(field: PurchaseApplyField): ReactNode {
      const values = preview.values;
      if (field === "purchaseCost") return cost(values.purchaseCost);
      const shown = text(field, values[field]);
      if (field === "purchaseDate" && values.purchaseDateSource) {
        return (
          <>
            {shown}{" "}
            <span className="text-xs text-muted-foreground">
              {t(values.purchaseDateSource === "INVOICE" ? "fromInvoice" : "fromOrder")}
            </span>
          </>
        );
      }
      if (field === "warrantyEnd" && values.warrantyEnd && preview.line.warrantyMonths !== null) {
        return (
          <>
            {shown}{" "}
            <span className="text-xs text-muted-foreground">
              {t("warrantyMonths", { months: preview.line.warrantyMonths })}
            </span>
          </>
        );
      }
      return shown;
    },
    current(asset: PurchaseLinkPreviewAsset, field: PurchaseApplyField): ReactNode {
      if (field === "purchaseCost") return cost(asset.fields.purchaseCost.current);
      return text(field, asset.fields[field].current);
    },
  };
}

// ── Result: partial success ───────────────────────────────────────────────────────────────────────────

/** The link went through for some assets and not others: say how many, and why each one was refused. */
export function LinkResultView({
  result,
  preview,
  purchaseId,
  onDone,
}: {
  result: Pick<LinkAssetsResult, "failed"> & { linked: readonly unknown[] };
  preview: Pick<PurchaseLinkPreview, "assets">;
  purchaseId: string;
  onDone: () => void;
}) {
  const t = useTranslations("purchases.link");
  const names = new Map(preview.assets.map((asset) => [asset.assetId, asset]));
  const failures = failureViews(result.failed, names);
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
        {result.linked.length > 0 ? (
          <Callout tone="success" icon={<CheckCircleIcon />}>
            <p className="text-sm font-medium">{t("linkedSummary", { count: result.linked.length })}</p>
          </Callout>
        ) : (
          <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
            <p className="text-sm font-medium">{t("noneLinked")}</p>
          </Callout>
        )}
        <FailureList failures={failures} title={t("failedTitle")} />
      </div>
      <DialogFooter>
        <Button variant="outline" asChild>
          <Link href={`/purchases/${purchaseId}`}>{t("openPurchase")}</Link>
        </Button>
        <Button onClick={onDone}>{t("done")}</Button>
      </DialogFooter>
    </div>
  );
}

/** Refused assets with their localized reason (or the API's own text for a reason this build does not know). */
export function FailureList({
  failures,
  title,
}: {
  failures: ReturnType<typeof failureViews>;
  title: string;
}) {
  const t = useTranslations("purchases.link.reasons");
  if (failures.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <ul className="max-h-48 divide-y overflow-y-auto rounded-md border text-sm">
        {failures.map((failure) => (
          <li key={failure.assetId} className="flex flex-wrap items-baseline gap-x-2 px-3 py-2">
            <span className="font-medium">{failure.label}</span>
            <span className="text-muted-foreground">{failure.reasonKey ? t(failure.reasonKey) : failure.error}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
