"use client";

import { ArrowPathIcon, ExclamationTriangleIcon, InformationCircleIcon } from "@heroicons/react/24/outline";
import type { PurchaseOrderLine } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ApplicationCombobox } from "@/components/application-combobox";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useApplyLicense,
  useLicenseProposal,
  useUpdatePurchaseOrderLine,
} from "@/lib/api/hooks/use-purchase-orders";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useCan } from "@/lib/hooks/use-permissions";
import type { PurchaseTitleSource } from "@/lib/purchases/display";
import {
  buildApplyLicensePayload,
  type LicenseApplyError,
  type LicenseApplyForm,
  licenseApplyOutcome,
  licenseApplyPrefill,
  licenseSeats,
} from "@/lib/purchases/license";
import { usePurchaseTitle } from "@/app/(app)/purchases/_components/purchase-display";

/**
 * Whether the viewer may apply a license line: the proposal needs `purchaseOrder:read` + `application:read`,
 * the apply `purchaseOrder:write` + `application:write` (#1477).
 */
export function useCanApplyLicense(): boolean {
  const canWritePurchases = useCan("purchaseOrder:write");
  const canReadApplications = useCan("application:read");
  const canWriteApplications = useCan("application:write");
  return canWritePurchases && canReadApplications && canWriteApplications;
}

/**
 * *Apply license* for a `LICENSE` line (ADR-0099 §2, Phase 2 #1477): the line PROPOSES a seats and renewal
 * update to its application, and only what the person confirms is applied — `seatsPurchased` never changes on
 * its own. The proposal shows the application's seats now and after, the seats in use and the renewal date;
 * the seats to add start at the line's pending seats and stay editable; the renewal date is typed (the term is
 * not on the line). Applying past what the line bought is allowed with a warning, and an application that
 * tracks no seat count says it starts counting from these. A line without an application asks for one and
 * saves it on the line first — the same rule as an asset line without a model.
 *
 * Mounted only while open; gate it with {@link useCanApplyLicense}.
 */
