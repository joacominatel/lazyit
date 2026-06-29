import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import type {
  AttachInfraSecret,
  ConfirmInfraNode,
  CreateInfraEdge,
  InfraEdge,
  InfraImpactResponse,
  InfraNode,
  InfraNodeDetail,
  InfraNodeListItem,
  UpdateInfraNode,
} from "@lazyit/shared";
import {
  attachInfraNodeSecret,
  closeInfraEdge,
  confirmInfraNode,
  createInfraEdge,
  createInfraNode,
  type CreateInfraNodeInput,
  deleteInfraNode,
  detachInfraNodeSecret,
  getInfraNodeDetail,
  getInfraNodeEdges,
  getInfraNodeEdgesHistory,
  getInfraNodeImpact,
  getInfraNodes,
  type InfraNodeFilters,
  restoreInfraNode,
  updateInfraNode,
  updateInfraNodePosition,
} from "../endpoints/infra";

/**
 * Query keys + read/write hooks for the infra topology canvas + drill-in panel (ADR-0070, issues
 * #741 + #742).
 *
 * Hand-written (not `createQueryKeys`) for the canvas's bespoke shapes: a filtered node list, a
 * PER-NODE edge list (the API has no global edges endpoint), the enriched per-node `detail`, and a
 * per-node edge `history` (active + closed). Every mutation invalidates `infraKeys.all`, which
 * prefix-matches all `["infra", …]` keys — so a create/edit/delete/edge write refreshes the canvas
 * node list, the open panel's detail, and its edge lists in one call (TanStack Query v5 prefix match).
 */
export const infraKeys = {
  all: ["infra"] as const,
  nodes: (filters: InfraNodeFilters) =>
    [...infraKeys.all, "nodes", filters] as const,
  edges: (nodeId: string) => [...infraKeys.all, "edges", nodeId] as const,
  detail: (nodeId: string) => [...infraKeys.all, "detail", nodeId] as const,
  edgeHistory: (nodeId: string) =>
    [...infraKeys.all, "edgeHistory", nodeId] as const,
  impact: (nodeId: string) => [...infraKeys.all, "impact", nodeId] as const,
};

/** List topology nodes, optionally filtered. The canvas keeps the fetch client-side (React Flow is
 * client-only — no SSR prefetch, per #741).
 *
 * `options` exposes just the two react-query knobs the agent-onboarding live-wait needs (ADR-0074
 * §3 / #831): `enabled` to fire the poll only while the wizard's "waiting" step is open, and
 * `refetchInterval` to poll the PENDING list every few seconds until the freshly-installed host
 * checks in. Per-observer, so it never forces a refetch interval on the table/tray that share the key. */
export function useInfraNodes(
  filters: InfraNodeFilters = {},
  options?: { enabled?: boolean; refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: infraKeys.nodes(filters),
    queryFn: ({ signal }) => getInfraNodes(filters, signal),
    ...options,
  });
}

/**
 * Resolve the topology node backing an asset, for the Assets screen's "On topology" badge + "View in
 * topology" deep-link (issue #765). ponytail: rather than a bespoke `?assetId=` endpoint, reuse the
 * already-cached node list (`useInfraNodes`) and find the match client-side — the estate is small by
 * design (ADR-0070), so the whole list is cheap to hold and scan. `enabled` gates the fetch on
 * `infra:read` so a viewer without topology access never fires a 403 (the badge simply won't show).
 *
 * Returns the matched node id (or null when the asset doesn't back one), so callers build the link
 * from a bare id without re-deriving the lookup.
 */
export function useAssetInfraNodeId(
  assetId: string,
  enabled: boolean,
): string | null {
  const { data } = useQuery({
    queryKey: infraKeys.nodes({}),
    queryFn: ({ signal }) => getInfraNodes({}, signal),
    enabled,
  });
  return data?.find((node) => node.assetId === assetId)?.id ?? null;
}

/**
 * The set of asset ids that back a topology node — for the Assets LIST glyph (issue #765). Shares the
 * exact same cached node list as {@link useAssetInfraNodeId} (one `["infra","nodes",{}]` query), so a
 * list → detail navigation reuses the fetch. `enabled` gates it on `infra:read`. Returns an empty Set
 * while loading / when gated off, so the caller's `has()` check is a safe no-op.
 */
