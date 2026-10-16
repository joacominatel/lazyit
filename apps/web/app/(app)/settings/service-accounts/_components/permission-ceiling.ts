import { type Permission, PERMISSIONS, SERVICE_ACCOUNT_CEILING_EXEMPT_PERMISSIONS } from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";
import { notifyError } from "@/lib/api/notify-error";
import { permissionLabel, type SettingsTranslator } from "../../_lib/permission-labels";

export function withinCeiling(permission: Permission, can: (p: Permission) => boolean): boolean {
  return can(permission) || SERVICE_ACCOUNT_CEILING_EXEMPT_PERMISSIONS.has(permission);
}

/** What the picker lists: verbs the caller may grant, plus those the account already holds so they stay removable. */
export function offeredPermissions(
  candidates: readonly Permission[],
  can: (p: Permission) => boolean,
  held: ReadonlySet<Permission>,
): Permission[] {
  return candidates.filter((p) => withinCeiling(p, can) || held.has(p));
}

/** The verbs a 403 `PERMISSION_CEILING_EXCEEDED` names, or null for any other failure. */
export function ceilingExceededPermissions(error: unknown): string[] | null {
  if (!(error instanceof ApiError) || error.status !== 403) return null;
  const body = error.body as { code?: unknown; permissions?: unknown } | undefined;
  if (body?.code !== "PERMISSION_CEILING_EXCEEDED") return null;
  return Array.isArray(body.permissions)
    ? body.permissions.filter((p): p is string => typeof p === "string")
    : [];
}

const KNOWN = new Set<string>(PERMISSIONS);

/** The localized refusal naming each verb by its label, or null when `error` is not the ceiling 403. */
export function ceilingExceededMessage(error: unknown, t: SettingsTranslator): string | null {
  const exceeded = ceilingExceededPermissions(error);
  if (exceeded === null) return null;
  const permissions = exceeded
    .map((p) => (KNOWN.has(p) ? permissionLabel(t, p as Permission) : p))
    .join(", ");
  return t("serviceAccounts.errors.ceilingExceeded", { permissions });
}

/** `t` is the `settings` namespace; any other failure falls back to the server's message via notifyError. */
export function notifyServiceAccountError(
  error: unknown,
  fallback: string,
  t: SettingsTranslator,
): void {
  const message = ceilingExceededMessage(error, t);
  if (message !== null && error instanceof ApiError) {
    // Same toast, localized, still carrying the request id.
    notifyError(new ApiError(error.status, message, error.body, error.requestId), fallback);
  } else {
    notifyError(error, fallback);
  }
}
