"use client";

import type { Supplier, SupplierMergeField } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Combobox } from "@/components/combobox";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Skeleton } from "@/components/ui/skeleton";
import { useMergeSupplier, useSupplierMergePreview, useSuppliers } from "@/lib/api/hooks/use-suppliers";
import { notifyError } from "@/lib/api/notify-error";

/** Each mergeable field → its label keys in `purchases.suppliers.form`: a contact group, then the field. */
const FIELD_LABEL: Record<SupplierMergeField, [group: string | null, key: string]> = {
  taxId: [null, "taxId"],
  website: [null, "website"],
  salesContactName: ["salesContact", "contactName"],
  salesContactEmail: ["salesContact", "contactEmail"],
  salesContactPhone: ["salesContact", "contactPhone"],
  supportContactName: ["supportContact", "contactName"],
  supportContactEmail: ["supportContact", "contactEmail"],
  supportContactPhone: ["supportContact", "contactPhone"],
  notes: [null, "notes"],
};

/**
 * Merge this supplier — a duplicate — into the one that stays (ADMIN, #1496). The operator picks the
 * supplier that stays and reads the preview before confirming: the purchases that move (archived ones
 * included), the empty fields filled from the duplicate, and the fields kept as they are — nothing is
 * overwritten. The duplicate is archived, never deleted. `onMerged` receives the supplier that stays.
 */
export function MergeSupplierDialog({
  open,
  onOpenChange,
  source,
  onMerged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  source: Supplier;
  onMerged: (kept: Supplier) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {/* The content unmounts on close, so each opening starts with no pick. */}
        <MergeSupplierContent source={source} onClose={() => onOpenChange(false)} onMerged={onMerged} />
      </DialogContent>
    </Dialog>
  );
}

function MergeSupplierContent({
  source,
  onClose,
  onMerged,
}: {
  source: Supplier;
  onClose: () => void;
  onMerged: (kept: Supplier) => void;
}) {
  const t = useTranslations("purchases.suppliers.merge");
  const tForm = useTranslations("purchases.suppliers.form");
  const tc = useTranslations("common");
  const [query, setQuery] = useState("");
  const [targetId, setTargetId] = useState("");

  const { data: candidates, isFetching } = useSuppliers({ q: query || undefined, limit: 50 });
  const items = useMemo(
    () =>
      (candidates?.items ?? [])
        .filter((supplier) => supplier.id !== source.id)
        .map((supplier) => ({
          value: supplier.id,
          // The tax ID tells same-named suppliers apart.
          label: supplier.taxId ? `${supplier.name} · ${supplier.taxId}` : supplier.name,
        })),
    [candidates, source.id],
  );
  const preview = useSupplierMergePreview(targetId || undefined, source.id);
  const merge = useMergeSupplier();

  const fieldLabel = (field: SupplierMergeField) => {
    const [group, key] = FIELD_LABEL[field];
    return group ? `${tForm(group)} · ${tForm(key)}` : tForm(key);
  };

  const onConfirm = () => {
    if (!preview.data) return;
    const target = preview.data.target;
    merge.mutate(
      { targetId: target.id, sourceId: source.id },
      {
        onSuccess: (result) => {
          toast.success(t("mergedToast", { source: source.name, target: result.supplier.name }));
          onClose();
          onMerged(result.supplier);
        },
        onError: (error) => notifyError(error, t("error")),
      },
    );
  };

  const data = preview.data;
  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("title", { name: source.name })}</DialogTitle>
        <DialogDescription>{t("description", { name: source.name })}</DialogDescription>
      </DialogHeader>

      <Field>
        <FieldLabel htmlFor="merge-supplier-target">{t("target")}</FieldLabel>
        <Combobox
          id="merge-supplier-target"
          value={targetId}
          onValueChange={setTargetId}
          items={items}
          onSearchChange={setQuery}
          loading={isFetching}
          selectedLabel={data?.target.name}
          placeholder={t("targetPlaceholder")}
          searchPlaceholder={t("targetSearch")}
          emptyText={t("targetEmpty")}
          loadingText={tc("searching")}
          typeToSearchText={tc("typeToSearch")}
        />
      </Field>

      {targetId && preview.isLoading ? (
        <div className="space-y-2" aria-busy="true">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : null}
      {targetId && preview.isError ? (
        <p role="alert" className="text-sm text-destructive-text">
          {preview.error instanceof Error && preview.error.message ? preview.error.message : t("previewError")}
        </p>
      ) : null}
      {data ? (
        <div className="space-y-4 text-sm" aria-live="polite">
          <p>
            {t("purchases", { count: data.purchases.live + data.purchases.archived, target: data.target.name })}
            {data.purchases.archived > 0 ? ` ${t("archivedPurchases", { count: data.purchases.archived })}` : null}
          </p>
          <div className="space-y-1">
            <p className="font-medium">{t("fillTitle", { name: source.name })}</p>
            {data.fill.length === 0 ? (
              <p className="text-muted-foreground">{t("fillNone")}</p>
            ) : (
              <dl className="space-y-1">
                {data.fill.map(({ field, value }) => (
                  <div key={field} className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">{fieldLabel(field)}</dt>
                    <dd className="break-all">{value}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          {data.kept.length > 0 ? (
            <div className="space-y-1">
              <p className="font-medium">{t("keptTitle", { name: data.target.name })}</p>
              <dl className="space-y-1">
                {data.kept.map(({ field, value, sourceValue }) => (
                  <div key={field} className="flex flex-wrap gap-x-2">
                    <dt className="text-muted-foreground">{fieldLabel(field)}</dt>
                    <dd className="break-all">
                      {value} <span className="text-muted-foreground">{t("notCopied", { value: sourceValue })}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}
          <p className="text-muted-foreground">{t("archiveNote", { name: source.name })}</p>
        </div>
      ) : null}

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={merge.isPending}>
          {tc("cancel")}
        </Button>
        <Button onClick={onConfirm} disabled={!data || merge.isPending}>
          {t("confirm")}
        </Button>
      </DialogFooter>
    </>
  );
}