export function useAssetsOnTopology(enabled: boolean): ReadonlySet<string> {
  const { data } = useQuery({
    queryKey: infraKeys.nodes({}),
    queryFn: ({ signal }) => getInfraNodes({}, signal),
    enabled,
  });
  return useMemo(() => {
    const ids = new Set<string>();
    for (const node of data ?? []) if (node.assetId) ids.add(node.assetId);
    return ids;
  }, [data]);
}

/**
 * Assemble the whole graph's edges from the loaded nodes. The API exposes edges only per-node
 * (`GET /infra/nodes/:id/edges`), so we fan one query out per node via `useQueries` and dedupe by
 * edge id (an edge touching two loaded nodes is returned by both).
 *
 * ponytail: a per-node fan-out, not a bespoke batch endpoint — the estate is small by design
 * (ADR-0070), each query is individually cached/invalidated, and `useQueries` already shares the
 * one client. `enabled` gates each on its node id so nothing fires before the node list resolves.
 *
 * Surfaces `isError` (true if ANY per-node edge query failed) and an aggregate `refetch` so the
 * canvas can flag — and retry — a partial fetch instead of silently dropping relationships: a failed
 * edge fetch would otherwise render the touched nodes as "disconnected" with no cue (issue #778).
 */
export function useInfraEdges(nodeIds: string[]): {
  edges: InfraEdge[];
  isLoading: boolean;
  isError: boolean;
  refetch: () => void;
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
    // Any per-node failure means some relationships are missing from the graph above.
    isError: results.some((r) => r.isError),
    // Re-run every per-node edge query; a successful retry flips `isError` back to false (the canvas
    // notice auto-clears). Fresh closure per render is fine — it's only called from the retry click.
    refetch: () => {
      for (const result of results) void result.refetch();
    },
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
      // position without a round-trip. The list cache holds enriched `InfraNodeListItem`s (assetName
      // + owners); the spread preserves them — only x/y change. Cheap: the lists are small.
      queryClient.setQueriesData<InfraNodeListItem[]>(
        { queryKey: [...infraKeys.all, "nodes"] },
        (prev) =>
          prev?.map((n) => (n.id === node.id ? { ...n, x: node.x, y: node.y } : n)),
      );
    },
  });
}

// ── Drill-in detail + edge history (ADR-0070 §6, issue #742) ───────────────────────────────────────

/**
 * The enriched drill-in for the selected node (`GET /infra/nodes/:id`) — owners, KB links, secret
 * HANDLES (never values, INV-10), shortcuts, IP, and the children list (active inverse RUNS_ON). The
 * panel passes the selected id; `enabled` gates the fetch so nothing fires until a node is selected.
 */
export function useInfraNodeDetail(nodeId: string | null) {
  return useQuery({
    queryKey: infraKeys.detail(nodeId ?? ""),
    queryFn: ({ signal }) => getInfraNodeDetail(nodeId as string, signal),
    enabled: Boolean(nodeId),
  });
}

/**
 * A node's full edge history (active + closed) for the panel's edge manager (`?active=false`). The
 * canvas's `useInfraEdges` reads active-only to draw the live graph; this read shows migrations (a
 * closed RUNS_ON) so an operator understands the host history. `enabled` gates it on a selected node.
 */
export function useInfraNodeEdgesHistory(nodeId: string | null) {
  return useQuery({
    queryKey: infraKeys.edgeHistory(nodeId ?? ""),
    queryFn: ({ signal }) => getInfraNodeEdgesHistory(nodeId as string, signal),
    enabled: Boolean(nodeId),
  });
}

/**
 * Blast radius for the selected node (`GET /infra/nodes/:id/impact`, ADR-0070 §7, issue #755) — the
 * downstream set affected if it goes down, each with its hop `depth`. `enabled` gates the fetch on
 * BOTH a selected node and impact mode being on, so the query fires only when the operator asks for
 * the blast radius — toggling off / selecting another node clears it (a fresh per-node key). The
 * canvas derives its highlight/dim from `affected` + `rootId`.
 */
export function useInfraImpact(nodeId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: infraKeys.impact(nodeId ?? ""),
    queryFn: ({ signal }) => getInfraNodeImpact(nodeId as string, signal),
    enabled: enabled && Boolean(nodeId),
  });
}

