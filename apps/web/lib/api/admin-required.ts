import { ApiError } from "./client";

// SEC-088: editing the permission matrix or the directory connection is ADMIN-only, whatever the matrix delegates.
export function isAdminRequired(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 403) return false;
  return (error.body as { code?: unknown } | undefined)?.code === "ADMIN_REQUIRED";
}
