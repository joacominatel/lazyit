import { describe, expect, test } from "bun:test";
import type { PurchaseExtractionStatus } from "@lazyit/shared";
import {
  canStartFromDocument,
  firstFile,
  type StartEffects,
  startFromDocument,
  startRefusal,
} from "./start-from-document";
import { runExclusive } from "./submit-guard";

const STATUS: PurchaseExtractionStatus = {
  available: true,
  reason: null,
  mediaTypes: ["application/pdf", "image/png", "image/jpeg"],
  maxBytes: 10 * 1024 * 1024,
  maxBytesByMediaType: { "image/png": 5 * 1024 * 1024 },
  maxPages: 20,
  disclosure: "…",
};

type Doc = { name: string };

function recorder(overrides: Partial<StartEffects<Doc>> = {}) {
  const calls: string[] = [];
  const fx: StartEffects<Doc> = {
    create: async (reference) => {
      calls.push(`create ${reference}`);
      return { id: "po1" };
    },
    upload: async (id, file) => {
      calls.push(`upload ${id} ${file.name}`);
      return { id: "att1", originalName: file.name };
    },
    rename: async (id, reference) => {
      calls.push(`rename ${id} ${reference}`);
    },
    open: (href) => calls.push(`open ${href}`),
    step: (step) => calls.push(`step ${step}`),
    failed: (stage) => calls.push(`failed ${stage}`),
    ...overrides,
  };
  return { calls, fx };
}

describe("startFromDocument — one pipeline for the button and the drop (#1516)", () => {
  test("creates the draft named after the file, attaches it, then opens the review that reads it", async () => {
    const { calls, fx } = recorder();
    expect(await startFromDocument({ name: "Factura A 0003.pdf" }, fx)).toBe("hold");
    expect(calls).toEqual([
      "step create",
      "create Factura A 0003",
      "step attach",
      "upload po1 Factura A 0003.pdf",
      "step open",
      "open /purchases/po1/review/att1?read=1",
    ]);
  });

  test("renames the draft only when the server stored the file under another name", async () => {
    const { calls, fx } = recorder({
      upload: async () => ({ id: "att1", originalName: "Factura_A_0003.pdf" }),
    });
    await startFromDocument({ name: "Factura A 0003.pdf" }, fx);
    expect(calls).toContain("rename po1 Factura_A_0003");
    expect(calls.indexOf("rename po1 Factura_A_0003")).toBeLessThan(calls.indexOf("step open"));
  });

  test("a failed rename is reported and the review still opens", async () => {
    const { calls, fx } = recorder({
      upload: async () => ({ id: "att1", originalName: "other.pdf" }),
      rename: async () => {
        throw new Error("409");
      },
    });
    expect(await startFromDocument({ name: "invoice.pdf" }, fx)).toBe("hold");
    expect(calls.slice(-3)).toEqual(["failed rename", "step open", "open /purchases/po1/review/att1?read=1"]);
  });

  test("a failed upload opens the draft purchase and never the review", async () => {
    const { calls, fx } = recorder({
      upload: async () => {
        throw new Error("413");
      },
    });
    expect(await startFromDocument({ name: "invoice.pdf" }, fx)).toBe("hold");
    expect(calls.slice(-2)).toEqual(["failed upload", "open /purchases/po1"]);
    expect(calls.some((call) => call.startsWith("rename"))).toBe(false);
  });

  test("a failed create stops there and releases the lock, so the person can try again", async () => {
    const { calls, fx } = recorder({
      create: async () => {
        throw new Error("500");
      },
    });
    const lock = { current: false };
    await runExclusive(lock, () => startFromDocument({ name: "invoice.pdf" }, fx));
    expect(calls).toEqual(["step create", "failed create"]);
    expect(lock.current).toBe(false);
  });

  test("a second file while one is starting is ignored, and so is one after the page started to change", async () => {
    let release!: () => void;
    let creates = 0;
    const { fx } = recorder({
      create: () =>
        new Promise((resolve) => {
          creates += 1;
          release = () => resolve({ id: "po1" });
        }),
    });
    const lock = { current: false };
    const first = runExclusive(lock, () => startFromDocument({ name: "a.pdf" }, fx));
    expect(await runExclusive(lock, () => startFromDocument({ name: "b.pdf" }, fx))).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(await runExclusive(lock, () => startFromDocument({ name: "c.pdf" }, fx))).toBe(false);
    expect(creates).toBe(1);
  });
});

describe("canStartFromDocument — where the button and the drop targets appear", () => {
  test("only with purchaseOrder:write and extraction available", () => {
    expect(canStartFromDocument(true, STATUS)).toBe(true);
    expect(canStartFromDocument(false, STATUS)).toBe(false);
    expect(canStartFromDocument(true, { available: false })).toBe(false);
    expect(canStartFromDocument(true, undefined)).toBe(false);
  });
});

describe("firstFile — several files dropped at once", () => {
  test("the first is read and the others are said to be left out", () => {
    expect(firstFile(["a.pdf", "b.pdf"])).toEqual({ file: "a.pdf", extra: true });
    expect(firstFile(["a.pdf"])).toEqual({ file: "a.pdf", extra: false });
    expect(firstFile([])).toEqual({ file: null, extra: false });
    expect(firstFile(null)).toEqual({ file: null, extra: false });
  });
});

describe("startRefusal — refused before anything is created", () => {
  test("a type the provider does not read", () => {
    expect(startRefusal(STATUS, { name: "list.csv", type: "text/csv", size: 10 })).toEqual({
      key: "wrongType",
      values: { name: "list.csv" },
    });
  });

  test("a file over its type's cap names that cap", () => {
    expect(startRefusal(STATUS, { name: "scan.png", type: "image/png", size: 6 * 1024 * 1024 })).toEqual({
      key: "tooLarge",
      values: { name: "scan.png", max: 5 },
    });
    expect(
      startRefusal(STATUS, { name: "big.pdf", type: "application/pdf", size: 11 * 1024 * 1024 }),
    ).toEqual({ key: "tooLarge", values: { name: "big.pdf", max: 10 } });
  });

  test("a readable file within its cap is accepted", () => {
    expect(startRefusal(STATUS, { name: "ok.pdf", type: "application/pdf", size: 1024 })).toBeNull();
  });
});
