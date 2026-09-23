import { describe, expect, test } from "bun:test";
import { MutationObserver, QueryClient } from "@tanstack/react-query";
import type {
  DismissNotificationsResult,
  Notification,
  Page,
  UnreadCount,
} from "@lazyit/shared";
import {
  dismissAllNotificationsOptions,
  dismissNotificationOptions,
  NOTIFICATION_PAGE_SIZE,
  newestCreatedAt,
  notificationKeys,
} from "./use-notifications";

/**
 * The bell's dismiss lifecycle (#1309) — exercised through a real `QueryClient` + `MutationObserver`
 * (the same machinery `useMutation` drives) with a stubbed endpoint, so no DOM is needed:
 * optimistic hide, rollback on error, the badge taken from the server's `unread`, and "Clear all".
 */

const LIST_KEY = notificationKeys.list({ limit: NOTIFICATION_PAGE_SIZE });

function notification(
  id: string,
  read: boolean,
  createdAt = "2026-09-23T10:00:00.000Z",
): Notification {
  return {
    id,
    type: "low_stock",
    severity: "warning",
    title: `Notification ${id}`,
    summary: null,
    entityType: null,
    entityId: null,
    targetUserId: null,
    recipientUserId: null,
    metadata: null,
    createdAt,
    read,
  };
}

function seededClient() {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  qc.setQueryData<Page<Notification>>(LIST_KEY, {
    items: [
      notification("a", false),
      notification("b", true),
      notification("c", false),
    ],
    total: 3,
    limit: NOTIFICATION_PAGE_SIZE,
    offset: 0,
  });
  qc.setQueryData<UnreadCount>(notificationKeys.unreadCount(), { unread: 2 });
  return qc;
}

const listIds = (qc: QueryClient) =>
  qc.getQueryData<Page<Notification>>(LIST_KEY)?.items.map((n) => n.id);
const badge = (qc: QueryClient) =>
  qc.getQueryData<UnreadCount>(notificationKeys.unreadCount())?.unread;

