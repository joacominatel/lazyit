import { useQuery } from "@tanstack/react-query";
import { getAgentFleet } from "../endpoints/infra";
import { infraKeys } from "./use-infra-nodes";

/**
 * The agent fleet read (ADR-0094 §4, issue #1207) — the one request behind the Agents view on
 * Topology: the version distribution, every agent-bearing host, and the credentials that have never
 * been used.
 *
 * Keyed under the existing `infra` namespace so it is invalidated by the same writes that already
 * change what it says: confirming a discovered host, merging two nodes or discarding a proposal all
 * move rows in and out of this table, and every one of those mutations already invalidates
 * `infraKeys.all`.
 *
 * NOT polled, deliberately. The node list next door polls every 5–40s because the Map is a live
 * board; this is a page an operator opens, reads, and copies a command out of — and the read is the
 * heavier one, projecting two paths out of each node's `specs` blob per row (#1135 is why that blob
 * is off the list projection at all). A `staleTime` of a minute keeps a Map↔Table↔Agents switch from
 * re-fetching, and the view offers a manual refresh instead of deciding for the operator that a
 * fleet-wide read should run forever in a background tab.
 */
export const agentFleetKey = () => [...infraKeys.all, "agent-fleet"] as const;

/** How long the fleet read stays fresh. Version buckets move when a host re-reports, i.e. minutes. */
export const AGENT_FLEET_STALE_MS = 60_000;

export function useAgentFleet() {
  return useQuery({
    queryKey: agentFleetKey(),
    // Destructured rather than passed bare: `getAgentFleet` takes an AbortSignal, and handing it
    // TanStack's whole QueryFunctionContext would type-check as `unknown` and quietly send no signal.
    queryFn: ({ signal }) => getAgentFleet(signal),
    staleTime: AGENT_FLEET_STALE_MS,
  });
}
