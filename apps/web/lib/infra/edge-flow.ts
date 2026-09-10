import type { InfraNodeStatus } from "@lazyit/shared";

/**
 * The decorative "packet flow" on topology edges (issue #1295) — the pure rules for WHEN a line
 * moves, kept out of the component so they can be asserted rather than described.
 *
 * **This is decoration, not telemetry.** The motion exists because a map of a live estate reads
 * better with a hint of traffic on it; nothing here queries, measures or claims anything about real
 * packets. The only thing it is allowed to react to is the liveness lazyit already displays on the
 * node cards, and it reacts to it in the one direction that cannot mislead: a node lazyit has
 * positively marked **OFFLINE** stops its lines. Everything else keeps flowing.
 *
 * The Manual says the same thing out loud, and it has to: `OFFLINE` means "the agent has not
 * reported for ~45 minutes" — the agent staleness sweeper — so a machine powered off five
 * minutes ago is still drawn flowing. Read as ornament it is correct; read as a live wire it is a
 * lie, and the wrong lie to let an operator believe during an incident.
 */

/**
 * Above this many edges on the board, NOTHING animates.
 *
 * `stroke-dashoffset` is not a compositable property: every animated path is re-rasterised on the
 * main thread on every frame, so the cost scales linearly with the number of drawn edges and lands
 * squarely on the thread that also handles panning, zooming and dragging. A decorative effect must
 * never be the reason a board stutters under the operator's hand.
 *
 * 500 is chosen against the two numbers that bound this canvas. ADR-0093's reference estate is ~245
 * hosts, whose `RUNS_ON` / `MEMBER_OF` / `DEPENDS_ON` links sit comfortably under it — so the estate
 * this feature was asked for keeps its motion. The server's own ceiling is
 * `INFRA_GRAPH_EDGES_MAX = 10_000`, an order of magnitude above: an estate anywhere near the cap is
 * one where the canvas is already working hard to draw a static picture, and where a wall of
 * marching dashes would be noise rather than polish even if it were free.
 *
 * The cutoff is deliberately all-or-nothing rather than "animate the first 500": a board where an
 * arbitrary subset of lines moves reads as a rendering bug, not as a design.
 */
export const EDGE_FLOW_MAX_EDGES = 500;

/**
 * Whether the board is small enough to animate at all. Counted over the edges actually DRAWN (after
 * the endpoint filter), because those are the paths that repaint — hiding the workstations is
 * therefore also a way back under the cutoff.
 */
export function edgeFlowEnabled(drawnEdgeCount: number): boolean {
  return drawnEdgeCount <= EDGE_FLOW_MAX_EDGES;
}

/**
 * Whether one edge flows: **neither** endpoint is `OFFLINE`.
 *
 * The gate is `!== "OFFLINE"`, deliberately not `=== "ONLINE"`. A hand-added node defaults to
 * `UNKNOWN` (`InfraNode.status`), and so does every node on an estate that runs no agents at all —
 * a strict-ONLINE gate would leave a hand-built map completely static, which reads as broken rather
 * than as restrained. Only a POSITIVE offline fact stops a line, mirroring the `partitionEndpoints`
 * rule that only a positive chassis fact hides a node.
 *
 * Total by construction: an endpoint whose status is missing (a node the edge names but the board
 * does not have — which `edgesBetweenVisible` already makes impossible) is not a positive OFFLINE
 * fact, so it flows. The consequence of being wrong here is an ornament in the wrong state.
 */
export function edgeFlows(
  sourceStatus: InfraNodeStatus | undefined,
  targetStatus: InfraNodeStatus | undefined,
): boolean {
  return sourceStatus !== "OFFLINE" && targetStatus !== "OFFLINE";
}