export function ApplyLicenseDialog({
  purchase,
  line,
  onClose,
}: {
  purchase: PurchaseTitleSource & { id: string };
  line: PurchaseOrderLine;
  onClose: () => void;
}) {
  const t = useTranslations("purchases.applyLicense");
  const tc = useTranslations("common");
  const titleOf = usePurchaseTitle();
  const { date } = useFormatters();
  const { data: proposal, isLoading, isError, refetch } = useLicenseProposal({
    purchaseOrderId: purchase.id,
    lineId: line.id,
  });
  const apply = useApplyLicense();
  const updateLine = useUpdatePurchaseOrderLine();
  const [form, setForm] = useState<LicenseApplyForm | null>(null);
  const [error, setError] = useState<LicenseApplyError | null>(null);
  const [applicationId, setApplicationId] = useState("");
  const [seededFor, setSeededFor] = useState<string | null>(null);

  // Seed the form from the proposal once it arrives, and again after the line's application changes — adjusted
  // during render, not in an effect (https://react.dev/learn/you-might-not-need-an-effect).
  const seedKey = proposal ? `${proposal.application?.id ?? ""}:${proposal.seatsToAdd}` : null;
  if (proposal && seedKey !== seededFor) {
    setSeededFor(seedKey);
    setForm(licenseApplyPrefill(proposal));
  }

  const live = proposal?.application != null && proposal.application.deletedAt === null;
  const needsApplication = proposal != null && !live;
  const seats = form ? licenseSeats(form.seatsToAdd) : 0;
  const outcome = proposal && live ? licenseApplyOutcome(proposal, seats ?? 0) : null;
  const pending = apply.isPending || updateLine.isPending;

  function mapApplication() {
    if (!applicationId) return;
    updateLine.mutate(
      { id: purchase.id, lineId: line.id, data: { applicationId } },
      {
        onSuccess: () => {
          toast.success(t("applicationSaved"));
          setApplicationId("");
        },
        onError: (err) => notifyError(err, t("applicationSaveError")),
      },
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!form || !proposal || !live) return;
    const built = buildApplyLicensePayload(form);
    if (!built.ok) {
      setError(built.error);
      return;
    }
    apply.mutate(
      { id: purchase.id, lineId: line.id, data: built.payload },
      {
        onSuccess: (result) => {
          toast.success(
            built.payload.seatsToAdd
              ? t("appliedToast", { count: built.payload.seatsToAdd, name: result.application.name })
              : t("renewalToast", { name: result.application.name }),
          );
          onClose();
        },
        onError: (err) => notifyError(err, t("error")),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={onSubmit} noValidate className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>
              {t("description", { purchase: titleOf(purchase), line: line.description })}
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="space-y-2" aria-hidden>
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : isError || !proposal ? (
            <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
              <p className="text-sm">{t("loadError")}</p>
              <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => refetch()}>
                {tc("retry")}
              </Button>
            </Callout>
          ) : needsApplication ? (
            <Field>
              <FieldLabel htmlFor="apply-license-application" required>
                {t("application")}
              </FieldLabel>
              <ApplicationCombobox
                id="apply-license-application"
                value={applicationId}
                onValueChange={setApplicationId}
                placeholder={t("applicationPlaceholder")}
              />
              <FieldDescription>
                {proposal.application ? t("applicationArchived", { name: proposal.application.name }) : t("applicationMissing")}
              </FieldDescription>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-fit"
                disabled={!applicationId || updateLine.isPending}
                onClick={mapApplication}
              >
                {updateLine.isPending && <ArrowPathIcon className="animate-spin" />}
                {t("saveApplication")}
              </Button>
            </Field>
          ) : (
            <>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-lg border p-3 text-sm">
                <div className="col-span-2">
                  <dt className="text-xs text-muted-foreground">{t("application")}</dt>
                  <dd className="font-medium">
                    <Link href={`/applications/${proposal.application!.id}`} className="hover:underline">
                      {proposal.application!.name}
                    </Link>
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t("seats")}</dt>
                  <dd className="font-mono tabular-nums">
                    {proposal.application!.seatsPurchased === null
                      ? t("untracked")
                      : proposal.application!.seatsPurchased}
                    {outcome?.seatsAfter != null && (seats ?? 0) > 0 ? (
                      <span className="text-muted-foreground"> → {outcome.seatsAfter}</span>
                    ) : null}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t("inUse")}</dt>
                  <dd className="font-mono tabular-nums">{proposal.application!.seatsUsed ?? "—"}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t("renewal")}</dt>
                  <dd className="font-mono tabular-nums">
                    {proposal.application!.renewalDate ? date(proposal.application!.renewalDate) : "—"}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{t("applied")}</dt>
                  <dd className="font-mono tabular-nums">
                    {t("appliedOf", {
                      applied: proposal.line.receivedQuantity,
                      bought: proposal.line.quantity - proposal.line.cancelledQuantity,
                    })}
                  </dd>
                </div>
              </dl>

              <div className="grid gap-4 sm:grid-cols-2">
                <Field data-invalid={error === "seatsInvalid" || undefined}>
                  <FieldLabel htmlFor="apply-license-seats">{t("seatsToAdd")}</FieldLabel>
                  <Input
                    id="apply-license-seats"
                    inputMode="numeric"
                    value={form?.seatsToAdd ?? ""}
                    onChange={(event) => {
                      const seatsToAdd = event.target.value;
                      setForm((prev) => (prev ? { ...prev, seatsToAdd } : prev));
                      setError(null);
                    }}
                    aria-invalid={error === "seatsInvalid" || undefined}
                    className="font-mono tabular-nums"
                    autoFocus
                  />
                  <FieldDescription>{t("seatsHelp", { pending: proposal.seatsToAdd })}</FieldDescription>
                  {error === "seatsInvalid" ? <FieldError>{t("seatsInvalid")}</FieldError> : null}
                </Field>
                <Field>
                  <FieldLabel htmlFor="apply-license-renewal">{t("renewalDate")}</FieldLabel>
                  <Input
                    id="apply-license-renewal"
                    type="date"
                    value={form?.renewalDate ?? ""}
                    onChange={(event) => {
                      const renewalDate = event.target.value;
                      setForm((prev) => (prev ? { ...prev, renewalDate } : prev));
                      setError(null);
                    }}
                    className="font-mono"
                  />
                  <FieldDescription>{t("renewalHelp")}</FieldDescription>
                </Field>
              </div>

              {outcome?.untracked && (seats ?? 0) > 0 ? (
                <Callout tone="info" icon={<InformationCircleIcon />}>
                  <p className="text-sm">{t("untrackedWarning", { count: seats ?? 0 })}</p>
                </Callout>
              ) : null}
              {outcome?.overApplied ? (
                <Callout tone="warning" icon={<ExclamationTriangleIcon />}>
                  <p className="text-sm">
                    {t("overWarning", { bought: outcome.bought, after: outcome.appliedAfter })}
                  </p>
                </Callout>
              ) : null}
              {error === "nothingToApply" ? (
                <p className="text-sm text-destructive" role="alert">
                  {t("nothingToApply")}
                </p>
              ) : null}
            </>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {tc("cancel")}
            </Button>
            <Button type="submit" disabled={pending || !proposal || !live || form === null}>
              {apply.isPending && <ArrowPathIcon className="animate-spin" />}
              {t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
