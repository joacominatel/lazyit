import type { Page, WorkflowConnection, WorkflowSecret } from "@lazyit/shared";

/**
 * Pure selection helpers for the per-application connection card / builder (frontend.md §2a / §4).
 *
 * The connection + secret list endpoints return the `Page<T>` envelope (`{ items, total, limit,
 * offset }`, ADR-0030) — NOT a raw array. Reading the page like an array (`page[0]` / `page.find`)
 * silently yields `undefined` (so a created connection never renders, the "no automation configured"
 * empty state lingers) or throws at runtime (`page.find is not a function`). These helpers centralise
 * the `.items` access so the bug can't regress, and are unit-tested in `connection-select.test.ts`.
 *
 * v1 models one connection per application (the common case); {@link selectActiveConnection} returns
 * the first.
 */

/** The connection a card/builder renders — the first item of the page, or `undefined` when empty. */
export function selectActiveConnection(
  page: Page<WorkflowConnection> | undefined,
): WorkflowConnection | undefined {
  return page?.items?.[0];
}

/**
 * Pick the redacted secret descriptor linked to a connection — by `secretId`, else by `connectionId`.
 * `secrets` is the page's `items` array (pass `page?.items`), or `undefined` while loading.
 */
export function secretForConnection(
  connection: WorkflowConnection,
  secrets: WorkflowSecret[] | undefined,
): WorkflowSecret | undefined {
  if (!secrets) return undefined;
  if (connection.secretId) {
    const byId = secrets.find((s) => s.id === connection.secretId);
    if (byId) return byId;
  }
  return secrets.find((s) => s.connectionId === connection.id);
}
