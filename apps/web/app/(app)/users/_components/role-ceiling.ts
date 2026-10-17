import { canManageRole, type Role, RoleSchema } from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";
import { notifyError } from "@/lib/api/notify-error";

// Mirrors the API's SEC-088 ceiling; nothing is offered while the caller's role is unknown.
export function assignableRoles(callerRole: Role | undefined): Role[] {
  if (!callerRole) return [];
  return RoleSchema.options.filter((role) => canManageRole(callerRole, role));
}

export function canManageUser(callerRole: Role | undefined, target: { role: Role }): boolean {
  return callerRole !== undefined && canManageRole(callerRole, target.role);
}

// A promotion cancels the person's pending temporary password and reset links (SEC-088); the PATCH carries no flag.
export function isPromotion(from: Role, to: Role): boolean {
  return canManageRole(to, from) && !canManageRole(from, to);
}

export type UserMutationErrorKind =
  | "roleCeiling"
  | "directoryRoleLocked"
  | "lastAdmin"
  | "profileManagedByDirectory";

export function userMutationErrorKind(error: unknown): UserMutationErrorKind | null {
  if (!(error instanceof ApiError)) return null;
  const code = (error.body as { code?: unknown } | undefined)?.code;
  if (error.status === 403 && code === "ROLE_CEILING_EXCEEDED") return "roleCeiling";
  if (error.status === 422 && code === "DIRECTORY_PERSON_ROLE_LOCKED") return "directoryRoleLocked";
  if (error.status === 409 && code === "LAST_ADMIN_REQUIRED") return "lastAdmin";
  if (error.status === 409 && code === "PROFILE_MANAGED_BY_DIRECTORY") return "profileManagedByDirectory";
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
