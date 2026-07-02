"use client";

import { LockClosedIcon } from "@heroicons/react/24/outline";
import type { Permission } from "@lazyit/shared";
import { useTranslations } from "next-intl";
import Link from "next/link";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { useMyPermissions } from "@/lib/hooks/use-permissions";

/**
 * Render `children` only when the caller holds `permission` (RBAC v2, ADR-0046). A UI affordance only —
 * the API's `@RequirePermission` guard is always the real gate — but it stops showing a surface to
 * someone who would only get 403s. Fails CLOSED in all three states: loading (`/config/my-permissions`
 * in flight) renders a neutral skeleton so we never flash the gated UI; lacking the permission renders
 * an explicit locked empty-state (callers pass localized `title`/`description`, so the component stays
 * namespace-agnostic for that copy) plus a link to the Manual's roles/permissions page (#953, `shared`
 * namespace — same precedent as `ErrorState`'s forbidden branch); holding it renders the children.
 */
export function PermissionGate({
  permission,
  title,
  description,
  children,
  loadingFallback,
}: {
  permission: Permission;
  /** Localized heading for the locked state. */
  title: string;
  /** Localized body for the locked state. */
  description: string;
  children: ReactNode;
  /** Optional custom loading placeholder (defaults to a card-height skeleton). */
  loadingFallback?: ReactNode;
}) {
  const { can, isLoading } = useMyPermissions();
  const t = useTranslations("shared");

  if (isLoading) {
    return (
      loadingFallback ?? <Skeleton className="h-40 w-full rounded-xl" />
    );
  }

  if (!can(permission)) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-16 text-center"
        aria-live="polite"
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <LockClosedIcon className="size-6 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">{title}</p>
          <p className="max-w-sm text-sm text-muted-foreground">{description}</p>
        </div>
        {/* #953: deep-link the Manual's roles/permissions page instead of dead-ending here — every
            caller of this component hits the same "ask an administrator" wall, so one internal link
            (like the copy above, this stays namespace-agnostic for callers) fixes it everywhere. */}
        <Link
          href="/help/permissions"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm font-medium text-primary underline-offset-4 hover:underline"
        >
          {t("errors.manualLink")}
        </Link>
      </div>
    );
  }

  return <>{children}</>;
}
