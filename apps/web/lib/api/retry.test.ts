import { describe, expect, test } from "bun:test";
import { ApiError } from "./client";
import { skip4xxRetry } from "./retry";

/**
 * The app-wide retry predicate (issues #935, #940): never retry a 4xx, keep up to 3 retries for
 * transient (5xx / network) failures. This is the guard that stops a 403 from being disguised as a
 * flaky "API is down" error and retried 4 times, and stops the `/assets/import` 404 from looping.
 */
describe("skip4xxRetry", () => {
  const api = (status: number) => new ApiError(status, `HTTP ${status}`);

  test("never retries a 4xx (401/403/404/400/429)", () => {
    for (const status of [400, 401, 403, 404, 429]) {
      expect(skip4xxRetry(0, api(status))).toBe(false);
    }
  });

  test("retries a 5xx up to 3 times, then stops", () => {
    expect(skip4xxRetry(0, api(500))).toBe(true);
    expect(skip4xxRetry(2, api(503))).toBe(true);
    expect(skip4xxRetry(3, api(500))).toBe(false);
  });

  test("retries a non-ApiError (network failure) up to 3 times", () => {
    const network = new TypeError("Failed to fetch");
    expect(skip4xxRetry(0, network)).toBe(true);
    expect(skip4xxRetry(3, network)).toBe(false);
  });
});
