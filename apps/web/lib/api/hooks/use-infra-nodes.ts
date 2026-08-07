import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import { MAX_PAGE_LIMIT } from "@lazyit/shared";
import type {
  AttachInfraSecret,
  BulkConfirmInfraNodes,
  BulkDiscardInfraNodes,
  ConfirmInfraNode,
  CreateInfraAutoConfirmRule,
  InfraAutoConfirmRule,
  InfraBulkResponse,
  UpdateInfraAutoConfirmRule,
  CreateInfraEdge,
  InfraEdge,
  InfraGraph,
  InfraImpactResponse,
  InfraNode,
  InfraNodeDetail,
  InfraNodeListPage,
  UpdateInfraNode,
} from "@lazyit/shared";
import {
  attachInfraNodeSecret,
  bulkConfirmInfraNodes,
  bulkDiscardInfraNodes,
  closeInfraEdge,
  createInfraAutoConfirmRule,
  deleteInfraAutoConfirmRule,
  getInfraAutoConfirmRules,
  updateInfraAutoConfirmRule,
  confirmInfraNode,
  createInfraEdge,
  createInfraNode,
  type CreateInfraNodeInput,
  deleteInfraNode,
  detachInfraNodeSecret,
  getInfraNodeChanges,
  getInfraNodeDetail,
  getInfraNodeEdges,
  getInfraNodeEdgesHistory,
  getInfraNodeIdentityMatches,
  getInfraNodeImpact,
  getInfraNodes,
  getInfraGraphNodes,
  type InfraNodeListParams,
  mergeInfraNodeInto,
  restoreInfraNode,
  updateInfraNode,
  updateInfraNodePosition,
} from "../endpoints/infra";

/**
 * Query keys + read/write hooks for the infra topology canvas + drill-in panel (ADR-0070, issues
 * #741 + #742).
 *
 * Hand-written (not `createQueryKeys`) for the canvas's bespoke shapes: a PAGED node list, the
 * canvas's own whole-graph read, an exact asset→node batch resolve, a PER-NODE edge list (the API has
 * no global edges endpoint), the enriched per-node `detail`, and a per-node edge `history` (active +
 * closed). Every mutation invalidates `infraKeys.all`, which prefix-matches all `["infra", …]` keys —
 * so a create/edit/delete/edge write refreshes every node page, the graph, the open panel's detail
 * and its edge lists in one call (TanStack Query v5 prefix match). That prefix match is why
 * `infraKeys.graph()` and `infraKeys.assetNodes()` are built from `infraKeys.all` rather than being
 * standalone keys: a write must never leave one node surface stale beside a refreshed one.
 */
/**
 * Modest background poll (issue #1081) for the live node surfaces — the pending tray, the Servers
 * table and the topology canvas — so a discovered host's `lastReportedAt`/status/IP refresh without a
 * manual reload. 40s is far coarser than the agent report cadence (a liveness bit, not a metric) and
 * separate from the wizard's transient 5s onboarding poll, which passes its own interval.
 */
export const INFRA_LIVE_POLL_MS = 40_000;

export const infraKeys = {
  all: ["infra"] as const,
  nodes: (params: InfraNodeListParams) =>
    [...infraKeys.all, "nodes", params] as const,
  /**
   * The topology canvas's own read (`GET /infra/graph/nodes`, #1152). A SIBLING of `nodes`, not a
   * variant of it: it is a different endpoint with a different shape, and giving it its own key is
   * what keeps a page write from being mistaken for a graph write. It still sits under
   * `infraKeys.all`, so every mutation's `invalidateQueries({ queryKey: infraKeys.all })` prefix-
   * matches it and the board refreshes with everything else.
   */
  graph: () => [...infraKeys.all, "graph"] as const,
  /**
   * The exact asset→node resolve behind the Assets screen's "On topology" affordances (#765/#1152).
   * Its OWN key, never the canvas's: these are `?assetIds=` batch reads whose result set is a handful
   * of rows, and sharing a cache entry with a surface that means "the whole board" is how a lookup
   * ends up quietly answering from a window.
   */
  assetNodes: (assetIds: string[]) =>
    [...infraKeys.all, "assetNodes", assetIds] as const,
  edges: (nodeId: string) => [...infraKeys.all, "edges", nodeId] as const,
  detail: (nodeId: string) => [...infraKeys.all, "detail", nodeId] as const,
  edgeHistory: (nodeId: string) =>
    [...infraKeys.all, "edgeHistory", nodeId] as const,
  impact: (nodeId: string) => [...infraKeys.all, "impact", nodeId] as const,
  changes: (nodeId: string) => [...infraKeys.all, "changes", nodeId] as const,
  identityMatches: (nodeId: string) =>
    [...infraKeys.all, "identityMatches", nodeId] as const,
  autoConfirmRules: () => [...infraKeys.all, "autoConfirmRules"] as const,
};

