"use client";

import type { Role } from "@lazyit/shared";
import {
  ArchiveBoxIcon,
  ArrowPathIcon,
  InformationCircleIcon,
  PrinterIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { UserAvatar } from "@/components/user-avatar";
import type { OffboardResult } from "@/lib/api/endpoints/users";
import { useOffboardUser } from "@/lib/api/hooks/use-user-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { useLocalStorage } from "@/lib/hooks/use-local-storage";
import {
  DEFAULT_OFFBOARDING_MESSAGE,
  DEFAULT_ORG_NAME,
  DEFAULT_SHOW_ACCESS,
  DEFAULT_SHOW_ASSETS,
  DEFAULT_SHOW_CONSUMABLES,
  OFFBOARDING_MESSAGE_KEY,
  ORG_NAME_KEY,
  SHOW_ACCESS_KEY,
  SHOW_ASSETS_KEY,
  SHOW_CONSUMABLES_KEY,
} from "@/lib/offboarding/constants";
import { offboardingActHref } from "@/lib/offboarding/consumables";
import { actPreviewSections, offboardingImpact } from "@/lib/offboarding/summary";
import { useOffboardingData } from "@/lib/offboarding/use-offboarding-data";
import { OffboardingActPanel } from "./offboarding-act-preview";
import { OffboardingDoneState } from "./offboarding-done";
import { OffboardingImpactTiles } from "./offboarding-impact";
import { OffboardingLists } from "./offboarding-lists";

/**
 * OffboardingSheet — Wave 3b (issue #172, ADR-0049 «Activated Restraint»), widened and re-laid-out in
 * #1532. Replaces the plain delete alert with a dignified offboarding flow: it shows, honestly, exactly
 * which assets get reclaimed, which access gets revoked and which consumables are still out, lets the
 * operator print a signable Return Act, and confirms the soft delete with a sober, respectful "done" —
 * never whimsy on a destructive action.
 *
 * Layout (#1532): impact tiles first (`offboarding-impact`), then two columns — on the left what
 * happens on confirm (`offboarding-lists`), on the right a live preview of the printed act with its
 * settings collapsed underneath (`offboarding-act-preview`). The footer says the account is archived,
 * not deleted, and names the person on the destructive button.
 *
 * The data is resolved client-side by `useOffboardingData` and shared with the printable act, so the
 * two never disagree. On a failed read the lists are replaced by an error with a retry, the tiles show
 * "—", and the act can't be printed from partial data (issue #601).
 */

interface OffboardingSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
    /** Shown beside the email in the header when the call-site has it. */
    role?: Role;
  };
}

