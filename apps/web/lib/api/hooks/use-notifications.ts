import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
  type UseMutationOptions,
} from "@tanstack/react-query";
import type {
  DismissNotificationsResult,
  MarkNotificationGroupRead,
  MarkReadResult,
  Notification,
  NotificationGroup,
  NotificationType,
  Page,
  UnreadCount,
} from "@lazyit/shared";
import { DEFAULT_TIME_ZONE } from "@/i18n/config";
import { flattenGroupPages, newestLatestAt } from "@/lib/notification-groups";
import {
  dismissAllNotifications,
  dismissNotification,
  getNotificationGroupItems,
  getNotificationGroups,
  getUnreadCount,
  markAllNotificationsRead,
  markNotificationGroupRead,
  markNotificationRead,
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
  groups: () => [...baseKeys.all, "groups"] as const,
  allGroupItems: () => [...baseKeys.all, "group-items"] as const,
  groupItems: (type: NotificationType, day: string) =>
    [...baseKeys.all, "group-items", type, day] as const,
  unreadCount: () => [...baseKeys.all, "unread-count"] as const,
};

export interface GroupRef {
  type: NotificationType;
  day: string;
}

type GroupPages = InfiniteData<Page<NotificationGroup>, number>;
type ItemPages = InfiniteData<Page<Notification>, number>;

/** Poll cadence (ADR-0056 §2 poll-floor) — 45s, in the 30–60s band the engine inbox uses. */
export const NOTIFICATION_POLL_INTERVAL_MS = 45000;

export const NOTIFICATION_GROUPS_PAGE_SIZE = 20;
export const NOTIFICATION_GROUP_ITEMS_PAGE_SIZE = 20;

function nextOffset(last: Page<unknown>): number | undefined {
  const next = last.offset + last.items.length;
  return next < last.total ? next : undefined;
}

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

// Polled only while the dropdown is open, so a closed bell costs one COUNT per interval.
export function useNotificationGroups(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: notificationKeys.groups(),
    queryFn: ({ pageParam }) =>
      getNotificationGroups(DEFAULT_TIME_ZONE, {
        limit: NOTIFICATION_GROUPS_PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: nextOffset,
    select: (data) => ({
      groups: flattenGroupPages(data.pages),
      total: data.pages[0]?.total ?? 0,
    }),
    enabled,
    refetchInterval: enabled ? NOTIFICATION_POLL_INTERVAL_MS : false,
  });
}

export function useNotificationGroupItems(group: GroupRef, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: notificationKeys.groupItems(group.type, group.day),
    queryFn: ({ pageParam }) =>
      getNotificationGroupItems(group, DEFAULT_TIME_ZONE, {
        limit: NOTIFICATION_GROUP_ITEMS_PAGE_SIZE,
        offset: pageParam,
      }),
    initialPageParam: 0,
    getNextPageParam: nextOffset,
    select: (data) => data.pages.flatMap((page) => page.items),
    enabled,
  });
}

function invalidateFeeds(queryClient: QueryClient) {
  void queryClient.invalidateQueries({ queryKey: notificationKeys.groups() });
  void queryClient.invalidateQueries({
    queryKey: notificationKeys.allGroupItems(),
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

// The row and the group it was rendered in: the group's day comes from the API, never recomputed here.
export interface DismissOne {
  notification: Notification;
  group: GroupRef;
}

// "Clear all" hides every row created at or before `upTo`, the bound the server applies.
type DismissTarget = DismissOne | { upTo: string | undefined };

type DismissSnapshot = Array<[QueryKey, unknown]>;

function mapPages<T>(
  data: InfiniteData<Page<T>, number> | undefined,
  keep: (item: T) => T | null,
): InfiniteData<Page<T>, number> | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => {
      const items = page.items.flatMap((item) => {
        const next = keep(item);
        return next === null ? [] : [next];
      });
      return {
        ...page,
        items,
        total: Math.max(0, page.total - (page.items.length - items.length)),
      };
    }),
  };
}

function hideOne(queryClient: QueryClient, { notification: n, group }: DismissOne) {
  queryClient.setQueryData<GroupPages>(notificationKeys.groups(), (data) =>
    mapPages(data, (g) => {
      if (g.type !== group.type || g.day !== group.day) return g;
      if (g.count <= 1) return null;
      return {
        ...g,
        count: g.count - 1,
        unread: n.read ? g.unread : Math.max(0, g.unread - 1),
        latest: g.latest.filter((x) => x.id !== n.id),
      };
    }),
  );
  queryClient.setQueryData<ItemPages>(
    notificationKeys.groupItems(group.type, group.day),
    (data) => mapPages(data, (x) => (x.id === n.id ? null : x)),
  );
  const count = queryClient.getQueryData<UnreadCount>(
    notificationKeys.unreadCount(),
  );
  if (count && !n.read) {
    queryClient.setQueryData<UnreadCount>(notificationKeys.unreadCount(), {
      unread: Math.max(0, count.unread - 1),
    });
  }
}

