import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { InfraEdge, InfraNode } from "@lazyit/shared";
import {
  getInfraNodeEdges,
  getInfraNodes,
  type InfraNodeFilters,
  updateInfraNodePosition,
} from "../endpoints/infra";

/**
 * Query keys + read/write hooks for the infra topology canvas (ADR-0070, issue #741).
 *
 * Hand-written (not `createQueryKeys`) for the canvas's two bespoke shapes: a filtered node list and
 * a PER-NODE edge list (the API has no global edges endpoint). Mutations invalidate `infraKeys.all`.
 */
export const infraKeys = {
  all: ["infra"] as const,
  nodes: (filters: InfraNodeFilters) =>
    [...infraKeys.all, "nodes", filters] as const,
  edges: (nodeId: string) => [...infraKeys.all, "edges", nodeId] as const,
};

/** List topology nodes, optionally filtered. The canvas keeps the fetch client-side (React Flow is
 * client-only — no SSR prefetch, per #741). */
export function useInfraNodes(filters: InfraNodeFilters = {}) {
  return useQuery({
    queryKey: infraKeys.nodes(filters),
    queryFn: ({ signal }) => getInfraNodes(filters, signal),
  });
}

/**
 * Assemble the whole graph's edges from the loaded nodes. The API exposes edges only per-node
 * (`GET /infra/nodes/:id/edges`), so we fan one query out per node via `useQueries` and dedupe by
 * edge id (an edge touching two loaded nodes is returned by both).
 *
 * ponytail: a per-node fan-out, not a bespoke batch endpoint — the estate is small by design
 * (ADR-0070), each query is individually cached/invalidated, and `useQueries` already shares the
 * one client. `enabled` gates each on its node id so nothing fires before the node list resolves.
 */
export function useInfraEdges(nodeIds: string[]): {
  edges: InfraEdge[];
  isLoading: boolean;
} {
  const results = useQueries({
    queries: nodeIds.map((nodeId) => ({
      queryKey: infraKeys.edges(nodeId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        getInfraNodeEdges(nodeId, signal),
      enabled: Boolean(nodeId),
    })),
  });

  const byId = new Map<string, InfraEdge>();
  for (const result of results) {
    for (const edge of result.data ?? []) byId.set(edge.id, edge);
  }

  return {
    edges: [...byId.values()],
    // Loading only matters before the first paint; once nodes exist we render edges as they arrive.
    isLoading: nodeIds.length > 0 && results.some((r) => r.isLoading),
  };
}

/**
 * Persist a node's canvas position after a drag settles (debounced by the caller). Optimistic by
 * design: the canvas already holds the dragged position in React Flow's local state, so on success
 * we only need to keep the cached node list in step (no refetch flash). On error the next list
 * refetch reconciles. Returns a `mutate(({ id, x, y }))` you call from the debounced drag-stop.
 */
export function useUpdateInfraNodePosition() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, x, y }: { id: string; x: number; y: number }) =>
      updateInfraNodePosition(id, x, y),
    onSuccess: (node: InfraNode) => {
      // Patch every cached node-list page that holds this node, so a later remount reads the saved
      // position without a round-trip. Cheap: the lists are small.
      queryClient.setQueriesData<InfraNode[]>(
        { queryKey: [...infraKeys.all, "nodes"] },
        (prev) =>
          prev?.map((n) => (n.id === node.id ? { ...n, x: node.x, y: node.y } : n)),
      );
    },
  });
}
