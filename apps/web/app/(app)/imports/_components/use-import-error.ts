"use client";

import { useTranslations } from "next-intl";
import { useCallback } from "react";
import { ApiError } from "@/lib/api/client";
import { notifyError } from "@/lib/api/notify-error";

/**
 * Map a thrown error to a localized message for the import wizard. The `/imports/*` surface returns a
 * small, fixed set of failure statuses (ADR-0069 §11 + the controller): 403 (no permission), 404
 * (unknown/expired session), 409 (wrong step), 413 (file too large), and generic 4xx (bad file /
 * mapping). We never leave a dead-end — every step routes its failure through here to a clear toast
 * and, where useful, an inline message keyed to the step (`fallbackKey`).
 *
 * Returns BOTH a `resolve` that yields the localized string (for inline rendering) and a `notify`
 * that toasts it through the shared `notifyError` (so the API's request id stays copyable).
 */
export function useImportError() {
  const t = useTranslations("imports.errors");

  const resolve = useCallback(
    (error: unknown, fallbackKey: Parameters<typeof t>[0]): string => {
      if (error instanceof ApiError) {
        switch (error.status) {
          case 403:
            return t("forbidden");
          case 404:
            return t("notFound");
          case 409:
            return t("conflict");
          case 413:
            return t("tooLarge");
          default:
            break;
        }
      }
      return t(fallbackKey);
    },
    [t],
  );

  const notify = useCallback(
    (error: unknown, fallbackKey: Parameters<typeof t>[0]): void => {
      // Wrap the resolved (status-aware) message so notifyError shows it verbatim while still
      // surfacing the ApiError's copyable request id when present.
      const message = resolve(error, fallbackKey);
      notifyError(
        error instanceof ApiError ? new ApiError(error.status, message, error.body, error.requestId) : new Error(message),
        message,
      );
    },
    [resolve],
  );

  return { resolve, notify };
}
