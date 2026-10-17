import { describe, expect, test } from "bun:test";
import {
  MutationObserver,
  QueryClient,
  type InfiniteData,
} from "@tanstack/react-query";
import type {
  DismissNotificationsResult,
  MarkNotificationGroupRead,
  Notification,
  NotificationGroup,
  Page,
  UnreadCount,
} from "@lazyit/shared";
import { DEFAULT_TIME_ZONE } from "@/i18n/config";
import {
  dismissAllNotificationsOptions,
  dismissNotificationOptions,
  markNotificationGroupReadOptions,
  notificationKeys,
  type GroupRef,
} from "./use-notifications";

// The bell's cache lifecycle over the grouped feed (#1309, #1649), driven through a real QueryClient.

const GRANTS: GroupRef = { type: "critical_app_access", day: "2026-10-17" };
const STOCK: GroupRef = { type: "low_stock", day: "2026-10-16" };
const GROUPS_KEY = notificationKeys.groups();
const GRANT_ITEMS_KEY = notificationKeys.groupItems(GRANTS.type, GRANTS.day);

function notification(
  id: string,
  read: boolean,
  createdAt: string,
  type: Notification["type"] = "critical_app_access",
): Notification {
  return {
    id,
    type,
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

const A = notification("a", false, "2026-10-17T10:00:00.000Z");
const B = notification("b", true, "2026-10-17T09:00:00.000Z");
const C = notification("c", false, "2026-10-17T08:00:00.000Z");
const D = notification("d", false, "2026-10-16T09:00:00.000Z", "low_stock");

function group(
  ref: GroupRef,
  items: Notification[],
  latestAt = items[0].createdAt,
): NotificationGroup {
  return {
    ...ref,
    count: items.length,
    unread: items.filter((n) => !n.read).length,
    latestAt,
    latest: items.slice(0, 3),
  };
}

function infinite<T>(items: T[]): InfiniteData<Page<T>, number> {
  return {
    pages: [{ items, total: items.length, limit: 20, offset: 0 }],
    pageParams: [0],
  };
}

function seededClient() {
  const qc = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  qc.setQueryData(
    GROUPS_KEY,
    infinite([group(GRANTS, [A, B, C]), group(STOCK, [D])]),
  );
  qc.setQueryData(GRANT_ITEMS_KEY, infinite([A, B, C]));
  qc.setQueryData<UnreadCount>(notificationKeys.unreadCount(), { unread: 3 });
  return qc;
}

const groupsPage = (qc: QueryClient) =>
  qc.getQueryData<InfiniteData<Page<NotificationGroup>>>(GROUPS_KEY)!.pages[0];
const grantGroup = (qc: QueryClient) =>
  groupsPage(qc).items.find((g) => g.type === GRANTS.type);
const itemIds = (qc: QueryClient) =>
  qc
    .getQueryData<InfiniteData<Page<Notification>>>(GRANT_ITEMS_KEY)!
    .pages[0].items.map((n) => n.id);
const badge = (qc: QueryClient) =>
  qc.getQueryData<UnreadCount>(notificationKeys.unreadCount())?.unread;

function deferred() {
  let resolve!: (value: DismissNotificationsResult) => void;
  const promise = new Promise<DismissNotificationsResult>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("dismiss one notification", () => {
  test("hides the row from its group and drops the badge before the server answers", async () => {
    const qc = seededClient();
    const request = deferred();
    const sent: string[] = [];
    const observer = new MutationObserver(
      qc,
      dismissNotificationOptions(qc, (id) => {
        sent.push(id);
        return request.promise;
      }),
    );

    const pending = observer.mutate({ notification: A, group: GRANTS });
    await Bun.sleep(0);

    expect(sent).toEqual(["a"]);
    expect(itemIds(qc)).toEqual(["b", "c"]);
    expect(grantGroup(qc)).toMatchObject({ count: 2, unread: 1 });
    expect(grantGroup(qc)?.latest.map((n) => n.id)).toEqual(["b", "c"]);
    expect(badge(qc)).toBe(2);

    request.resolve({ dismissed: 1, unread: 2 });
    await pending;
  });

  test("dismissing a READ row leaves the unread counts untouched", async () => {
    const qc = seededClient();
    const request = deferred();
    const observer = new MutationObserver(
      qc,
      dismissNotificationOptions(qc, () => request.promise),
    );

    const pending = observer.mutate({ notification: B, group: GRANTS });
    await Bun.sleep(0);

    expect(grantGroup(qc)).toMatchObject({ count: 2, unread: 2 });
    expect(badge(qc)).toBe(3);

    request.resolve({ dismissed: 1, unread: 3 });
    await pending;
  });

  test("dismissing the last row of a group removes the group", async () => {
    const qc = seededClient();
    const request = deferred();
    const observer = new MutationObserver(
      qc,
      dismissNotificationOptions(qc, () => request.promise),
    );

    const pending = observer.mutate({ notification: D, group: STOCK });
    await Bun.sleep(0);

    expect(groupsPage(qc).items.map((g) => g.type)).toEqual([GRANTS.type]);
    expect(groupsPage(qc).total).toBe(1);
    expect(badge(qc)).toBe(2);

    request.resolve({ dismissed: 1, unread: 2 });
    await pending;
  });

  test("takes the badge from the server's fresh `unread`", async () => {
    const qc = seededClient();
    const observer = new MutationObserver(
      qc,
      dismissNotificationOptions(qc, async () => ({ dismissed: 1, unread: 5 })),
    );

    await observer.mutate({ notification: A, group: GRANTS });

    expect(badge(qc)).toBe(5);
  });

  test("rolls the group, its items and the badge back when the request fails", async () => {
    const qc = seededClient();
    const observer = new MutationObserver(
      qc,
      dismissNotificationOptions(qc, async () => {
        throw new Error("network down");
      }),
    );

    await expect(
      observer.mutate({ notification: A, group: GRANTS }),
    ).rejects.toThrow("network down");

    expect(itemIds(qc)).toEqual(["a", "b", "c"]);
    expect(grantGroup(qc)).toMatchObject({ count: 3, unread: 2 });
    expect(badge(qc)).toBe(3);
  });

  test("reconciles the feed with the server after it settles, not the badge", async () => {
    const qc = seededClient();
    const observer = new MutationObserver(
      qc,
      dismissNotificationOptions(qc, async () => ({ dismissed: 1, unread: 2 })),
    );

    await observer.mutate({ notification: A, group: GRANTS });

    expect(qc.getQueryState(GROUPS_KEY)?.isInvalidated).toBe(true);
    expect(qc.getQueryState(GRANT_ITEMS_KEY)?.isInvalidated).toBe(true);
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

    const pendingA = new MutationObserver(qc, options).mutate({
      notification: A,
      group: GRANTS,
    });
    await Bun.sleep(0);
    const pendingC = new MutationObserver(qc, options).mutate({
      notification: C,
      group: GRANTS,
    });
    await Bun.sleep(0);

    first.resolve({ dismissed: 1, unread: 2 });
    await pendingA;
    expect(qc.getQueryState(GROUPS_KEY)?.isInvalidated).toBe(false);
    expect(itemIds(qc)).toEqual(["b"]);

    second.resolve({ dismissed: 1, unread: 1 });
    await pendingC;
    expect(qc.getQueryState(GROUPS_KEY)?.isInvalidated).toBe(true);
    expect(badge(qc)).toBe(1);
  });
});

const renderedGroups = (qc: QueryClient) => groupsPage(qc).items;

describe("Clear all", () => {
  test("sends the newest latestAt among the rendered groups as `upTo`", async () => {
    const qc = seededClient();
    const sent: Array<string | undefined> = [];
    const observer = new MutationObserver(
      qc,
      dismissAllNotificationsOptions(qc, async (upTo) => {
        sent.push(upTo);
        return { dismissed: 4, unread: 0 };
      }),
    );

    await observer.mutate(renderedGroups(qc));

    expect(sent).toEqual(["2026-10-17T10:00:00.000Z"]);
  });

  test("empties the groups and their items and zeroes the badge optimistically", async () => {
    const qc = seededClient();
    const request = deferred();
    const observer = new MutationObserver(
      qc,
      dismissAllNotificationsOptions(qc, () => request.promise),
    );

    const pending = observer.mutate(renderedGroups(qc));
    await Bun.sleep(0);

    expect(groupsPage(qc).items).toEqual([]);
    expect(groupsPage(qc).total).toBe(0);
    expect(itemIds(qc)).toEqual([]);
    expect(badge(qc)).toBe(0);

    request.resolve({ dismissed: 4, unread: 0 });
    await pending;
  });

  test("keeps a group that got newer after render, with its unread on the badge", async () => {
    const qc = seededClient();
    const rendered = renderedGroups(qc);
    const fresh = notification("e", false, "2026-10-17T11:00:00.000Z");
    qc.setQueryData(
      GROUPS_KEY,
      infinite([group(GRANTS, [fresh, A, B, C]), group(STOCK, [D])]),
    );
    const request = deferred();
    const observer = new MutationObserver(
      qc,
      dismissAllNotificationsOptions(qc, () => request.promise),
    );

    const pending = observer.mutate(rendered);
    await Bun.sleep(0);

    expect(renderedGroups(qc).map((g) => g.type)).toEqual([GRANTS.type]);
    expect(itemIds(qc)).toEqual([]);
    expect(badge(qc)).toBe(3);

    request.resolve({ dismissed: 4, unread: 1 });
    await pending;
    expect(badge(qc)).toBe(1);
  });

  test("restores every group when the request fails", async () => {
    const qc = seededClient();
    const observer = new MutationObserver(
      qc,
      dismissAllNotificationsOptions(qc, async () => {
        throw new Error("server error");
      }),
    );

    await expect(observer.mutate(renderedGroups(qc))).rejects.toThrow(
      "server error",
    );

    expect(renderedGroups(qc)).toHaveLength(2);
    expect(itemIds(qc)).toEqual(["a", "b", "c"]);
    expect(badge(qc)).toBe(3);
  });
});

describe("mark a group read", () => {
  test("sends the group with the instance zone and takes the badge from the server", async () => {
    const qc = seededClient();
    const sent: MarkNotificationGroupRead[] = [];
    const observer = new MutationObserver(
      qc,
      markNotificationGroupReadOptions(qc, async (body) => {
        sent.push(body);
        return { marked: 2, unread: 1 };
      }),
    );

    await observer.mutate(GRANTS);

    expect(sent).toEqual([{ ...GRANTS, tz: DEFAULT_TIME_ZONE }]);
    expect(badge(qc)).toBe(1);
    expect(grantGroup(qc)?.unread).toBe(0);
    expect(grantGroup(qc)?.latest.every((n) => n.read)).toBe(true);
    expect(
      qc
        .getQueryData<InfiniteData<Page<Notification>>>(GRANT_ITEMS_KEY)!
        .pages[0].items.every((n) => n.read),
    ).toBe(true);
    // The other group is untouched, and the feed is refetched to confirm.
    expect(
      groupsPage(qc).items.find((g) => g.type === STOCK.type)?.unread,
    ).toBe(1);
    expect(qc.getQueryState(GROUPS_KEY)?.isInvalidated).toBe(true);
  });
});
