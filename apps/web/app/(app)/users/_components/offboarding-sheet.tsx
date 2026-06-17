"use client";

import {
  ArrowPathIcon,
  ComputerDesktopIcon,
  KeyIcon,
  PrinterIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/ui/status-badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { UserAvatar } from "@/components/user-avatar";
import { useOffboardUser } from "@/lib/api/hooks/use-user-mutations";
import { notifyError } from "@/lib/api/notify-error";
import { useFormatters } from "@/lib/hooks/use-formatters";
import { useLocalStorage } from "@/lib/hooks/use-local-storage";
import {
  DEFAULT_OFFBOARDING_MESSAGE,
  DEFAULT_ORG_NAME,
  DEFAULT_SHOW_ACCESS,
  DEFAULT_SHOW_ASSETS,
  OFFBOARDING_MESSAGE_KEY,
  ORG_NAME_KEY,
  SHOW_ACCESS_KEY,
  SHOW_ASSETS_KEY,
} from "@/lib/offboarding/constants";
import {
  type OffboardAssetRow,
  type OffboardGrantRow,
  useOffboardingData,
} from "@/lib/offboarding/use-offboarding-data";
import { cn } from "@/lib/utils";

/**
 * OffboardingSheet — Wave 3b (issue #172, ADR-0049 «Activated Restraint»). Replaces the plain delete
 * alert at the user detail call-site with a dignified offboarding flow: it shows, honestly, exactly
 * which assets get reclaimed and which access gets revoked, lets the operator print a signable Return
 * Act, and confirms the soft delete with a sober, respectful "done" — never whimsy on a destructive
 * action.
 *
 * Design rules honored: pillar hue lives only in tinted icon chips (assets teal = `pillar-inventory`,
 * access indigo = `pillar-access`); impact counts are foreground text with `tabular-nums`; the
 * success check uses the reserved `--ease-spring` via `animate-check-draw`; all motion is CSS and
 * reduced-motion-safe. The data is resolved client-side and shared with the printable act, so the two
 * never disagree.
 */

interface OffboardingSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  user: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
}

/** A pillar-tinted icon chip — decorative ≥24px glyph, so pillar hue is AA-safe here. */
function PillarChip({
  pillar,
  children,
}: {
  pillar: "inventory" | "access";
  children: React.ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg",
        pillar === "inventory"
          ? "bg-pillar-inventory/10 text-pillar-inventory"
          : "bg-pillar-access/10 text-pillar-access",
      )}
    >
      {children}
    </span>
  );
}

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
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <PillarChip pillar="inventory">
        <ComputerDesktopIcon className="size-5" />
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

