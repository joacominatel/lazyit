"use client";

import {
  ArrowPathIcon,
  ComputerDesktopIcon,
  KeyIcon,
  PrinterIcon,
} from "@heroicons/react/24/outline";
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
import { formatDate } from "@/lib/utils/format";

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
  const title =
    asset.assetTag ?? asset.name ?? (asset.resolved ? "Asset" : asset.assetId);
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
            Not in the catalog — verify by id {asset.assetId}
          </p>
        )}
      </div>
    </li>
  );
}

/** One access row in the "to revoke" list. */
function GrantLine({ grant }: { grant: OffboardGrantRow }) {
  const title = grant.appName ?? (grant.resolved ? "Application" : grant.applicationId);
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
            <StatusBadge tone="warning">Critical</StatusBadge>
          ) : null}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {grant.expiresAt
            ? `Expires ${formatDate(grant.expiresAt)}`
            : "No expiry"}
          {!grant.resolved ? ` · verify by id ${grant.applicationId}` : ""}
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
          {name} archived
        </p>
        <p className="mx-auto max-w-xs text-sm text-muted-foreground">
          Access revoked, assets released — history is safe.
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
  const router = useRouter();
  const offboard = useOffboardUser();
  const { assets, grants, isLoading, isEmpty } = useOffboardingData(
    user.id,
    open,
  );
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
      toast.success("User archived — access revoked, history is safe.");
      // Hold the sheet open briefly to show the sober "done" before navigating away.
      setDone(true);
      window.setTimeout(() => {
        onOpenChange(false);
        router.push("/users");
      }, 1100);
    } catch (error) {
      notifyError(error, "Couldn't offboard user");
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
                  <SheetTitle className="truncate">Offboard {fullName}</SheetTitle>
                  <SheetDescription className="truncate">
                    {user.email}
                  </SheetDescription>
                </div>
              </div>
              {/* Impact strip — honest counts in foreground tabular-nums; colour rides the chips. */}
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg bg-muted/60 px-3 py-2 text-sm text-foreground">
                {isLoading ? (
                  <Skeleton className="h-4 w-56" />
                ) : (
                  <>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-pillar-inventory" aria-hidden />
                      Releases{" "}
                      <span className="font-medium tabular-nums">{assets.length}</span>{" "}
                      {assets.length === 1 ? "asset" : "assets"}
                    </span>
                    <span className="text-muted-foreground" aria-hidden>
                      ·
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span className="size-2 rounded-full bg-pillar-access" aria-hidden />
                      Revokes{" "}
                      <span className="font-medium tabular-nums">{grants.length}</span>{" "}
                      {grants.length === 1 ? "access grant" : "access grants"}
                    </span>
                  </>
                )}
              </div>
            </SheetHeader>

            <div className="flex-1 space-y-6 px-4">
              {/* Assets to return */}
              <section className="space-y-2">
                <h3 className="text-label uppercase text-muted-foreground">
                  Assets to return
                </h3>
                {isLoading ? (
                  <ListSkeleton />
                ) : assets.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing to return.
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
                  Access to revoke
                </h3>
                {isLoading ? (
                  <ListSkeleton />
                ) : grants.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No active application access.
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
                  This person holds no assets and has no active access. The act is
                  still valid as a record of their departure.
                </p>
              ) : null}

              {/* Editable handover message — persisted as a reusable template. */}
              <section className="space-y-2">
                <label
                  htmlFor="offboarding-message"
                  className="text-label uppercase text-muted-foreground"
                >
                  Handover note
                </label>
                <Textarea
                  id="offboarding-message"
                  value={mounted ? message : DEFAULT_OFFBOARDING_MESSAGE}
                  onChange={(e) => setMessage(e.target.value)}
                  rows={3}
                  className="text-sm"
                  placeholder="A short note printed on the return act…"
                />
                <p className="text-xs text-muted-foreground">
                  Saved for next time — this note pre-fills every act.
                </p>
              </section>

              {/* What the printed act includes — letterhead + per-section toggles (localStorage v1). */}
              <section className="space-y-3">
                <h3 className="text-label uppercase text-muted-foreground">
                  Printed act
                </h3>
                <div className="space-y-1.5">
                  <Label htmlFor="offboarding-org">Company name</Label>
                  <Input
                    id="offboarding-org"
                    value={orgMounted ? orgName : DEFAULT_ORG_NAME}
                    onChange={(e) => setOrgName(e.target.value)}
                    placeholder="Printed on the act letterhead"
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <Label
                    htmlFor="offboarding-show-assets"
                    className="font-normal text-foreground"
                  >
                    List assets to return
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
                    List access revoked
                  </Label>
                  <Switch
                    id="offboarding-show-access"
                    checked={showAccess}
                    onCheckedChange={setShowAccess}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  These apply to the printed act — this summary always shows the full impact.
                </p>
              </section>

              {/* Signature placeholders — the real signatures happen on the printed act. */}
              <section className="space-y-2">
                <h3 className="text-label uppercase text-muted-foreground">
                  Signatures
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  {["Employee", "IT"].map((who) => (
                    <div
                      key={who}
                      className="rounded-lg border border-dashed border-border px-3 py-4"
                    >
                      <div className="h-6 border-b border-border" />
                      <p className="mt-1.5 text-xs text-muted-foreground">{who}</p>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Signed on paper at handover — print the act below.
                </p>
              </section>
            </div>

            <SheetFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button
                variant="ghost"
                onClick={() => handleOpenChange(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                variant="outline"
                onClick={openAct}
                disabled={pending}
              >
                <PrinterIcon />
                Print act
              </Button>
              <Button
                variant="destructive"
                onClick={confirm}
                disabled={pending}
              >
                {offboard.isPending ? (
                  <ArrowPathIcon className="animate-spin" />
                ) : null}
                Confirm offboarding
              </Button>
            </SheetFooter>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
