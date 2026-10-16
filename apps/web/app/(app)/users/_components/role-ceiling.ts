import { canManageRole, type Role } from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";
import { notifyError } from "@/lib/api/notify-error";

export const ROLE_VALUES: Role[] = ["ADMIN", "MEMBER", "VIEWER"];

// Mirrors the API's SEC-088 ceiling; nothing is offered while the caller's role is unknown.
export function assignableRoles(callerRole: Role | undefined): Role[] {
  if (!callerRole) return [];
  return ROLE_VALUES.filter((role) => canManageRole(callerRole, role));
}

export function canManageUser(callerRole: Role | undefined, target: { role: Role }): boolean {
  return callerRole !== undefined && canManageRole(callerRole, target.role);
}

export type UserMutationErrorKind = "roleCeiling" | "directoryRoleLocked" | "lastAdmin";

export function userMutationErrorKind(error: unknown): UserMutationErrorKind | null {
  if (!(error instanceof ApiError)) return null;
  const code = (error.body as { code?: unknown } | undefined)?.code;
  if (error.status === 403 && code === "ROLE_CEILING_EXCEEDED") return "roleCeiling";
  if (error.status === 422 && code === "DIRECTORY_PERSON_ROLE_LOCKED") return "directoryRoleLocked";
  // The last-admin 409 carries no code, so it is matched by its wording (AUD-040).
  if (error.status === 409 && /last administrator/i.test(error.message)) return "lastAdmin";
  return null;
}

/** `t` is the `users` namespace; unknown failures fall back to the server's message via notifyError. */
export function notifyUserError(
  error: unknown,
  fallback: string,
  t: (key: `errors.${UserMutationErrorKind}`) => string,
): void {
  const kind = userMutationErrorKind(error);
  if (kind && error instanceof ApiError) {
    // Same toast, localized, still carrying the request id.
    notifyError(new ApiError(error.status, t(`errors.${kind}`), error.body, error.requestId), fallback);
  } else {
    notifyError(error, fallback);
  }
}
