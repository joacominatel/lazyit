import { expect, test } from "bun:test";
import type { Page } from "@lazyit/shared";

/**
 * Repo-wide compile-time guard for the `Page<T>` list envelope (ADR-0030), pinning the invariant that
 * keeps biting us: a paged list endpoint returns `{ items, total, limit, offset }`, NOT a bare array.
 *
 * This is the third recurrence of the same class — #288 (workflow connections/secrets read as
 * `page[0]`/`page.find`) and #320 (a consumables optimistic patch mapping the envelope as an array) —
 * so the fix is to make the envelope-as-array mistake fail `tsc`, not just review for it. Every list
 * hook either applies `select: (page) => page.items` (so consumers get a `T[]`) or returns the raw
 * `Page<T>` for consumers that read `.items` + `.total`/`.offset`; this file asserts at the TYPE level
 * that the raw `Page<T>` cannot be used as an array. The `@ts-expect-error` directives below go stale
 * — and `tsc --noEmit` (the web CI gate) fails — the moment `Page<T>` is ever widened back toward an
 * array-like shape. The per-resource companion guard lives in `lib/workflow/connection-select.test.ts`.
 *
 * The assertions are purely type-level: they sit in a function the compiler checks but the runtime
 * NEVER calls (the `page` value is `declare`-only, so executing the body would throw). The actual
 * `test()` is a trivial structural sanity check on a real envelope so the suite stays a green run.
 */

interface Row {
  id: string;
}

// `declare` gives the value a TYPE for the compiler without a runtime binding — the guard never runs.
declare const page: Page<Row>;

// Never invoked at runtime; exists so `tsc --noEmit` keeps verifying every `@ts-expect-error` below.
// biome-ignore lint/correctness/noUnusedVariables: type-level guard, intentionally uncalled.
function pageEnvelopeIsNotAnArray(): void {
  // The envelope's array lives under `.items` — the only array-typed member; `.total` is the count.
  const rows: Row[] = page.items;
  const total: number = page.total;
  void rows;
  void total;

  // @ts-expect-error — `Page<T>` has no `.map`: a list response is the envelope, read `page.items`.
  page.map((row) => row.id);
  // @ts-expect-error — `Page<T>` is not indexable by number: read `page.items[0]`, never `page[0]`.
  const first: Row = page[0];
  // @ts-expect-error — `Page<T>` has no `.length`: read `page.items.length` (or `page.total`).
  const count: number = page.length;
  // @ts-expect-error — `Page<T>` has no `.find`: read `page.items.find(...)`.
  page.find((row) => row.id === "x");
  // @ts-expect-error — `Page<T>` has no `.filter`: read `page.items.filter(...)`.
  page.filter((row) => Boolean(row.id));

  void first;
  void count;
}
void pageEnvelopeIsNotAnArray;

test("Page<T> exposes its rows under .items, with envelope metadata alongside", () => {
  const envelope: Page<Row> = {
    items: [{ id: "row_1" }],
    total: 1,
    limit: 50,
    offset: 0,
  };
  expect(Array.isArray(envelope.items)).toBe(true);
  expect(envelope.items[0]?.id).toBe("row_1");
  expect(envelope.total).toBe(1);
  // The envelope itself is an object, never an array — the bug this guard prevents.
  expect(Array.isArray(envelope)).toBe(false);
});