// ── Write mutations (ADR-0070 §5/§3 lifecycle, issue #742) ─────────────────────────────────────────
//
// All write mutations share one shape: invalidate `infraKeys.all` on success so the canvas list, the
// open panel's detail and every per-node edge list refresh together (prefix match). They expose
// `mutate`/`mutateAsync` so callers own their own toast + close on success / `notifyError` on failure
// (the app-wide dialog/form convention) — including the friendly RUNS_ON / duplicate-pair 409 the
// edge API returns as a plain message.

/** Create a node (`POST /infra/nodes`); asset-backed by default via the `trackAsAsset` flag (§5). */
export function useCreateInfraNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInfraNodeInput) => createInfraNode(input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infraKeys.all }),
  });
}

/**
 * Patch a node (`PATCH /infra/nodes/:id`) — the lifecycle status toggle, label/kind/ip/shortcut
 * edits, and `assetId: null` detach (§5). One hook for every node edit; the caller passes the patch.
 */
export function useUpdateInfraNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateInfraNode }) =>
      updateInfraNode(id, patch),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infraKeys.all }),
  });
}

/** Soft-delete a node (`DELETE /infra/nodes/:id`) — off the map, history kept (§5). */
export function useDeleteInfraNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteInfraNode(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infraKeys.all }),
  });
}

/** Restore a soft-deleted node (`POST /infra/nodes/:id/restore`) — back onto the map. */
export function useRestoreInfraNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => restoreInfraNode(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infraKeys.all }),
  });
}

/**
 * Confirm a PENDING agent-reported node from the review tray (`POST /infra/nodes/:id/confirm`,
 * ADR-0074 §3). `trackAsAsset` (default true) mints the backing Asset; optional `kind`/`label` override
 * re-classify/rename at confirm. Invalidates `infraKeys.all` so the pending tray drops the node (now
 * CONFIRMED) and the canvas/table refresh. The caller owns its own toast/close + `notifyError`.
 */
export function useConfirmInfraNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, body }: { id: string; body: ConfirmInfraNode }) =>
      confirmInfraNode(id, body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infraKeys.all }),
  });
}

/**
 * Open an edge (`POST /infra/edges`). The API canonicalizes CONNECTS_TO, migrates RUNS_ON, and may
 * 409 on the one-active-host / duplicate-pair invariant — the caller toasts that message verbatim via
 * `notifyError`. Invalidates `infraKeys.all` so both endpoints' edge lists + the canvas refresh.
 */
export function useCreateInfraEdge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateInfraEdge) => createInfraEdge(input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infraKeys.all }),
  });
}

/** Close an edge (`POST /infra/edges/:id/close`) — the ADR-0019 migration/lifecycle marker. */
export function useCloseInfraEdge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => closeInfraEdge(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infraKeys.all }),
  });
}

/**
 * Attach a secret HANDLE reference to a node (`POST /infra/nodes/:id/secrets`, ADR-0073 / #801). The
 * API gates on infra:manage + secret:read + live vault membership and may 403/404 — the caller toasts
 * that friendly message verbatim via `notifyError`. Invalidates `infraKeys.all` so the open panel's
 * detail refreshes with the returned `secretRefs`.
 */
export function useAttachInfraSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, handle, vaultId }: { id: string } & AttachInfraSecret) =>
      attachInfraNodeSecret(id, { handle, vaultId }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infraKeys.all }),
  });
}

/**
 * Detach a secret HANDLE reference from a node (`DELETE /infra/nodes/:id/secrets`, ADR-0073). A
 * topology edit (infra:manage only); idempotent. Invalidates `infraKeys.all` so the open panel's
 * detail refreshes with the returned `secretRefs`.
 */
export function useDetachInfraSecret() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, handle, vaultId }: { id: string } & AttachInfraSecret) =>
      detachInfraNodeSecret(id, { handle, vaultId }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infraKeys.all }),
  });
}

// Re-export the detail/edge/impact wire types so panel components can import them from the hook
// module (the single place the next Servers-list agent reuses) without reaching into endpoints.
export type { InfraNodeDetail, InfraEdge, InfraImpactResponse };
