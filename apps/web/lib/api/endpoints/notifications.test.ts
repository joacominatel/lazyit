import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const calls: Array<{ path: string; init?: { method?: string } }> = [];

// bun's `mock.module` is process-wide and outlives this file: without a restore, every later file would
// get this stub instead of the real client (and no `ApiError`). Keep the real exports beside the stub
// and hand them back when this file is done. The path is resolved once here because a relative
// specifier inside a hook does not resolve against this file, so the restore would silently miss.
const CLIENT = Bun.resolveSync("../client", import.meta.dir);
const realClient = { ...(await import("../client")) };
afterAll(() => mock.module(CLIENT, () => realClient));
void mock.module(CLIENT, () => ({
  ...realClient,
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
