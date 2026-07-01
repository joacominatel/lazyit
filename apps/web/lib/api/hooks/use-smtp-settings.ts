import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SendTestEmail, UpdateSmtpSettings } from "@lazyit/shared";
import {
  getSmtpSettings,
  sendTestEmail,
  updateSmtpSettings,
} from "../endpoints/smtp";

/**
 * Query keys for the singleton instance SMTP settings (ADR-0079, #615). Like `assetTagSchemeKeys`, this
 * is ONE config row (no list / detail) — a single `single()` key is the whole resource; `all` is the
 * invalidation prefix the PUT mutation refetches. Namespaced under `config` for symmetry with the rest
 * of the `/config` surface.
 */
export const smtpKeys = {
  all: ["config", "smtp"] as const,
  single: () => [...["config", "smtp"], "single"] as const,
};

/**
 * Read the instance SMTP settings (`GET /config/smtp`, `settings:manage`). Drives the Settings →
 * Instance → SMTP editor: seeds the form and the redacted "password configured" state. The API never
 * 404s for "unset" — it returns an explicit `enabled: false` default — so `data` is a concrete shape
 * whenever the query resolves. `staleTime` is short so a freshly-saved config is reflected without a
 * hard reload; the API's guard is the real gate, so a stale read never authorizes anything.
 */
export function useSmtpSettings() {
  return useQuery({
    queryKey: smtpKeys.single(),
    queryFn: ({ signal }) => getSmtpSettings(signal),
    staleTime: 30 * 1000,
  });
}

/**
 * Upsert the SMTP settings (`PUT /config/smtp`, `settings:manage`). On success it invalidates the SMTP
 * query so the editor re-seeds from the persisted truth (the recomputed `passwordSet`, the trimmed
 * fields). Toasts / validation-state are owned by the calling editor (a 409 surfaces via `notifyError`).
 */
export function useUpdateSmtpSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateSmtpSettings) => updateSmtpSettings(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: smtpKeys.all });
    },
  });
}

/**
 * Send a one-off test email (`POST /config/smtp/test`, `settings:manage`). No cache to invalidate — the
 * test reads the saved config and writes nothing. Always resolves HTTP 200; the editor inspects the
 * `{ ok, error }` result to toast success/failure.
 */
export function useSendTestEmail() {
  return useMutation({
    mutationFn: (body: SendTestEmail) => sendTestEmail(body),
  });
}
