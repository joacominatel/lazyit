"use client";

import { LockClosedIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import type { OffboardResult } from "@/lib/api/endpoints/users";
import { cn } from "@/lib/utils";
import { PillarChip, RowsCard } from "./offboarding-lists";

/**
 * The sober success confirmation — a drawn check, no confetti. Respectful, not whimsical. When the
 * departing person held Secret-vault memberships, it also surfaces a rotation prompt (issue #869):
 * those vaults were revoked, but their secrets could have been read and must be rotated BY HAND —
 * lazyit is zero-knowledge (INV-10) and cannot re-encrypt them. Display-only; nothing to rotate → the
 * check stays centered and the sheet auto-closes as before. Restyled for the wide sheet (#1532): the
 * content keeps a readable measure in the middle of the panel; behaviour is unchanged.
 */
export function OffboardingDoneState({
  name,
  rotationVaults,
  onClose,
}: {
  name: string;
  rotationVaults: OffboardResult["rotationVaults"];
  onClose: () => void;
}) {
  const t = useTranslations("users.offboarding");
  const tc = useTranslations("common");
  const hasRotation = rotationVaults.length > 0;
  return (
    <div
      className={cn(
        "mx-auto flex w-full max-w-md flex-1 flex-col px-6",
        hasRotation
          ? "gap-6 py-10"
          : "items-center justify-center gap-4 py-12 text-center",
      )}
    >
      <div className="flex flex-col items-center gap-4 text-center">
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

      {hasRotation ? (
        <section className="space-y-3 text-left">
          <h3 className="text-sm font-medium text-foreground">
            {t("secretsToRotate")}
          </h3>
          <RowsCard>
            <ul className="divide-y">
              {rotationVaults.map((vault) => (
                <li
                  key={vault.vaultId}
                  className="flex items-center gap-3 px-3 py-2.5"
                >
                  <PillarChip pillar="knowledge">
                    <LockClosedIcon />
                  </PillarChip>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-foreground">
                      {vault.name}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground tabular-nums">
                      {t("vaultItems", { count: vault.itemCount })}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          </RowsCard>
          <p className="text-xs text-muted-foreground">{t("rotateHelp")}</p>
          <Button variant="outline" className="w-full" onClick={onClose}>
            {tc("close")}
          </Button>
        </section>
      ) : null}
    </div>
  );
}
