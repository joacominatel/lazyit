import type {
  DismissNotificationsResult,
  MarkNotificationGroupRead,
  MarkReadResult,
  Notification,
  NotificationGroupPage,
  NotificationType,
  Page,
  UnreadCount,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for the in-app notification bell (ADR-0056) — POLL delivery in v1. Every endpoint is
 * gated server-side by `notification:read` (seeded ADMIN-only). The notification `title`/`summary` and
 * any `metadata` are server-built + REDACTED (INV-6); the UI renders them as escaped text only.
 *
 * Backend contract (ADR-0056 §2): the bell reads the grouped feed (`GET /notifications/groups`, the
 * 2026-10-17 amendment, #1649); `GET /notifications/unread-count` → `{ unread }`;
 * `PATCH /notifications/:id/read` and `PATCH /notifications/read-all` → `{ marked, unread }`;
 * `PATCH /notifications/:id/dismiss` and `PATCH /notifications/dismiss-all?upTo=` → `{ dismissed, unread }`
 * (ADR-0056 §7 amendment, #1309 — per-user, hides the row from the caller's bell only).
 *
 * SSE is a Phase-2 upgrade behind these SAME endpoints — these functions do not change when it lands.
 */

const BASE = "/notifications";

export interface PageWindow {
  limit?: number;
  offset?: number;
}

function withWindow(qs: URLSearchParams, { limit, offset }: PageWindow) {
  if (limit !== undefined) qs.set("limit", String(limit));
  if (offset !== undefined) qs.set("offset", String(offset));
  return qs.toString();
}

// `tz` decides each group's day window, so all three group calls must send the same one (#1649).
export function getNotificationGroups(
  tz: string,
  window: PageWindow = {},
): Promise<NotificationGroupPage> {
  const q = withWindow(new URLSearchParams({ tz }), window);
  return apiFetch<NotificationGroupPage>(`${BASE}/groups?${q}`);
}

export function getNotificationGroupItems(
  group: { type: NotificationType; day: string },
  tz: string,
  window: PageWindow = {},
): Promise<Page<Notification>> {
  const q = withWindow(
    new URLSearchParams({ type: group.type, day: group.day, tz }),
    window,
  );
  return apiFetch<Page<Notification>>(`${BASE}/groups/items?${q}`);
}

export function markNotificationGroupRead(
  body: MarkNotificationGroupRead,
): Promise<MarkReadResult> {
  return apiFetch<MarkReadResult>(`${BASE}/read-group`, {
    method: "PATCH",
    body,
  });
}

/** The caller's unread count — the bell badge (`GET /notifications/unread-count`). */
export function getUnreadCount(): Promise<UnreadCount> {
  return apiFetch<UnreadCount>(`${BASE}/unread-count`);
}

/** Mark one notification read for the caller (`PATCH /notifications/:id/read`). Idempotent. */
export function markNotificationRead(id: string): Promise<MarkReadResult> {
  return apiFetch<MarkReadResult>(`${BASE}/${id}/read`, { method: "PATCH" });
}

/** Mark all of the caller's unread notifications read (`PATCH /notifications/read-all`). */
export function markAllNotificationsRead(): Promise<MarkReadResult> {
  return apiFetch<MarkReadResult>(`${BASE}/read-all`, { method: "PATCH" });
}

/**
 * Dismiss one notification from the caller's own bell (`PATCH /notifications/:id/dismiss`). Per user —
 * the shared event is never deleted. Implies read. Idempotent: a re-dismiss, or an id the caller cannot
 * see, answers `{ dismissed: 0 }` rather than a 404.
 */
export function dismissNotification(
  id: string,
): Promise<DismissNotificationsResult> {
  return apiFetch<DismissNotificationsResult>(`${BASE}/${id}/dismiss`, {
    method: "PATCH",
  });
}

/**
 * Dismiss the caller's visible notifications (`PATCH /notifications/dismiss-all`). `upTo` (an ISO
 * datetime — the newest `createdAt` the bell rendered) limits it to notifications created at or before
 * it, so one that arrived after the bell loaded stays. Without it the server dismisses everything visible.
 */
export function dismissAllNotifications(
  upTo?: string,
): Promise<DismissNotificationsResult> {
  const q = upTo === undefined ? "" : `?${new URLSearchParams({ upTo })}`;
  return apiFetch<DismissNotificationsResult>(`${BASE}/dismiss-all${q}`, {
    method: "PATCH",
  });
}
