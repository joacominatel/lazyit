import { afterEach, describe, expect, test } from "bun:test";
import { ApiError, apiFetchStream } from "./client";

/**
 * `apiFetchStream` (docs/ai-assistant/_synthesis.md §4.6): the headers it sends are load-bearing — the
 * Bearer token authenticates the stream, `Accept: text/event-stream` is how the reverse proxy knows not
 * to compress (and so buffer) it, and `Last-Event-ID` is how a reconnect resumes. `fetch` is replaced
 * per test and restored after each one.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

interface Captured {
  url: string;
  init: RequestInit;
}

function stubFetch(response: () => Response): Captured[] {
  const calls: Captured[] = [];
  globalThis.fetch = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(response());
  }) as typeof fetch;
  return calls;
}

function sseResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream; charset=utf-8" },
    ...init,
  });
}

function headersOf(call: Captured): Headers {
  return new Headers(call.init.headers);
}

describe("apiFetchStream", () => {
  test("sends Bearer auth and Accept: text/event-stream, and bypasses the HTTP cache", async () => {
    const calls = stubFetch(() => sseResponse(""));

    await apiFetchStream("/ai/runs/r1/events", { token: "tok-123" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url.endsWith("/ai/runs/r1/events")).toBe(true);
    const headers = headersOf(calls[0]);
    expect(headers.get("authorization")).toBe("Bearer tok-123");
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.has("last-event-id")).toBe(false);
    expect(calls[0].init.cache).toBe("no-store");
  });

  test("sends Last-Event-ID when resuming", async () => {
    const calls = stubFetch(() => sseResponse(""));

    await apiFetchStream("/ai/runs/r1/events", { token: "t", lastEventId: "r1:42" });

    expect(headersOf(calls[0]).get("last-event-id")).toBe("r1:42");
  });

  test("a caller header cannot replace the Accept header", async () => {
    const calls = stubFetch(() => sseResponse(""));

    await apiFetchStream("/x", { headers: { Accept: "application/json", "X-Extra": "1" } });

    const headers = headersOf(calls[0]);
    expect(headers.get("accept")).toBe("text/event-stream");
    expect(headers.get("x-extra")).toBe("1");
  });

  test("passes the abort signal through to fetch", async () => {
    const calls = stubFetch(() => sseResponse(""));
    const controller = new AbortController();

    await apiFetchStream("/x", { signal: controller.signal });

    expect(calls[0].init.signal).toBe(controller.signal);
  });

  test("yields the parsed events of the body", async () => {
    stubFetch(() =>
      sseResponse(': heartbeat\n\nid: r1:1\nevent: run.status\ndata: {"status":"RUNNING"}\n\n'),
    );

    const events = [];
    for await (const event of await apiFetchStream("/x")) events.push(event);

    expect(events).toEqual([
      { event: "run.status", data: '{"status":"RUNNING"}', lastEventId: "r1:1" },
    ]);
  });

  test("throws ApiError with the status, message and request id on a non-2xx", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ message: "Run not found" }), {
          status: 404,
          headers: { "content-type": "application/json", "x-request-id": "req-9" },
        }),
    );

    const error = await apiFetchStream("/x").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 404, message: "Run not found", requestId: "req-9" });
  });

  test("refuses a 2xx body that is not an event stream", async () => {
    stubFetch(
      () =>
        new Response("<html></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const error = await apiFetchStream("/x").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 200, message: "API response is not an event stream" });
  });
});
