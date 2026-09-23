import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type QueryKey,
  type UseMutationOptions,
} from "@tanstack/react-query";
import type {
  DismissNotificationsResult,
  Notification,
  Page,
  UnreadCount,
} from "@lazyit/shared";
import {
  dismissAllNotifications,
  dismissNotification,
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

/** Shared by both dismiss mutations so concurrent ones can see each other (see `onSettled`). */
const DISMISS_MUTATION_KEY = [...notificationKeys.all, "dismiss"] as const;

/**
 * What a dismiss hides: one notification by id, or — for "Clear all" — every row created at or before
 * `upTo`, the same bound the server applies (every row when `upTo` is absent).
 */
type DismissTarget = string | { upTo: string | undefined };

/**
 * The newest `createdAt` among the rows the bell rendered — the `upTo` "Clear all" sends, so it only
 * dismisses what the user has seen. `undefined` for no rows.
 */
export function newestCreatedAt(
  items: readonly Notification[],
): string | undefined {
  let newest: string | undefined;
  for (const n of items) {
    if (newest === undefined || Date.parse(n.createdAt) > Date.parse(newest)) {
      newest = n.createdAt;
    }
  }
  return newest;
}

/** The pre-mutation cache a dismiss restores on error: every cached list page + the badge count. */
interface DismissSnapshot {
  lists: Array<[QueryKey, Page<Notification> | undefined]>;
  count: UnreadCount | undefined;
}

/**
 * Optimistically hide notifications from every cached list page and drop the badge by the unread ones
 * hidden (dismiss implies read, ADR-0056 §7 amendment). "Clear all" hides the rows at or before its
 * `upTo` and sets the badge to the unread rows it kept — none when every rendered row is cleared, since
 * the server also dismisses the older rows beyond the loaded page. Returns the snapshot to roll back to.
 */
async function hideFromCache(
  queryClient: QueryClient,
  target: DismissTarget,
): Promise<DismissSnapshot> {
  // Cancel in-flight polls so a response that predates the dismiss can't resurrect the row.
  await queryClient.cancelQueries({ queryKey: notificationKeys.all });
  const snapshot: DismissSnapshot = {
    lists: queryClient.getQueriesData<Page<Notification>>({
      queryKey: notificationKeys.lists(),
    }),
    count: queryClient.getQueryData<UnreadCount>(notificationKeys.unreadCount()),
  };

  const hidden =
    typeof target === "string"
      ? (n: Notification) => n.id === target
      : (n: Notification) =>
          target.upTo === undefined ||
          Date.parse(n.createdAt) <= Date.parse(target.upTo);
  // The list caches the `Page<Notification>` ENVELOPE (ADR-0030), not a bare array — preserve it.
  let unreadHidden = 0;
  let unreadKept = 0;
  let counted = false;
  queryClient.setQueriesData<Page<Notification>>(
    { queryKey: notificationKeys.lists() },
    (page) => {
      if (!page) return page;
      const removed = page.items.filter(hidden);
      // Several list pages may hold the same row; count its unread once for the badge.
      if (!counted) {
        unreadHidden = removed.filter((n) => !n.read).length;
        unreadKept = page.items.filter((n) => !hidden(n) && !n.read).length;
        counted = removed.length > 0;
      }
      return {
        ...page,
        items: page.items.filter((n) => !hidden(n)),
        total: Math.max(0, page.total - removed.length),
      };
    },
  );
  if (snapshot.count) {
    queryClient.setQueryData<UnreadCount>(notificationKeys.unreadCount(), {
      unread:
        typeof target === "string"
          ? Math.max(0, snapshot.count.unread - unreadHidden)
          : unreadKept,
    });
  }
  return snapshot;
}

/**
 * The shared dismiss lifecycle: optimistic hide → roll back on error → take the badge from the server's
 * fresh `unread` (no count refetch) → reconcile the list with the server. Toasts belong to the caller,
 * which owns the translated copy (`notifyError` in the bell).
 */
function dismissMutationOptions<TVariables>(
  queryClient: QueryClient,
  mutationFn: (vars: TVariables) => Promise<DismissNotificationsResult>,
  target: (vars: TVariables) => DismissTarget,
): UseMutationOptions<
  DismissNotificationsResult,
  Error,
  TVariables,
  DismissSnapshot
> {
  return {
    mutationKey: DISMISS_MUTATION_KEY,
    mutationFn,
    onMutate: (vars) => hideFromCache(queryClient, target(vars)),
    onError: (_error, _vars, snapshot) => {
      if (!snapshot) return;
      for (const [key, page] of snapshot.lists) {
        queryClient.setQueryData(key, page);
      }
      queryClient.setQueryData(notificationKeys.unreadCount(), snapshot.count);
    },
    onSuccess: ({ unread }) => {
      queryClient.setQueryData<UnreadCount>(notificationKeys.unreadCount(), {
        unread,
      });
    },
    onSettled: (_data, error) => {
      // Dismissing down the list puts several requests in flight; refetching between them would briefly
      // bring back rows the server has not hidden yet, so only the last one to settle reconciles.
      if (
        !error &&
        queryClient.isMutating({ mutationKey: DISMISS_MUTATION_KEY }) > 1
      ) {
        return;
      }
      // On success the badge is already authoritative; only the list needs the server's view. On error
      // the rolled-back count may be stale too, so reconcile everything.
      queryClient.invalidateQueries({
        queryKey: error ? notificationKeys.all : notificationKeys.lists(),
      });
    },
  };
}

/** Options for dismissing ONE notification. Exported so the lifecycle is testable without a DOM. */
export function dismissNotificationOptions(
  queryClient: QueryClient,
  mutationFn: (id: string) => Promise<DismissNotificationsResult> = dismissNotification,
) {
  return dismissMutationOptions(queryClient, mutationFn, (id) => id);
}

/**
 * Options for "Clear all". The variables are the rows the bell rendered: the request sends the newest
 * of their `createdAt` as `upTo`, and the optimistic removal hides exactly the rows the server will
 * dismiss — in practice every rendered row. Exported for the same reason.
 */
export function dismissAllNotificationsOptions(
  queryClient: QueryClient,
  mutationFn: (
    upTo: string | undefined,
  ) => Promise<DismissNotificationsResult> = dismissAllNotifications,
) {
  return dismissMutationOptions<readonly Notification[]>(
    queryClient,
    (items) => mutationFn(newestCreatedAt(items)),
    (items) => ({ upTo: newestCreatedAt(items) }),
  );
}

/** Dismiss one notification from the caller's own bell (the per-row X, #1309). Optimistic. */
export function useDismissNotification() {
  const queryClient = useQueryClient();
  return useMutation(dismissNotificationOptions(queryClient));
}

/**
 * Dismiss the rendered notifications from the caller's own bell ("Clear all", #1309) — pass the rows
 * the bell shows; anything newer stays. Optimistic.
 */
export function useDismissAllNotifications() {
  const queryClient = useQueryClient();
  return useMutation(dismissAllNotificationsOptions(queryClient));
}
