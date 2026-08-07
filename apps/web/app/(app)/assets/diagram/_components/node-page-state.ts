/**
 * The "this is not everything" notices for the two topology surfaces that can show a SUBSET
 * (issue #1152).
 *
 * Pure, and out of the components, for the same reason `tray-selection.ts` is: both of these are the
 * only thing standing between an operator and a screen that is quietly incomplete, and until now both
 * were promises made in prose. `GET /infra/nodes` is a page (ADR-0030) and `GET /infra/graph/nodes`
 * is bounded at `INFRA_GRAPH_NODES_MAX` — so either surface CAN legitimately hold less than the
 * estate. The rule the whole split exists to enforce is that when it does, it says so:
 *
 *   **no consumer may render a truncated view that looks complete.**
 *
 * A missing topology node is the worst of the two, because it takes its edges with it: the map does
 * not just lose a box, it loses a relationship, and an operator reading a blast radius off it gets a
 * smaller answer than the truth with no cue that anything was dropped. A short pending tray is nearly
 * as bad in the other direction — an ADR-0095 hypervisor can enrol up to 500 guests in one report, so
 * "200 rows" is a routine outcome there, and the header badge must read 431 rather than 200 or the
 * operator believes they finished when they cleared the screen.
 *
 * Both functions return `null` for "nothing to say", so a component renders a banner or renders
 * nothing — never a banner that reassures.
 */

/**
 * What the canvas must tell the operator about the completeness of the map, or `null` when the map is
 * complete and the question does not arise.
 */
export interface GraphTruncationNotice {
  /** How many nodes are drawn — the cap that was applied. */
  shown: number;
  /** How many live nodes exist. Always greater than {@link shown} when a notice exists at all. */
  total: number;
}

/**
 * Derive the canvas's truncation notice from the `InfraGraph` envelope.
 *
 * Driven by the server's `truncated` flag, NOT by comparing numbers ourselves: the flag is REQUIRED
 * on the wire precisely so a client cannot read "absent" as "fine", and re-deriving it here would put
 * a second opinion beside the authoritative one. `total === limit` with `truncated: false` is the
 * exact-fit case and is silent — an estate of precisely 2000 nodes is complete, not truncated.
 *
 * `shown` is reported as `limit` (the cap the server applied) rather than `items.length`, so the
 * sentence names the two numbers the envelope itself carries and stays true even if a caller filters
 * the drawn set afterwards (the endpoints toggle does exactly that, and its own count is separate).
 */
export function graphTruncationNotice(graph: {
  total: number;
  limit: number;
  truncated: boolean;
}): GraphTruncationNotice | null {
  if (!graph.truncated) return null;
  return { shown: graph.limit, total: graph.total };
}

/**
 * What the PENDING review tray must tell the operator about the batch it is showing, or `null` when
 * it is showing all of them.
 */
export interface PendingBatchNotice {
  /** Rows in this batch (`items.length`). */
  shown: number;
  /** Proposals awaiting review in total (`total`), which is what the header badge counts. */
  total: number;
}

/**
 * Derive the pending tray's batch notice from the page envelope's `total` and the rows in hand.
 *
 * Silent when `total === shown` (nothing is being held back) and when `shown` somehow exceeds `total`
 * (a torn read between a count and a page while reports land — inventing a negative "remaining" from
 * it would be noise, and the count is the one that will be right on the next poll).
 *
 * This is deliberately NOT the same trigger as the graph's: the tray has no `truncated` flag because
 * a page never claims to be complete. Its honesty comes from the two numbers disagreeing.
 */
export function pendingBatchNotice(page: {
  total: number;
  shown: number;
}): PendingBatchNotice | null {
  if (page.shown >= page.total) return null;
  return { shown: page.shown, total: page.total };
}