/** A controllable endpoint stub: the test decides when the request resolves. */
function deferred() {
  let resolve!: (value: DismissNotificationsResult) => void;
  const promise = new Promise<DismissNotificationsResult>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("dismiss one notification", () => {
  test("hides the row and drops the badge before the server answers", async () => {
    const qc = seededClient();
    const request = deferred();
    const observer = new MutationObserver(
      qc,
      dismissNotificationOptions(qc, () => request.promise),
    );

    const pending = observer.mutate("a");
    await Bun.sleep(0);

    expect(listIds(qc)).toEqual(["b", "c"]);
    expect(qc.getQueryData<Page<Notification>>(LIST_KEY)?.total).toBe(2);
    // "a" was unread, and dismiss implies read.
    expect(badge(qc)).toBe(1);

    request.resolve({ dismissed: 1, unread: 1 });
    await pending;
  });

  test("dismissing a READ row leaves the badge untouched", async () => {
    const qc = seededClient();
    const request = deferred();
    const observer = new MutationObserver(
      qc,
      dismissNotificationOptions(qc, () => request.promise),
    );

    const pending = observer.mutate("b");
    await Bun.sleep(0);

    expect(listIds(qc)).toEqual(["a", "c"]);
    expect(badge(qc)).toBe(2);

    request.resolve({ dismissed: 1, unread: 2 });
    await pending;
  });

  test("takes the badge from the server's fresh `unread`", async () => {
    const qc = seededClient();
    const observer = new MutationObserver(
      qc,
      // Another notification arrived meanwhile: the server's count wins over the optimistic guess.
      dismissNotificationOptions(qc, async () => ({ dismissed: 1, unread: 5 })),
    );

    await observer.mutate("a");

    expect(badge(qc)).toBe(5);
    expect(listIds(qc)).toEqual(["b", "c"]);
  });

  test("rolls the row and the badge back when the request fails", async () => {
    const qc = seededClient();
    const observer = new MutationObserver(
      qc,
      dismissNotificationOptions(qc, async () => {
        throw new Error("network down");
      }),
    );

    await expect(observer.mutate("a")).rejects.toThrow("network down");

    expect(listIds(qc)).toEqual(["a", "b", "c"]);
    expect(qc.getQueryData<Page<Notification>>(LIST_KEY)?.total).toBe(3);
    expect(badge(qc)).toBe(2);
  });

  test("reconciles the list with the server after it settles", async () => {
    const qc = seededClient();
    const observer = new MutationObserver(
      qc,
      dismissNotificationOptions(qc, async () => ({ dismissed: 1, unread: 1 })),
    );

    await observer.mutate("a");

    expect(qc.getQueryState(LIST_KEY)?.isInvalidated).toBe(true);
    // The badge came from the response, so it is not refetched.
    expect(
      qc.getQueryState(notificationKeys.unreadCount())?.isInvalidated,
    ).toBe(false);
  });

  test("waits for the last of several in-flight dismisses before reconciling", async () => {
    const qc = seededClient();
    const first = deferred();
    const second = deferred();
    const requests = [first, second];
    const options = dismissNotificationOptions(
      qc,
      () => requests.shift()!.promise,
    );

    const pendingA = new MutationObserver(qc, options).mutate("a");
    await Bun.sleep(0);
    const pendingC = new MutationObserver(qc, options).mutate("c");
    await Bun.sleep(0);

    first.resolve({ dismissed: 1, unread: 1 });
    await pendingA;
    // "c" is still in flight: a refetch now could briefly bring it back.
    expect(qc.getQueryState(LIST_KEY)?.isInvalidated).toBe(false);
    expect(listIds(qc)).toEqual(["b"]);

    second.resolve({ dismissed: 1, unread: 0 });
    await pendingC;
    expect(qc.getQueryState(LIST_KEY)?.isInvalidated).toBe(true);
    expect(badge(qc)).toBe(0);
  });
});

const cachedItems = (qc: QueryClient) =>
  qc.getQueryData<Page<Notification>>(LIST_KEY)!.items;

describe("Clear all", () => {
  test("sends the newest createdAt among the rendered rows as `upTo`", async () => {
    const qc = seededClient();
    const sent: Array<string | undefined> = [];
    const observer = new MutationObserver(
      qc,
      dismissAllNotificationsOptions(qc, async (upTo) => {
        sent.push(upTo);
        return { dismissed: 3, unread: 0 };
      }),
    );

    await observer.mutate([
      notification("x", false, "2026-09-23T09:00:00.000Z"),
      notification("y", false, "2026-09-23T11:30:00.250Z"),
      notification("z", true, "2026-09-23T10:00:00.000Z"),
    ]);

    expect(sent).toEqual(["2026-09-23T11:30:00.250Z"]);
  });

  test("keeps a cached row newer than `upTo` — only the rendered rows leave, matching the server", async () => {
    const qc = seededClient();
    const rendered = cachedItems(qc);
    // A poll landed after the bell rendered: "d" is newer than anything the user saw.
    qc.setQueryData<Page<Notification>>(LIST_KEY, {
      items: [notification("d", false, "2026-09-23T10:00:00.001Z"), ...rendered],
      total: 4,
      limit: NOTIFICATION_PAGE_SIZE,
      offset: 0,
    });
    qc.setQueryData<UnreadCount>(notificationKeys.unreadCount(), { unread: 3 });
    const request = deferred();
    const observer = new MutationObserver(
      qc,
      dismissAllNotificationsOptions(qc, () => request.promise),
    );

    const pending = observer.mutate(rendered);
    await Bun.sleep(0);

    expect(listIds(qc)).toEqual(["d"]);
    expect(qc.getQueryData<Page<Notification>>(LIST_KEY)?.total).toBe(1);
    // "d" is unread and was not dismissed.
    expect(badge(qc)).toBe(1);

    request.resolve({ dismissed: 3, unread: 1 });
    await pending;
    expect(badge(qc)).toBe(1);
  });

  test("empties the list and zeroes the badge optimistically", async () => {
    const qc = seededClient();
    const request = deferred();
    const observer = new MutationObserver(
      qc,
      dismissAllNotificationsOptions(qc, () => request.promise),
    );

    const pending = observer.mutate(cachedItems(qc));
    await Bun.sleep(0);

    expect(listIds(qc)).toEqual([]);
    expect(qc.getQueryData<Page<Notification>>(LIST_KEY)?.total).toBe(0);
    expect(badge(qc)).toBe(0);

    request.resolve({ dismissed: 3, unread: 0 });
    await pending;
    expect(listIds(qc)).toEqual([]);
    expect(badge(qc)).toBe(0);
  });

  test("restores every row when the request fails", async () => {
    const qc = seededClient();
    const observer = new MutationObserver(
      qc,
      dismissAllNotificationsOptions(qc, async () => {
        throw new Error("server error");
      }),
    );

    await expect(observer.mutate(cachedItems(qc))).rejects.toThrow(
      "server error",
    );

    expect(listIds(qc)).toEqual(["a", "b", "c"]);
    expect(badge(qc)).toBe(2);
  });
});

describe("newestCreatedAt", () => {
  test("is undefined for no rows", () => {
    expect(newestCreatedAt([])).toBeUndefined();
  });

  test("compares instants, not list order", () => {
    expect(
      newestCreatedAt([
        notification("a", false, "2026-09-23T10:00:00.000Z"),
        notification("b", false, "2026-09-24T08:00:00.000Z"),
        notification("c", false, "2026-09-23T23:59:59.999Z"),
      ]),
    ).toBe("2026-09-24T08:00:00.000Z");
  });
});