/**
 * A PAGE of topology nodes (`GET /infra/nodes`, ADR-0030 / #1152). The canvas keeps the fetch
 * client-side (React Flow is client-only — no SSR prefetch, per #741).
 *
 * Returns the `{ items, total, limit, offset }` envelope, NOT a bare array. Every caller reads
 * `.items` for rows and `.total` for any count it shows — those two are different numbers the moment
 * the estate outgrows one page, and conflating them is how a tray of 431 proposals renders as 200.
 *
 * `placeholderData: keepPreviousData` holds the current page while the next one resolves, so paging
 * and searching never flash the skeleton — the same treatment every other paginated list hook gets.
 *
 * `options` exposes the two react-query knobs the live surfaces need (ADR-0074 §3 / #831): `enabled`
 * to fire a poll only while the wizard's "waiting" step is open, and `refetchInterval` to poll until
 * a freshly-installed host checks in. Per-observer, so it never forces an interval on another
 * consumer that happens to share the key.
 */
export function useInfraNodes(
  params: InfraNodeListParams = {},
  options?: { enabled?: boolean; refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: infraKeys.nodes(params),
    queryFn: ({ signal }) => getInfraNodes(params, signal),
    placeholderData: keepPreviousData,
    ...options,
  });
}

/**
 * The whole topology graph for the canvas (`GET /infra/graph/nodes`, #1152) — the narrow projection
 * the board draws, complete by default and bounded at `INFRA_GRAPH_NODES_MAX`.
 *
 * Its own endpoint rather than `useInfraNodes({ limit: 200 })` because 200 sits BELOW the ADR-0095
 * per-host guest ceiling of 500: one ordinary Proxmox host would have pushed nodes off the map with
 * nothing on screen saying so. The caller MUST render `truncated` — see `node-page-state.ts`.
 */
export function useInfraGraphNodes(options?: {
  enabled?: boolean;
  refetchInterval?: number | false;
}) {
  return useQuery({
    queryKey: infraKeys.graph(),
    queryFn: ({ signal }) => getInfraGraphNodes(signal),
    ...options,
  });
}

/**
 * Resolve the topology node backing ONE asset, for the Assets detail screen's "View in topology"
 * deep-link (issue #765). EXACT since #1152: a one-row `?assetIds=<id>&limit=1` ask, answered by the
 * database, instead of the old whole-list fetch scanned in memory on the claim that "the estate is
 * small by design". That claim was already false for a Proxmox estate, and the failure mode it hid
 * was the quiet one — the button simply not appearing for an asset past the window.
 *
 * `enabled` gates the fetch on `infra:read` so a viewer without topology access never fires a 403
 * (the affordance simply won't show). Returns the matched node id, or null when the asset doesn't
 * back one, so callers build the link from a bare id without re-deriving the lookup.
 */
export function useAssetInfraNodeId(
  assetId: string,
  enabled: boolean,
): string | null {
  const assetIds = useMemo(() => [assetId], [assetId]);
  const { data } = useQuery({
    queryKey: infraKeys.assetNodes(assetIds),
    queryFn: ({ signal }) => getInfraNodes({ assetIds, limit: 1 }, signal),
    enabled: enabled && Boolean(assetId),
  });
  return data?.items[0]?.id ?? null;
}

/** Stable empty result so a gated-off / still-loading caller's `has()` is a no-op with a fixed identity. */
const EMPTY_ASSET_IDS: ReadonlySet<string> = new Set();

