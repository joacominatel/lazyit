import { expect, test } from "bun:test";
import type { Page, WorkflowConnection, WorkflowSecret } from "@lazyit/shared";
import {
  secretForConnection,
  selectActiveConnection,
} from "./connection-select";

/**
 * Regression for #288: the connection + secret list endpoints return the `Page<T>` envelope
 * (`{ items, total, limit, offset }`, ADR-0030), NOT a raw array. The builder/card used to read the
 * list as `connections?.[0]` / `secrets.find(...)` — a `Page` has no `[0]` (→ always `undefined`, so a
 * just-created connection never rendered and the "no automation configured" empty state lingered) and
 * no `.find` (→ a latent runtime throw once a connection rendered). These helpers read `.items`; this
 * test pins that, and the `@ts-expect-error` below is a compile-time guard against re-introducing the
 * raw-array shape (it goes stale — and `tsc --noEmit` fails — if the input is ever widened back).
 */

const conn = (over: Partial<WorkflowConnection> = {}): WorkflowConnection => ({
  id: "conn_1",
  applicationId: "app_1",
  kind: "MANUAL",
  name: "Primary",
  config: { kind: "MANUAL" },
  secretId: null,
  createdAt: "2026-06-08T00:00:00.000Z",
  updatedAt: "2026-06-08T00:00:00.000Z",
  deletedAt: null,
  ...over,
});

const secret = (over: Partial<WorkflowSecret> = {}): WorkflowSecret => ({
  id: "sec_1",
  applicationId: "app_1",
  connectionId: null,
  label: "API token",
  keyVersion: 1,
  configured: true,
  createdAt: "2026-06-08T00:00:00.000Z",
  updatedAt: "2026-06-08T00:00:00.000Z",
  deletedAt: null,
  ...over,
});

function page<T>(items: T[]): Page<T> {
  return { items, total: items.length, limit: 50, offset: 0 };
}

test("selectActiveConnection returns items[0] from the Page envelope", () => {
  const first = conn({ id: "conn_a" });
  const result = selectActiveConnection(page([first, conn({ id: "conn_b" })]));
  expect(result).toBe(first);
});

test("selectActiveConnection is undefined for an empty page or undefined data", () => {
  expect(selectActiveConnection(page<WorkflowConnection>([]))).toBeUndefined();
  expect(selectActiveConnection(undefined)).toBeUndefined();
});

test("secretForConnection matches by secretId first", () => {
  const linked = secret({ id: "sec_linked" });
  const other = secret({ id: "sec_other", connectionId: "conn_1" });
  const result = secretForConnection(conn({ secretId: "sec_linked" }), [
    other,
    linked,
  ]);
  expect(result).toBe(linked);
});

test("secretForConnection falls back to connectionId when no secretId match", () => {
  const byConnection = secret({ id: "sec_x", connectionId: "conn_1" });
  const result = secretForConnection(conn({ id: "conn_1", secretId: null }), [
    secret({ id: "sec_unrelated", connectionId: "conn_99" }),
    byConnection,
  ]);
  expect(result).toBe(byConnection);
});

test("secretForConnection is undefined when secrets are absent or unmatched", () => {
  expect(secretForConnection(conn(), undefined)).toBeUndefined();
  expect(
    secretForConnection(conn({ id: "conn_1", secretId: "missing" }), [
      secret({ id: "sec_z", connectionId: "conn_99" }),
    ]),
  ).toBeUndefined();
});

test("the list shape is the Page envelope, never a raw array (compile-time guard)", () => {
  // @ts-expect-error selectActiveConnection takes Page<WorkflowConnection>, never a raw array — if the
  // endpoint/helper is ever reverted to an array, this @ts-expect-error goes stale and tsc fails.
  selectActiveConnection([] as WorkflowConnection[]);
  expect(true).toBe(true);
});
