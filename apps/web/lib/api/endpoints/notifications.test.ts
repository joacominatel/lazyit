import { beforeEach, describe, expect, mock, test } from "bun:test";

const calls: Array<{ path: string; init?: { method?: string } }> = [];

void mock.module("../client", () => ({
  apiFetch: (path: string, init?: { method?: string }) => {
    calls.push({ path, init });
    return Promise.resolve({ dismissed: 0, unread: 0 });
  },
}));

const { dismissAllNotifications } = await import("./notifications");

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