/**
 * Which of THESE assets back a topology node — the "On topology" glyph on the Assets list (#765),
 * made exact in #1152.
 *
 * It used to fetch the entire node list and scan it. That is the pattern ADR-0030 §6 / #961 removed
 * from `useUserNames`, for the same reason: a whole-directory read materializes one window and then
 * degrades SILENTLY for everything past it — the glyph would just stop appearing, and no operator
 * would ever know a row was mislabelled rather than unlinked. So this is now a bounded BATCH RESOLVE
 * over the VISIBLE page: the caller passes the asset ids it is actually rendering, and the API
 * answers for exactly those (`?assetIds=a,b,c`, the `GET /users?ids=` precedent). A page never
 * exceeds `MAX_PAGE_LIMIT` rows, so one page of results always covers one page of assets.
 *
 * The ids are de-duplicated and SORTED into the query key so re-render order can't churn the key.
 * `enabled` gates it on `infra:read` AND on there being anything to resolve.
 */
export function useAssetsOnTopology(
  assetIds: string[],
  enabled: boolean,
): ReadonlySet<string> {
  const uniqueIds = useMemo(
    () => [...new Set(assetIds)].sort().slice(0, MAX_PAGE_LIMIT),
    [assetIds],
  );
  const { data } = useQuery({
    queryKey: infraKeys.assetNodes(uniqueIds),
    queryFn: ({ signal }) =>
      getInfraNodes({ assetIds: uniqueIds, limit: MAX_PAGE_LIMIT }, signal),
    enabled: enabled && uniqueIds.length > 0,
  });
  return useMemo(() => {
    if (!data) return EMPTY_ASSET_IDS;
    const ids = new Set<string>();
    for (const node of data.items) if (node.assetId) ids.add(node.assetId);
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
      // Write through to BOTH cached shapes (#1152) — they are two different endpoints now, and the
      // one the operator is looking at while dragging is the GRAPH.
      //
      // Missing the graph entry is not a stale-cache nicety: the canvas re-syncs React Flow from this
      // query, so a dropped node would snap back to its old position until the next 40s poll landed —
      // the drag visibly undoing itself.
      //
      // Both writers preserve the envelope and map over `items`; the spread keeps every other field
      // (the page rows carry `assetName` + `owners`, the graph rows carry `chassis`) so only x/y move.
      queryClient.setQueriesData<InfraNodeListPage>(
        { queryKey: [...infraKeys.all, "nodes"] },
        (prev) =>
          prev && {
            ...prev,
            items: prev.items.map((n) =>
              n.id === node.id ? { ...n, x: node.x, y: node.y } : n,
            ),
          },
      );
      queryClient.setQueriesData<InfraGraph>(
        { queryKey: infraKeys.graph() },
        (prev) =>
          prev && {
            ...prev,
            items: prev.items.map((n) =>
              n.id === node.id ? { ...n, x: node.x, y: node.y } : n,
            ),
          },
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

/** Per-page size for the Changes tab. The API clamps anything larger to its own ceiling. */
const CHANGES_PAGE_SIZE = 50;

/**
 * A node's recorded fact history (`GET /infra/nodes/:id/changes`, ADR-0074 §3 amendment, #1143) —
 * what MOVED, newest first, paged on the append-only autoincrement id.
 *
 * `enabled` gates the fetch on a selected node AND on the Changes tab being the OPEN one, so opening
 * the panel fetches nothing until the operator asks for the history. That second gate is explicit
 * rather than leaning on the tab primitive unmounting its inactive content: a `forceMount` added to
 * the panel later would silently turn this into a fetch on every panel open, and a query nobody asked
 * for is exactly the kind of cost that arrives without anyone deciding to pay it.
 *
 * The key sits under `infraKeys.all`, so the ordinary mutation invalidation refreshes it with
 * everything else — though nothing a human does in the panel writes to this table: only the agent
 * ingest path appends to it.
 */
export function useInfraNodeChanges(nodeId: string | null, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: infraKeys.changes(nodeId ?? ""),
    queryFn: ({ pageParam, signal }) =>
      getInfraNodeChanges(
        nodeId as string,
        {
          limit: CHANGES_PAGE_SIZE,
          ...(pageParam !== undefined ? { cursor: pageParam } : {}),
        },
        signal,
      ),
    enabled: enabled && Boolean(nodeId),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
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
 * Re-key a duplicate into an existing node (`POST /infra/nodes/:id/merge-into`, ADR-0074 §3 / #1141)
 * — the adoption path for a re-imaged host and the remedy for a cloned machine-id. Invalidates
 * `infraKeys.all` so the tray drops the archived duplicate and the adopting node picks up the
 * transplanted reporting key in the same pass. The caller owns its toast/close + `notifyError` (the
 * API 400s a self-merge and a source with no reporting key with a plain message).
 */
export function useMergeInfraNode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, targetNodeId }: { id: string; targetNodeId: string }) =>
      mergeInfraNodeInto(id, { targetNodeId }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infraKeys.all }),
  });
}

