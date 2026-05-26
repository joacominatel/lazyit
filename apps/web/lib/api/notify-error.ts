import { toast } from "sonner";
import { ApiError } from "./client";

/** Human message from an unknown thrown value, falling back to `fallback`. */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Show an error toast for a failed request. When the error is an {@link ApiError} carrying a
 * request id (the API's `X-Request-Id` — ADR-0031), it is rendered as a copyable detail so a user
 * can quote it when reporting the failure. The single error-toast entry point across the app:
 * prefer this over `toast.error(...)` in mutation/action `onError` handlers.
 */
export function notifyError(error: unknown, fallback: string): void {
  const message = messageOf(error, fallback);
  const requestId = error instanceof ApiError ? error.requestId : undefined;

  toast.error(message, {
    description: requestId ? `Request ID: ${requestId}` : undefined,
    action: requestId
      ? {
          label: "Copy ID",
          onClick: () => {
            void navigator.clipboard?.writeText(requestId);
          },
        }
      : undefined,
  });
}
