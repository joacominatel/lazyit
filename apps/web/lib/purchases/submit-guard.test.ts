import { describe, expect, test } from "bun:test";
import { runExclusive } from "./submit-guard";

describe("runExclusive — one save at a time", () => {
  test("a second submit while the first is in flight is skipped", async () => {
    const lock = { current: false };
    let runs = 0;
    let release!: () => void;
    const slow = () =>
      new Promise<void>((resolve) => {
        runs += 1;
        release = resolve;
      });
    const first = runExclusive(lock, slow);
    const second = await runExclusive(lock, slow);
    expect(second).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(runs).toBe(1);
  });

  test("the lock is released after a failure, so the operator can retry", async () => {
    const lock = { current: false };
    await expect(runExclusive(lock, () => Promise.reject(new Error("409")))).rejects.toThrow("409");
    expect(lock.current).toBe(false);
    expect(await runExclusive(lock, async () => {})).toBe(true);
  });

  test("a save that succeeded and is navigating away keeps the lock, so it cannot run twice", async () => {
    const lock = { current: false };
    let runs = 0;
    const create = async () => {
      runs += 1;
      return "hold" as const;
    };
    expect(await runExclusive(lock, create)).toBe(true);
    expect(await runExclusive(lock, create)).toBe(false);
    expect(lock.current).toBe(true);
    expect(runs).toBe(1);
  });
});
