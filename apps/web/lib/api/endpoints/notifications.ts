import type {
  MarkReadResult,
  Notification,
  Page,
  UnreadCount,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for the in-app notification bell (ADR-0056) — POLL delivery in v1. Every endpoint is
 * gated server-side by `notification:read` (seeded ADMIN-only). The notification `title`/`summary` and
 * any `metadata` are server-built + REDACTED (INV-6); the UI renders them as escaped text only.
 *
 * Backend contract (ADR-0056 §2): `GET /notifications?limit=&offset=` → `Page<Notification>` (each item
 * carrying its per-caller `read` flag); `GET /notifications/unread-count` → `{ unread }`;
 * `PATCH /notifications/:id/read` and `PATCH /notifications/read-all` → `{ marked, unread }`.
 *
 * SSE is a Phase-2 upgrade behind these SAME endpoints — these functions do not change when it lands.
 */

const BASE = "/notifications";

export interface NotificationListParams {
  /** Page size (ADR-0030; 1-200). */
  limit?: number;
  /** Zero-based window offset (ADR-0030). */
  offset?: number;
}

/** List the caller's notifications (newest-first, paged). Returns the `Page<Notification>` envelope. */
export function getNotifications(
  params: NotificationListParams = {},
): Promise<Page<Notification>> {
  const qs = new URLSearchParams();
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  const q = qs.toString();
  return apiFetch<Page<Notification>>(q ? `${BASE}?${q}` : BASE);
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