function hideUpTo(queryClient: QueryClient, upTo: string | undefined) {
  const bound = upTo === undefined ? Number.POSITIVE_INFINITY : Date.parse(upTo);
  const groups = queryClient.setQueryData<GroupPages>(
    notificationKeys.groups(),
    (data) => mapPages(data, (g) => (Date.parse(g.latestAt) <= bound ? null : g)),
  );
  queryClient.setQueriesData<ItemPages>(
    { queryKey: notificationKeys.allGroupItems() },
    (data) =>
      mapPages(data, (x) => (Date.parse(x.createdAt) <= bound ? null : x)),
  );
  if (queryClient.getQueryData(notificationKeys.unreadCount())) {
    // A group newer than `upTo` (a poll landed after render) keeps its unread until the server answers.
    const kept = groups ? flattenGroupPages(groups.pages) : [];
    queryClient.setQueryData<UnreadCount>(notificationKeys.unreadCount(), {
      unread: kept.reduce((sum, g) => sum + g.unread, 0),
    });
  }
}

async function hideFromCache(
  queryClient: QueryClient,
  target: DismissTarget,
): Promise<DismissSnapshot> {
  // Cancel in-flight polls so a response that predates the dismiss can't resurrect the row.
  await queryClient.cancelQueries({ queryKey: notificationKeys.all });
  const snapshot = queryClient.getQueriesData({ queryKey: notificationKeys.all });
  if ("notification" in target) hideOne(queryClient, target);
  else hideUpTo(queryClient, target.upTo);
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
      for (const [key, data] of snapshot) {
        queryClient.setQueryData(key, data);
      }
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
      if (error) {
        void queryClient.invalidateQueries({ queryKey: notificationKeys.all });
      } else {
        invalidateFeeds(queryClient);
      }
    },
  };
}

/** Options for dismissing ONE notification. Exported so the lifecycle is testable without a DOM. */
export function dismissNotificationOptions(
  queryClient: QueryClient,
  mutationFn: (id: string) => Promise<DismissNotificationsResult> = dismissNotification,
) {
  return dismissMutationOptions<DismissOne>(
    queryClient,
    (target) => mutationFn(target.notification.id),
    (target) => target,
  );
}

// The variables are the groups the bell rendered; their newest `latestAt` is the `upTo` sent.
export function dismissAllNotificationsOptions(
  queryClient: QueryClient,
  mutationFn: (
    upTo: string | undefined,
  ) => Promise<DismissNotificationsResult> = dismissAllNotifications,
) {
  return dismissMutationOptions<readonly NotificationGroup[]>(
    queryClient,
    (groups) => mutationFn(newestLatestAt(groups)),
    (groups) => ({ upTo: newestLatestAt(groups) }),
  );
}

/** Dismiss one notification from the caller's own bell (the per-row X, #1309). Optimistic. */
export function useDismissNotification() {
  const queryClient = useQueryClient();
  return useMutation(dismissNotificationOptions(queryClient));
}

// "Clear all" (#1309): pass the groups the bell shows; anything newer stays. Optimistic.
export function useDismissAllNotifications() {
  const queryClient = useQueryClient();
  return useMutation(dismissAllNotificationsOptions(queryClient));
}

// The group's unread drops at once; the refetch then brings the server's view of every row.
export function markNotificationGroupReadOptions(
  queryClient: QueryClient,
  mutationFn: (
    body: MarkNotificationGroupRead,
  ) => Promise<MarkReadResult> = markNotificationGroupRead,
): UseMutationOptions<MarkReadResult, Error, GroupRef> {
  return {
    mutationFn: (group) =>
      mutationFn({ type: group.type, day: group.day, tz: DEFAULT_TIME_ZONE }),
    onSuccess: ({ unread }, group) => {
      queryClient.setQueryData<UnreadCount>(notificationKeys.unreadCount(), {
        unread,
      });
      const markRead = (n: Notification) => ({ ...n, read: true });
      queryClient.setQueryData<GroupPages>(notificationKeys.groups(), (data) =>
        mapPages(data, (g) =>
          g.type === group.type && g.day === group.day
            ? { ...g, unread: 0, latest: g.latest.map(markRead) }
            : g,
        ),
      );
      queryClient.setQueryData<ItemPages>(
        notificationKeys.groupItems(group.type, group.day),
        (data) => mapPages(data, markRead),
      );
      invalidateFeeds(queryClient);
    },
  };
}

export function useMarkNotificationGroupRead() {
  const queryClient = useQueryClient();
  return useMutation(markNotificationGroupReadOptions(queryClient));
}
