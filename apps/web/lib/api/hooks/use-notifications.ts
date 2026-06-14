import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getNotifications,
  getUnreadCount,
  markAllNotificationsRead,
  markNotificationRead,
  type NotificationListParams,
} from "../endpoints/notifications";
import { createQueryKeys } from "../query-keys";

/**
 * Read + action hooks for the in-app notification bell (ADR-0056, amended #453). Until SSE lands (Phase 2,
 * behind the SAME endpoints), the bell is POLLED: the unread count and the dropdown list refetch on an
 * interval so a new nudge surfaces without a manual reload — the same poll-as-floor posture the workflow
 * task inbox takes. The endpoints are open to any authenticated human and scope the feed per caller
 * server-side (own targeted rows always; the broadcast set only with `notification:read`), so these hooks
 * run for every signed-in user — a non-admin sees only their own targeted rows (e.g. the vault-setup nudge).
 */
const baseKeys = createQueryKeys("notifications");
export const notificationKeys = {
  ...baseKeys,
  list: (params: NotificationListParams) =>
    [...baseKeys.all, "list", params] as const,
  unreadCount: () => [...baseKeys.all, "unread-count"] as const,
};

/** Poll cadence (ADR-0056 §2 poll-floor) — 45s, in the 30–60s band the engine inbox uses. */
export const NOTIFICATION_POLL_INTERVAL_MS = 45000;

/** How many notifications the dropdown shows (the most recent page). */
export const NOTIFICATION_PAGE_SIZE = 20;

/**
 * The unread BADGE count — a tiny, frequently-polled query so the bell badge stays live. The bell enables
 * it for every authenticated human (the API scopes the count per caller); the badge only renders when the
 * count is > 0, so a user with no notifications sees a clean bell.
 */
export function useUnreadNotificationCount(enabled: boolean) {
  return useQuery({
    queryKey: notificationKeys.unreadCount(),
    queryFn: getUnreadCount,
    enabled,
    refetchInterval: enabled ? NOTIFICATION_POLL_INTERVAL_MS : false,
    refetchOnWindowFocus: true,
  });
}

/**
 * The dropdown LIST — the most-recent page of notifications, each with its per-caller `read` flag.
 * Polled while the bell is mounted+enabled so the list stays current; `enabled` is the dropdown's open
 * state, so a closed bell doesn't poll the heavier list.
 */
export function useNotifications(enabled: boolean) {
  return useQuery({
    queryKey: notificationKeys.list({ limit: NOTIFICATION_PAGE_SIZE }),
    queryFn: () => getNotifications({ limit: NOTIFICATION_PAGE_SIZE }),
    enabled,
    placeholderData: keepPreviousData,
    refetchInterval: enabled ? NOTIFICATION_POLL_INTERVAL_MS : false,
  });
}

/** Invalidate BOTH the list and the badge after any read action (the count + flags both change). */
function invalidateAfterRead(
  queryClient: ReturnType<typeof useQueryClient>,
) {
  queryClient.invalidateQueries({ queryKey: notificationKeys.all });
}

/** Mark one notification read (on click). Invalidates the list + the unread badge. */
export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: () => invalidateAfterRead(queryClient),
  });
}

/** Mark every unread notification read ("mark all read"). Invalidates the list + the unread badge. */
export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: () => invalidateAfterRead(queryClient),
  });
}