/** One access row in the "to revoke" list. */
function GrantLine({ grant }: { grant: OffboardGrantRow }) {
  const t = useTranslations("users.offboarding");
  const { date } = useFormatters();
  const title =
    grant.appName ??
    (grant.resolved ? t("applicationFallback") : grant.applicationId);
  return (
    <li className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
      <PillarChip pillar="access">
        <KeyIcon className="size-5" />
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

/** Skeleton rows while the catalog resolves — keeps the sheet from flashing empty. */
function ListSkeleton() {
  return (
    <ul className="divide-y">
      {[0, 1].map((i) => (
        <li key={i} className="flex items-center gap-3 py-3 first:pt-0">
          <Skeleton className="size-9 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-3/5" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The sober success confirmation — a drawn check, no confetti. Respectful, not whimsical. */
function DoneState({ name }: { name: string }) {
  const t = useTranslations("users.offboarding");
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-success/10 text-success">
        <svg
          viewBox="0 0 24 24"
          className="size-8"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path className="animate-check-draw" d="M5 13l4 4L19 7" />
        </svg>
      </span>
      <div className="space-y-1">
        <p className="font-heading text-base font-medium text-foreground">
          {t("doneTitle", { name })}
        </p>
        <p className="mx-auto max-w-xs text-sm text-muted-foreground">
          {t("doneSubtitle")}
        </p>
      </div>
    </div>
  );
}

export function OffboardingSheet({
  open,
  onOpenChange,
  user,
}: OffboardingSheetProps) {
  const t = useTranslations("users.offboarding");
  const tc = useTranslations("common");
  const router = useRouter();
  const offboard = useOffboardUser();
  const { assets, grants, isLoading, isError, isEmpty, refetch } =
    useOffboardingData(user.id, open);
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
  const [done, setDone] = useState(false);

  const fullName = `${user.firstName} ${user.lastName}`;

  function openAct() {
    window.open(
      `/users/${user.id}/offboarding/act`,
      "_blank",
      "noopener,noreferrer",
    );
  }

  async function confirm() {
    try {
      await offboard.mutateAsync(user.id);
      toast.success(t("toast.archived"));
      // Hold the sheet open briefly to show the sober "done" before navigating away.
      setDone(true);
      window.setTimeout(() => {
        onOpenChange(false);
        router.push("/users");
      }, 1100);
    } catch (error) {
      notifyError(error, t("toast.error"));
    }
  }

  // Reset the local "done" flag whenever the sheet is re-opened for a fresh run.
  function handleOpenChange(next: boolean) {
    if (!next) setDone(false);
    onOpenChange(next);
  }

  const pending = offboard.isPending || done;

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent side="right" className="sm:max-w-md">
        {done ? (
          <DoneState name={fullName} />
        ) : (
          <>
            <SheetHeader className="gap-3">
              <div className="flex items-center gap-3">
                <UserAvatar
                  size="lg"
                  firstName={user.firstName}
                  lastName={user.lastName}
                  email={user.email}
                />
                <div className="min-w-0">
                  <SheetTitle className="truncate">
                    {t("title", { name: fullName })}
                  </SheetTitle>
                  <SheetDescription className="truncate">
                    {user.email}
                  </SheetDescription>
                </div>
              </div>
              {/* Impact strip — honest counts in foreground tabular-nums; colour rides the chips. */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-muted/60 px-3 py-2 text-sm text-foreground">
                {isLoading ? (
                  <Skeleton className="h-4 w-56" />
                ) : isError ? (
                  <span className="text-muted-foreground">
                    {t("loadError.impact")}
                  </span>
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-pillar-inventory" aria-hidden />
                      {t("impact.releasesLabel")}{" "}
                      <span className="font-medium tabular-nums">{assets.length}</span>{" "}
                      {t("impact.assets", { count: assets.length })}
                    </span>
                    <span className="text-muted-foreground" aria-hidden>
                      ·
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-pillar-access" aria-hidden />
                      {t("impact.revokesLabel")}{" "}
                      <span className="font-medium tabular-nums">{grants.length}</span>{" "}
                      {t("impact.grants", { count: grants.length })}
                    </span>
                  </>
                )}
              </div>
            </SheetHeader>

            <div className="flex-1 space-y-6 px-4">
              {/* A failed read silently collapses the lists to empty, so we refuse to show the
                  asset/access sections (or the "nothing to return" empty state) on error — that
                  would under-report on an offboarding artifact. Surface the failure + a retry
                  instead, and the act stays disabled below. See issue #601. */}
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
                <>
                  {/* Assets to return */}
                  <section className="space-y-2">
                    <h3 className="text-label uppercase text-muted-foreground">
                      {t("assetsToReturn")}
                    </h3>
                    {isLoading ? (
                      <ListSkeleton />
                    ) : assets.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t("nothingToReturn")}
                      </p>
                    ) : (
                      <ul className="divide-y">
                        {assets.map((asset) => (
                          <AssetLine key={asset.assignmentId} asset={asset} />
                        ))}
                      </ul>
                    )}
                  </section>

                  {/* Access to revoke */}
                  <section className="space-y-2">
                    <h3 className="text-label uppercase text-muted-foreground">
                      {t("accessToRevoke")}
                    </h3>
                    {isLoading ? (
                      <ListSkeleton />
                    ) : grants.length === 0 ? (
                      <p className="text-sm text-muted-foreground">
                        {t("noActiveAccess")}
                      </p>
                    ) : (
                      <ul className="divide-y">
                        {grants.map((grant) => (
                          <GrantLine key={grant.grantId} grant={grant} />
                        ))}
                      </ul>
                    )}
                  </section>

                  {isEmpty ? (
                    <p className="text-sm text-muted-foreground">
                      {t("emptyNote")}
                    </p>
                  ) : null}
                </>
              )}

              {/* Editable handover message — persisted as a reusable template. */}
              <section className="space-y-2">
                <label
                  htmlFor="offboarding-message"
                  className="text-label uppercase text-muted-foreground"
                >
                  {t("handoverNote")}
                </label>
                <Textarea
                  id="offboarding-message"
                  value={mounted ? message : DEFAULT_OFFBOARDING_MESSAGE}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  className="text-sm"
                  placeholder={t("handoverPlaceholder")}
                />
                <p className="text-xs text-muted-foreground">
                  {t("handoverHelp")}
                </p>
              </section>

              {/* What the printed act includes — letterhead + per-section toggles (localStorage v1). */}
              <section className="space-y-3">
                <h3 className="text-label uppercase text-muted-foreground">
                  {t("printedAct")}
                </h3>
                <div className="space-y-1.5">
                  <Label htmlFor="offboarding-org">{t("companyName")}</Label>
                  <Input
                    id="offboarding-org"
                    value={orgMounted ? orgName : DEFAULT_ORG_NAME}
                    onChange={(e) => setOrgName(e.target.value)}
                    placeholder={t("companyPlaceholder")}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Label
                    htmlFor="offboarding-show-assets"
                    className="font-normal text-foreground"
                  >
                    {t("listAssets")}
                  </Label>
                  <Switch
                    id="offboarding-show-assets"
                    checked={showAssets}
                    onCheckedChange={setShowAssets}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Label
                    htmlFor="offboarding-show-access"
                    className="font-normal text-foreground"
                  >
                    {t("listAccess")}
                  </Label>
                  <Switch
                    id="offboarding-show-access"
                    checked={showAccess}
                    onCheckedChange={setShowAccess}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("printedActHelp")}
                </p>
              </section>

              {/* Signature placeholders — the real signatures happen on the printed act. */}
              <section className="space-y-2">
                <h3 className="text-label uppercase text-muted-foreground">
                  {t("signatures")}
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  {(["signatureEmployee", "signatureIt"] as const).map((key) => (
                    <div
                      key={key}
                      className="rounded-lg border border-dashed border-border px-3 py-4"
                    >
                      <div className="h-6 border-b border-border" />
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        {t(key)}
                      </p>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("signatureHelp")}
                </p>
              </section>
            </div>

            <SheetFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
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
                {t("confirm")}
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
