import { describe, expect, test } from "bun:test";

import { nextListKey } from "./list-key";

describe("nextListKey", () => {
  test("returns a distinct key on every call", () => {
    const keys = Array.from({ length: 500 }, () => nextListKey());
    expect(new Set(keys).size).toBe(keys.length);
  });

  // The whole point of #1125: this must work with no WebCrypto at all, the way a browser on a
  // plain-HTTP LAN install behaves (no `crypto.randomUUID`, no `crypto.subtle`).
  test("works with no crypto global — the insecure-context case", () => {
    const original = globalThis.crypto;
    // @ts-expect-error — deliberately simulating an insecure context.
    delete globalThis.crypto;
    try {
      expect(nextListKey()).not.toBe(nextListKey());
    } finally {
      Object.defineProperty(globalThis, "crypto", {
        value: original,
        configurable: true,
      });
    }
  });
});
