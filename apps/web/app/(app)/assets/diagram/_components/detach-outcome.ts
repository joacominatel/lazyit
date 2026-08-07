/**
 * WHICH detach a `PATCH { assetId: null }` is about to run (issue #1202).
 *
 * The API's detach (ADR-0070 §5, ADR-0093 §4) branches on one fact — whether the linked Asset carries
 * the `_infraAutoCreated` provenance marker:
 *
 * - **marked** → lazyit minted that Asset when the node was created or confirmed, so the detach
 *   **soft-deletes** it: a `DELETED` history event, dropped from Meilisearch, gone from the live
 *   inventory list. The row never lingers in inventory owned by nobody.
 * - **unmarked** → a human curated (or lazyit adopted) that Asset, and the marker is deliberately
 *   never stamped on the adopt branch precisely so this can never delete someone's row. The detach
 *   nulls `InfraNode.assetId` and the Asset is untouched.
 *
 * Both arms leave the node on the map. The difference is entirely on the inventory side, which is why
 * the operator has to be told which one they are looking at BEFORE they commit — the confirmation
 * dialog picks its whole tone, title and body from this one token.
 *
 * **The `null`/`undefined` arm is the load-bearing one.** `assetAutoCreated` is `.nullish()` on the
 * wire: an API older than #1202 omits it, and the server reports null when the linked Asset row could
 * not be resolved. Both resolve to `"archives"` — the destructive copy — because an unknown provenance
 * is exactly the state in which a dialog must not promise that nothing will be deleted. The failure
 * mode of over-warning is a confused operator; the failure mode of under-warning is an inventory row
 * archived by someone who was told it would survive.
 *
 * Pure and framework-free so it is reachable by `bun test` (ADR-0012 — apps/web has no component
 * harness, so a branch left inline in JSX is a branch nothing tests).
 */

/** The two outcomes a detach can have, from the operator's point of view. */
export type DetachOutcome = "archives" | "unlinks";

/**
 * Resolve the detach outcome from the server's `assetAutoCreated` projection.
 *
 * @param assetAutoCreated `InfraNodeDetail.assetAutoCreated` — `true` when the linked Asset carries
 *   the auto-created marker, `false` when it does not, `null`/`undefined` when the server did not or
 *   could not say (a pre-#1202 API, or a linked Asset row that is gone).
 * @returns `"unlinks"` ONLY on an explicit `false`; `"archives"` for everything else.
 */
export function detachOutcome(
  assetAutoCreated: boolean | null | undefined,
): DetachOutcome {
  // Written as "safe requires a positive answer" rather than "destructive requires true", so a future
  // third wire state (or a dropped field) lands on the cautious arm by construction, not by luck.
  return assetAutoCreated === false ? "unlinks" : "archives";
}
