import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const calls: Array<{ path: string; init?: { method?: string; body?: unknown } }> = [];

// bun's `mock.module` is process-wide and outlives this file: without a restore, every later file would
// get this stub instead of the real client (and no `ApiError`). Keep the real exports beside the stub
// and hand them back when this file is done. The path is resolved once here because a relative
// specifier inside a hook does not resolve against this file, so the restore would silently miss.
const CLIENT = Bun.resolveSync("../client", import.meta.dir);
const realClient = { ...(await import("../client")) };
afterAll(() => mock.module(CLIENT, () => realClient));
void mock.module(CLIENT, () => ({
  ...realClient,
  apiFetch: (path: string, init?: { method?: string; body?: unknown }) => {
    calls.push({ path, init });
    return Promise.resolve({ dismissed: 0, unread: 0 });
  },
}));

const {
  dismissAllNotifications,
  getNotificationGroupItems,
  getNotificationGroups,
  markNotificationGroupRead,
} = await import("./notifications");

beforeEach(() => {
  calls.length = 0;
});

describe("dismissAllNotifications (#1309)", () => {
  test("sends `upTo` as an encoded query param", async () => {
    await dismissAllNotifications("2026-09-23T10:00:00.123Z");

    expect(calls).toEqual([
      {
        path: "/notifications/dismiss-all?upTo=2026-09-23T10%3A00%3A00.123Z",
        init: { method: "PATCH" },
      },
    ]);
  });

  test("sends no query without `upTo`", async () => {
    await dismissAllNotifications();

    expect(calls).toEqual([
      { path: "/notifications/dismiss-all", init: { method: "PATCH" } },
    ]);
  });
});

describe("grouped feed (#1649)", () => {
  const TZ = "America/Argentina/Buenos_Aires";

  test("lists groups in the given zone and window", async () => {
    await getNotificationGroups(TZ, { limit: 20, offset: 40 });

    expect(calls).toEqual([
      {
        path: "/notifications/groups?tz=America%2FArgentina%2FBuenos_Aires&limit=20&offset=40",
        init: undefined,
      },
    ]);
  });

  test("lists one group's items by type and day in the same zone", async () => {
    await getNotificationGroupItems(
      { type: "workflow.manual_task", day: "2026-10-17" },
      TZ,
      { limit: 20, offset: 0 },
    );

    expect(calls[0].path).toBe(
      "/notifications/groups/items?type=workflow.manual_task&day=2026-10-17&tz=America%2FArgentina%2FBuenos_Aires&limit=20&offset=0",
    );
  });

  test("marks a group read with a body carrying the zone", async () => {
    const body = {
      type: "critical_app_access" as const,
      day: "2026-10-17",
      tz: TZ,
    };
    await markNotificationGroupRead(body);

    expect(calls).toEqual([
      { path: "/notifications/read-group", init: { method: "PATCH", body } },
    ]);
  });
});
