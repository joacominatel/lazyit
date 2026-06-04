"use client";

import { LockClosedIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useMyPermissions } from "@/lib/hooks/use-permissions";

/**
 * Client-side gate for the whole Settings area, aligned to `settings:manage` (RBAC v2, ADR-0046)
 * rather than the raw ADMIN role — so a non-ADMIN to whom `settings:manage` was delegated can reach
 * it, consistent with the fully-configurable model. This is a UI affordance only — the API's
 * permission guard is the real boundary (every config / taxonomy write is gated server-side), so a
 * caller who reaches a route directly still gets 403s on any write they can't perform. The gate just
 * avoids showing the admin surface to someone who can't use it.
 *
 * Three states, all fail-closed:
 *   - loading (`/config/my-permissions` in flight) → a neutral skeleton, so we never flash the UI;
 *   - lacks `settings:manage` → an explicit "Admins only" empty-state;
 *   - holds `settings:manage` → the children.
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const t = useTranslations("settings");
  const { can, isLoading } = useMyPermissions();
  const canManageSettings = can("settings:manage");

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="space-y-2">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  if (!canManageSettings) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-16 text-center"
        aria-live="polite"
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <LockClosedIcon className="size-6 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">{t("gate.title")}</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {t("gate.description")}
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
