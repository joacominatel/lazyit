import { isEndpointChassis } from "@lazyit/shared";

/**
 * Endpoint routing for the topology canvas (ADR-0093 §5) — the pure core of "the map does not drown
 * at ~200 endpoints".
 *
 * **The canvas filters; the graph does not.** Everything here is a RENDERING decision about one
 * surface. Impact / blast-radius traversal, global search, the Servers table and every API read are
 * untouched: an endpoint stays fully in the CMDB, still reachable, still counted. It is simply not
 * drawn on the board unless the operator asks for it.
 *
 * Kept out of the component (and out of `canvas.ts`, which owns geometry and styling) so the rules
 * that decide what an operator does and does not see can be asserted rather than described —
 * `endpoints.test.ts` is the contract, and it is the only thing standing between a future refactor
 * and a host that silently vanishes from every surface.
 */

/**
 * The URL param backing the "Show endpoints" toggle. URL-backed, not component state, so the choice
 * survives a reload, a Back navigation and a Map↔Table switch — the `diagram-view.tsx` mold, where
 * `?view` and `?focus` already live.
 */
export const SHOW_ENDPOINTS_PARAM = "endpoints";

/** The one value that turns endpoints back on. Anything else is the default (hidden). */
export const SHOW_ENDPOINTS_VALUE = "1";

/**
 * Read the toggle out of the URL. Deliberately total and deliberately biased toward the DEFAULT: any
 * value other than `1` — a typo, a tampered link, a stale bookmark from a future release — degrades
 * to "endpoints hidden" rather than erroring, exactly as `?view` degrades to the Map.
 */
export function showEndpointsFromParam(raw: string | null | undefined): boolean {
  return raw === SHOW_ENDPOINTS_VALUE;
}

/** What the canvas draws, and how many rows the filter took off the board. */
export interface EndpointPartition<TNode> {
  /** The nodes to render — every node when the toggle is on, the non-endpoints when it is off. */
  visible: TNode[];
  /**
   * How many of the input nodes are endpoints, whether or not they are currently hidden. The toolbar
   * needs both arms of this: the count to SAY how many are hidden, and its existence to know whether
   * the control is worth rendering at all on an estate that reports no endpoints.
   */
  endpointCount: number;
}

/**
 * Split the fetched rows into what the board draws and how many endpoints exist (ADR-0093 §5).
 *
 * Client-side over the rows the canvas already fetched: `chassis` is a scalar on the list row
 * (`InfraNodeListItemSchema` omits only `specs`), so there is no second request, no second cache
 * entry, and the toggle is instant.
 *
 * The endpoint test is {@link isEndpointChassis} — imported, never re-derived here. That helper owns
 * the one rule this whole treatment rests on: **no signal is not an endpoint.** A node with `chassis`
 * absent (a manual node, a pre-v2 agent, a row that predates the column and has not re-reported yet),
 * `null`, or the explicit `unknown` stays on the map. Routing may only ever remove noise a POSITIVE
 * fact identified; a host that silently disappears is worse than a noisy map.
 */
export function partitionEndpoints<TNode extends { chassis?: string | null }>(
  nodes: readonly TNode[],
  showEndpoints: boolean,
): EndpointPartition<TNode> {
  let endpointCount = 0;
  const visible: TNode[] = [];
  for (const node of nodes) {
    if (isEndpointChassis(node.chassis)) {
      endpointCount += 1;
      if (showEndpoints) visible.push(node);
    } else {
      visible.push(node);
    }
  }
  return { visible, endpointCount };
}

/**
 * Drop the edges whose endpoints are not both on the board — "a hidden node takes its edges with it,
 * on that surface only" (ADR-0093 §5).
 *
 * Mechanically necessary as well as correct: React Flow warns (and draws nothing useful) for an edge
 * naming a node it does not have. The edge QUERY is left alone on purpose — it still fans out over
 * every node id, so toggling endpoints back on redraws from cache instead of re-fetching, and the
 * graph the API serves never learns that a surface is hiding something.
 */
export function edgesBetweenVisible<
  TEdge extends { sourceId: string; targetId: string },
>(edges: readonly TEdge[], visibleNodeIds: ReadonlySet<string>): TEdge[] {
  return edges.filter(
    (edge) =>
      visibleNodeIds.has(edge.sourceId) && visibleNodeIds.has(edge.targetId),
  );
}
