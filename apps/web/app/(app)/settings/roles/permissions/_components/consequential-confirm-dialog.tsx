"use client";

import {
  ArrowPathIcon,
  ExclamationTriangleIcon,
  EyeSlashIcon,
} from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import type { SaveDiff } from "./permissions-form";

interface ConsequentialConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The save diff to explain (removed reads + above-tier grants). */
  diff: SaveDiff;
  /** Confirms the save; resolves on success, rejects on error. The dialog owns the spinner; the
   * caller owns the toast + closing on success. */
  onConfirm: () => Promise<unknown>;
  /** True while the save mutation is in flight. */
  isPending: boolean;
}

/**
 * A NEUTRAL-tone confirmation for a consequential permission change (sibling of DeleteConfirmDialog).
 * Unlike a delete confirm it is not destructive-red: it names the human consequence of the save —
 * "Viewers will no longer be able to read the Knowledge Base" / "Members will be able to grant access
 * to anyone" — so an admin confirms an outcome, not a checkbox diff. Only shown when the save is
 * actually consequential (a removed read or an above-default-tier grant); trivial saves skip it.
 *
 * Per the CEO design, above-tier grants are ALLOWED (no client block) — this dialog warns strongly but
 * the confirm button proceeds. The backend has no block either; granting a coarse verb to a non-admin
 * is an accepted, admin-initiated delegation.
 */
export function ConsequentialConfirmDialog({
  open,
  onOpenChange,
  diff,
  onConfirm,
  isPending,
}: ConsequentialConfirmDialogProps) {
  const t = useTranslations("settings");
  const hasGrants = diff.aboveTierGrants.length > 0;
  const hasRemovals = diff.removedReads.length > 0;

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("roles.permissions.confirm.title")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("roles.permissions.confirm.description")}
          </AlertDialogDescription>
        </AlertDialogHeader>

        <div className="space-y-4">
          {hasGrants && (
            <section className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-sm font-medium">
                <ExclamationTriangleIcon
                  className="size-4 text-warning"
                  aria-hidden
                />
                {t("roles.permissions.confirm.grantsHeading")}
              </h3>
              <Callout tone="warning">
                <div className="space-y-1.5">
                  {diff.aboveTierGrants.map((c) => (
                    <p key={c.permission} className="text-sm">
                      {c.message}
                    </p>
                  ))}
                </div>
              </Callout>
            </section>
          )}

          {hasRemovals && (
            <section className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                <EyeSlashIcon className="size-4" />
                {t("roles.permissions.confirm.removalsHeading")}
              </h3>
              <ul className="space-y-1.5 rounded-md border bg-muted/40 p-3">
                {diff.removedReads.map((c) => (
                  <li
                    key={c.permission}
                    className="text-sm text-foreground/90"
                  >
                    {c.message}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>
            {t("roles.permissions.confirm.keepEditing")}
          </AlertDialogCancel>
          {/* Plain (non-destructive) button: this is a deliberate, allowed change — we warn, never
              block. We control the spinner and only close on success (the caller does that). */}
          <Button onClick={() => void onConfirm()} disabled={isPending}>
            {isPending && <ArrowPathIcon className="animate-spin" />}
            {t("roles.permissions.confirm.saveChanges")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
