import type { NotificationType } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for the caller's OWN account preferences (issue #879). Self-scope only — every endpoint
 * here acts on the authenticated caller (no id in the path), so any signed-in human (incl. VIEWER)
 * may reach it; the API enforces "me" server-side.
 *
 * Notification EMAIL preferences (issue #879, PR #1022): a per-user, per-type EMAIL opt-OUT. The bell
 * (in-app) is unaffected — this only governs whether lazyit *emails* the caller about a given type.
 *
 * Backend contract:
 *   - `GET /account/notification-preferences` → `{ emailableTypes, optedOutTypes }`
 *   - `PUT /account/notification-preferences` body `{ optedOutTypes }` → the same shape.
 *
 * `emailableTypes` is the SERVER-DRIVEN set of types that can email at all (SMTP + trigger dependent);
 * render one row per emailable type and never hardcode the list. Semantics are opt-OUT: a type present
 * in `optedOutTypes` means the caller does NOT receive email for it. The PUT is a full, idempotent
 * REPLACEMENT of `optedOutTypes`.
 */

const BASE = "/account/notification-preferences";

/** The caller's notification-email preferences (both sets are `NotificationType[]`). */
export interface NotificationPreferences {
  /** Types that can email at all, server-driven — render one toggle per entry. */
  emailableTypes: NotificationType[];
  /** Types the caller has opted OUT of by email (a subset of `emailableTypes`). */
  optedOutTypes: NotificationType[];
}

/** Read the caller's notification-email preferences (`GET /account/notification-preferences`). */
export function getNotificationPreferences(): Promise<NotificationPreferences> {
  return apiFetch<NotificationPreferences>(BASE);
}

/**
 * Replace the caller's opted-out set (`PUT /account/notification-preferences`). Idempotent full
 * replacement — pass the COMPLETE desired `optedOutTypes`, not a delta. Returns the fresh shape.
 */
export function putNotificationPreferences(
  optedOutTypes: NotificationType[],
): Promise<NotificationPreferences> {
  return apiFetch<NotificationPreferences>(BASE, {
    method: "PUT",
    body: { optedOutTypes },
  });
}
