import type { AccessRequest, CreateAccessRequest, Permission } from "@lazyit/shared";
import { ApiError } from "@/lib/api/client";

// Filing for someone else (#1645) needs the verb that decides requests; the API answers 403 without it.
export const ON_BEHALF_PERMISSION: Permission = "accessGrant:grant";

export function canFileOnBehalf(can: (permission: Permission) => boolean): boolean {
  return can(ON_BEHALF_PERMISSION);
}

export interface AccessRequestFormInput {
  applicationId: string;
  accessLevel?: string;
  justification?: string;
  requesterId?: string;
}

// A request for yourself omits requesterId, so it stays a plain self-service request.
export function buildAccessRequestPayload(
  values: AccessRequestFormInput,
  callerId: string | undefined,
): CreateAccessRequest {
  const level = values.accessLevel?.trim();
  const justification = values.justification?.trim();
  const requesterId = values.requesterId?.trim();
  return {
    applicationId: values.applicationId,
    ...(requesterId && requesterId !== callerId ? { requesterId } : {}),
    ...(level ? { accessLevel: level } : {}),
    ...(justification ? { justification } : {}),
  };
}

export type AccessRequestErrorKind = "onBehalfForbidden" | "targetUnavailable" | "alreadyPending";

export function accessRequestErrorKind(error: unknown): AccessRequestErrorKind | null {
  if (!(error instanceof ApiError)) return null;
  const code = (error.body as { code?: unknown } | undefined)?.code;
  if (error.status === 403 && code === "ACCESS_REQUEST_ON_BEHALF_FORBIDDEN") {
    return "onBehalfForbidden";
  }
  if (error.status === 400 && code === "ACCESS_REQUEST_TARGET_UNAVAILABLE") {
    return "targetUnavailable";
  }
  if (error.status === 409) return "alreadyPending";
  return null;
}

export function filedByOther(
  request: Pick<AccessRequest, "requesterId" | "filedById">,
): string | null {
  return request.filedById && request.filedById !== request.requesterId ? request.filedById : null;
}
