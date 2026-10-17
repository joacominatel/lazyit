import type { UpdateOwnProfile, User } from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";

/**
 * Self-service name edit (issue #1421) — the pure rules behind the `/profile` form.
 */

/**
 * The directory sync owns this person's name (ADR-0091), so `PATCH /users/me` would refuse it with a
 * 409. The form is shown read-only instead. A directory-only person is refused the same way by the API.
 */
export function isNameManagedByDirectory(
  user: Pick<User, "directorySource" | "directoryOnly">,
): boolean {
  return user.directorySource != null || user.directoryOnly === true;
}

/**
 * The `PATCH /users/me` body: only the names that actually changed, trimmed. `null` when nothing
 * changed, so the form does not send a request that would be a no-op.
 */
export function buildOwnProfilePatch(
  current: Pick<User, "firstName" | "lastName">,
  values: { firstName: string; lastName: string },
): UpdateOwnProfile | null {
  const firstName = values.firstName.trim();
  const lastName = values.lastName.trim();
  const patch: { firstName?: string; lastName?: string } = {};
  if (firstName !== current.firstName) patch.firstName = firstName;
  if (lastName !== current.lastName) patch.lastName = lastName;
  return Object.keys(patch).length > 0 ? patch : null;
}

export type OwnProfileErrorKind =
  | "managedByDirectory"
  | "serviceAccount"
  | "invalid"
  | "generic";

/** Which message a failed `PATCH /users/me` shows. */
export function ownProfileErrorKind(error: unknown): OwnProfileErrorKind {
  if (!(error instanceof ApiError)) return "generic";
  const code = (error.body as { code?: unknown } | undefined)?.code;
  if (error.status === 409 && code === "PROFILE_MANAGED_BY_DIRECTORY") {
    return "managedByDirectory";
  }
  if (error.status === 403 && code === "SERVICE_ACCOUNT_NOT_ALLOWED") {
    return "serviceAccount";
  }
  if (error.status === 400) return "invalid";
  return "generic";
}
