import { describe, expect, test } from "bun:test";
import { stopQuietly } from "./use-camera-scanner";

describe("stopQuietly — a scanner teardown never throws (#1476 review)", () => {
  test("a stop that throws synchronously (start pending or failed) is swallowed and nothing is cleared", async () => {
    let cleared = false;
    const scanner = {
      stop: (): Promise<void> => {
        throw new Error("Cannot stop, scanner is not running or paused.");
      },
      clear: () => {
        cleared = true;
      },
    };
    await expect(stopQuietly(scanner, { clear: true })).resolves.toBeUndefined();
    expect(cleared).toBe(false);
  });

  test("a stop that rejects is swallowed", async () => {
    await expect(stopQuietly({ stop: () => Promise.reject(new Error("boom")) })).resolves.toBeUndefined();
  });

  test("a running scanner is stopped, then cleared when asked", async () => {
    const calls: string[] = [];
    const scanner = {
      stop: async () => {
        calls.push("stop");
      },
      clear: () => {
        calls.push("clear");
      },
    };
    await stopQuietly(scanner, { clear: true });
    expect(calls).toEqual(["stop", "clear"]);
    await stopQuietly(scanner);
    expect(calls).toEqual(["stop", "clear", "stop"]);
  });

  test("a clear that throws is swallowed too", async () => {
    const scanner = {
      stop: async () => {},
      clear: () => {
        throw new Error("node gone");
      },
    };
    await expect(stopQuietly(scanner, { clear: true })).resolves.toBeUndefined();
  });
});
