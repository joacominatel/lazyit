import { describe, expect, test } from "bun:test";
import type { UseQueryResult } from "@tanstack/react-query";
import { serverPendingResult } from "./client-only-query";

describe("serverPendingResult (#1448)", () => {
  const refetch = (() => Promise.resolve()) as unknown as UseQueryResult<{ role: string }>["refetch"];

  test("mirrors the server render of a never-prefetched query: pending, idle, no data", () => {
    const r = serverPendingResult<{ role: string }, Error>({ refetch });
    expect(r.data).toBeUndefined();
    expect(r.status).toBe("pending");
    expect(r.fetchStatus).toBe("idle");
    expect(r.isPending).toBe(true);
    expect(r.error).toBeNull();
  });

  test("isLoading is false, as on the server where no fetch ever starts (#931)", () => {
    const r = serverPendingResult({ refetch });
    expect(r.isLoading).toBe(false);
    expect(r.isFetching).toBe(false);
    expect(r.isInitialLoading).toBe(false);
  });

  test("never reports success or error, whatever the client cache holds", () => {
    const r = serverPendingResult({ refetch });
    expect(r.isSuccess).toBe(false);
    expect(r.isError).toBe(false);
    expect(r.isFetched).toBe(false);
  });

  test("keeps the live refetch so an error-state retry still works", () => {
    expect(serverPendingResult({ refetch }).refetch).toBe(refetch);
  });

  test("is deterministic: two calls produce the same shape", () => {
    expect(serverPendingResult({ refetch })).toEqual(serverPendingResult({ refetch }));
  });
});