export function OffboardingSheet({
  open,
  onOpenChange,
  user,
}: OffboardingSheetProps) {
  const t = useTranslations("users.offboarding");
  const tRole = useTranslations("users.role.labels");
  const tc = useTranslations("common");
  const router = useRouter();
  const offboard = useOffboardUser();
  const {
    assets,
    grants,
    consumables,
    consumablesUnavailable,
    isLoading,
    isError,
    isEmpty,
    refetch,
  } = useOffboardingData(user.id, open);
  // App-level reusable handover template (not per-user); SSR-safe so it never trips hydration.
  const [message, setMessage, mounted] = useLocalStorage(
    OFFBOARDING_MESSAGE_KEY,
    DEFAULT_OFFBOARDING_MESSAGE,
  );
  // App-level act letterhead + which sections the printed act includes (localStorage v1, CEO-ratified).
  const [orgName, setOrgName, orgMounted] = useLocalStorage(
    ORG_NAME_KEY,
    DEFAULT_ORG_NAME,
  );
  const [showAssets, setShowAssets] = useLocalStorage(
    SHOW_ASSETS_KEY,
    DEFAULT_SHOW_ASSETS,
  );
  const [showAccess, setShowAccess] = useLocalStorage(
    SHOW_ACCESS_KEY,
    DEFAULT_SHOW_ACCESS,
  );
  const [showConsumables, setShowConsumables] = useLocalStorage(
    SHOW_CONSUMABLES_KEY,
    DEFAULT_SHOW_CONSUMABLES,
  );
  // Consumable deliveries the operator left OFF this act (per act, default: every row included). Handed
  // to the act in its URL — see `offboardingActHref` for why not storage.
  const [excludedDeliveries, setExcludedDeliveries] = useState<
    ReadonlySet<number>
  >(() => new Set());
  const [done, setDone] = useState(false);
  // The Secret-vaults the offboarded person could read, from the offboard RESULT (issue #869) — a
  // rotation prompt shown in the success state. Empty unless they held vault memberships.
  const [rotationVaults, setRotationVaults] = useState<
    OffboardResult["rotationVaults"]
  >([]);

  const fullName = `${user.firstName} ${user.lastName}`;
  const note = mounted ? message : DEFAULT_OFFBOARDING_MESSAGE;
  const org = orgMounted ? orgName : DEFAULT_ORG_NAME;

  const impact = offboardingImpact({
    isLoading,
    isError,
    consumablesUnavailable,
    assetCount: assets.length,
    grantCount: grants.length,
    consumables,
  });
  const previewSections = useMemo(
    () =>
      actPreviewSections({
        assets,
        grants,
        consumables,
        excluded: excludedDeliveries,
        consumablesUnavailable,
        show: {
          assets: showAssets,
          access: showAccess,
          consumables: showConsumables,
        },
      }),
    [
      assets,
      grants,
      consumables,
      excludedDeliveries,
      consumablesUnavailable,
      showAssets,
      showAccess,
      showConsumables,
    ],
  );

  function openAct() {
    window.open(
      offboardingActHref(user.id, excludedDeliveries),
      "_blank",
      "noopener,noreferrer",
    );
  }

  function setDeliveryIncluded(deliveryId: number, included: boolean) {
    setExcludedDeliveries((current) => {
      const next = new Set(current);
      if (included) next.delete(deliveryId);
      else next.add(deliveryId);
      return next;
    });
  }

  function finish() {
    setDone(false);
    setRotationVaults([]);
    setExcludedDeliveries(new Set());
    onOpenChange(false);
    router.push("/users");
  }

  async function confirm() {
    try {
      const result = await offboard.mutateAsync(user.id);
      toast.success(t("toast.archived"));
      setRotationVaults(result.rotationVaults);
      // Hold the sheet open on the sober "done". With NO secrets to rotate, auto-close after a beat as
      // before; when there ARE vaults to rotate, hold open so the operator can read + act on the SOC2
      // rotation prompt (flashing it for a beat would defeat the purpose) — they close it themselves.
      setDone(true);
      if (result.rotationVaults.length === 0) {
        window.setTimeout(finish, 1100);
      }
    } catch (error) {
      notifyError(error, t("toast.error"));
    }
  }

  // Reset the local success state whenever the sheet is re-opened for a fresh run.
  function handleOpenChange(next: boolean) {
    if (!next) {
      setDone(false);
      setRotationVaults([]);
      setExcludedDeliveries(new Set());
    }
    onOpenChange(next);
  }

  const pending = offboard.isPending || done;

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      {/* The base sheet caps the right side at `sm:max-w-sm` via a `data-[side=right]:` variant, so the
          widening uses the same variant — tailwind-merge then replaces it instead of losing to it. */}
      <SheetContent
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-4xl"
      >
        {done ? (
          <OffboardingDoneState
            name={fullName}
            rotationVaults={rotationVaults}
            onClose={finish}
          />
        ) : (
          <>
            <SheetHeader className="flex-row items-center gap-3 px-5 pt-5 pr-12 pb-4">
              <UserAvatar
                size="lg"
                firstName={user.firstName}
                lastName={user.lastName}
                email={user.email}
              />
              <div className="min-w-0 flex-1">
                <SheetTitle className="truncate text-lg">
                  {t("title", { name: fullName })}
                </SheetTitle>
                <SheetDescription className="truncate">
                  {user.email}
                  {user.role ? ` · ${tRole(user.role)}` : null}
                </SheetDescription>
              </div>
              <span className="hidden shrink-0 items-center gap-1 rounded-sm bg-info/10 px-1.5 py-0.5 text-xs font-medium text-info-text sm:inline-flex">
                <InformationCircleIcon className="size-3.5" aria-hidden />
                {t("restorable")}
              </span>
            </SheetHeader>

            <div className="px-5 pb-4">
              <OffboardingImpactTiles
                impact={impact}
                isLoading={isLoading}
                isError={isError}
              />
            </div>

            <div className="grid flex-1 items-start gap-6 border-t px-5 pt-4 pb-6 md:grid-cols-[minmax(0,1fr)_20rem]">
              {/* A failed read silently collapses the lists to empty, so we refuse to show the
                  asset/access/consumables groups (or the "nothing to return" empty state) on error —
                  that would under-report on an offboarding artifact. Surface the failure + a retry
                  instead, and the act stays disabled below. See issue #601. */}
              <section aria-label={t("onConfirm")}>
                {isError ? (
                  <div
                    role="alert"
                    className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-4 text-sm"
                  >
                    <p className="font-medium text-foreground">
                      {t("loadError.title")}
                    </p>
                    <p className="text-muted-foreground">
                      {t("loadError.body")}
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => refetch()}
                    >
                      <ArrowPathIcon />
                      {t("loadError.retry")}
                    </Button>
                  </div>
                ) : (
                  <OffboardingLists
                    isLoading={isLoading}
                    isEmpty={isEmpty}
                    assets={assets}
                    grants={grants}
                    consumables={consumables}
                    consumablesUnavailable={consumablesUnavailable}
                    excludedDeliveries={excludedDeliveries}
                    onDeliveryIncludedChange={setDeliveryIncluded}
                    printingConsumables={showConsumables}
                  />
                )}
              </section>

              <OffboardingActPanel
                person={{ name: fullName, email: user.email }}
                sections={previewSections}
                isLoading={isLoading}
                isError={isError}
                settings={{
                  orgName: org,
                  onOrgNameChange: setOrgName,
                  message: note,
                  onMessageChange: setMessage,
                  showAssets,
                  onShowAssetsChange: setShowAssets,
                  showAccess,
                  onShowAccessChange: setShowAccess,
                  showConsumables,
                  onShowConsumablesChange: setShowConsumables,
                }}
              />
            </div>

            {/* Sticky, so the decision stays in reach however long the lists run. */}
            <SheetFooter className="sticky bottom-0 flex-col items-stretch gap-2 border-t bg-popover px-5 py-3 sm:flex-row sm:flex-wrap sm:items-center">
              <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground sm:mr-auto sm:flex-1">
                <ArchiveBoxIcon className="size-4 shrink-0" aria-hidden />
                {t("reassurance")}
              </p>
              <div className="flex flex-col-reverse gap-2 sm:flex-row">
                <Button
                  variant="ghost"
                  onClick={() => handleOpenChange(false)}
                  disabled={pending}
                >
                  {tc("cancel")}
                </Button>
                <Button
                  variant="outline"
                  onClick={openAct}
                  disabled={pending || isError}
                >
                  <PrinterIcon />
                  {t("printAct")}
                </Button>
                <Button
                  variant="destructive"
                  onClick={confirm}
                  disabled={pending}
                >
                  {offboard.isPending ? (
                    <ArrowPathIcon className="animate-spin" />
                  ) : null}
                  {t("confirm", { name: user.firstName })}
                </Button>
              </div>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