/**
 * Adoption hints for one node (`GET /infra/nodes/:id/identity-matches`, #1141) — the live nodes that
 * share a burned-in serial or MAC with it. Deliberately NOT on the tray's live poll: identity evidence
 * only changes when a host is re-imaged or re-cabled, so re-fetching it every 40 seconds would pay for
 * a jsonb containment scan to learn nothing. `enabled` gates it so a closed dialog fetches nothing.
 */
export function useInfraIdentityMatches(nodeId: string | null, enabled = true) {
  return useQuery({
    queryKey: infraKeys.identityMatches(nodeId ?? ""),
    queryFn: ({ signal }) =>
      getInfraNodeIdentityMatches(nodeId as string, signal),
    enabled: enabled && Boolean(nodeId),
  });
}

// ── The review tray at scale (ADR-0074 §1 amendment, #1145) ────────────────────────────────────────

/**
 * Confirm many PENDING proposals at once (`POST /infra/nodes/bulk-confirm`). Invalidates
 * `infraKeys.all` so the tray drops every confirmed row and the canvas/table refresh in one pass.
 *
 * It RESOLVES on a partial batch — the API answers per item — so the caller must read the response
 * rather than treat "no throw" as "all forty landed". `notifyError` still covers a whole-request
 * failure (a 403, a network drop).
 */
export function useBulkConfirmInfraNodes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: BulkConfirmInfraNodes): Promise<InfraBulkResponse> =>
      bulkConfirmInfraNodes(body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infraKeys.all }),
  });
}

/** Discard many proposals at once (`POST /infra/nodes/bulk-discard`) — soft delete, restorable. */
export function useBulkDiscardInfraNodes() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: BulkDiscardInfraNodes): Promise<InfraBulkResponse> =>
      bulkDiscardInfraNodes(body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infraKeys.all }),
  });
}

/**
 * The saved auto-confirm rules, oldest first — the order the server evaluates them in (first match
 * wins), so the list renders in evaluation order without re-sorting.
 *
 * `enabled` is React Query's own gate and says nothing about permissions: the one caller passes the
 * rules DIALOG's open state, so nothing is fetched until an operator opens it — a management surface
 * behind a button should not poll on every tray render. The permission side is already covered
 * upstream, by the tray that hosts the dialog rendering nothing without `infra:manage`, which is
 * stricter than the `infra:read` the route itself requires.
 */
export function useInfraAutoConfirmRules(enabled = true) {
  return useQuery({
    queryKey: infraKeys.autoConfirmRules(),
    queryFn: ({ signal }) => getInfraAutoConfirmRules(signal),
    enabled,
  });
}

/** Save a rule. It applies only to reports arriving AFTER it is saved — the UI says so explicitly. */
export function useCreateInfraAutoConfirmRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateInfraAutoConfirmRule): Promise<InfraAutoConfirmRule> =>
      createInfraAutoConfirmRule(body),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infraKeys.autoConfirmRules() }),
  });
}

/** Patch a rule — the `enabled` toggle is the fastest revocation (it stops matching immediately). */
export function useUpdateInfraAutoConfirmRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateInfraAutoConfirmRule }) =>
      updateInfraAutoConfirmRule(id, patch),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infraKeys.autoConfirmRules() }),
  });
}

/** Delete a rule (soft delete). Nodes it already confirmed stay confirmed — nothing is reverted. */
export function useDeleteInfraAutoConfirmRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteInfraAutoConfirmRule(id),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: infraKeys.autoConfirmRules() }),
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
