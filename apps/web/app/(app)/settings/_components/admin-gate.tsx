"use client";

import { LockClosedIcon } from "@heroicons/react/24/outline";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { usePermissions } from "@/lib/hooks/use-permissions";

/**
 * Client-side ADMIN gate for the whole Settings area. This is a UI affordance only — the API's
 * RolesGuard is the real boundary (every config / taxonomy write is ADMIN-gated server-side), so a
 * non-admin who reaches a route directly still gets 403s on any write. The gate just avoids showing
 * an admin surface to someone who can't use it.
 *
 * Three states, all fail-closed:
 *   - loading (`/users/me` in flight) → a neutral skeleton, so we never flash the admin UI;
 *   - non-admin → an explicit "Admins only" empty-state;
 *   - admin → the children.
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const { isAdmin, isLoading } = usePermissions();

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

  if (!isAdmin) {
    return (
      <div
        className="flex flex-col items-center justify-center gap-4 rounded-lg border border-dashed py-16 text-center"
        aria-live="polite"
      >
        <div className="flex size-12 items-center justify-center rounded-full bg-muted">
          <LockClosedIcon className="size-6 text-muted-foreground" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-medium">Admins only</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Settings — instance configuration, taxonomy management and the role
            overview — is available to administrators. Ask an admin if you need
            a change here.
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
