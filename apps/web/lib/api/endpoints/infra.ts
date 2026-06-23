import type { InfraEdge, InfraNode } from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for the infra topology graph (ADR-0070). The canvas screen (issue #741) only needs
 * three reads/writes; the rich drill-in panel and the create/edge/lifecycle WRITE flows are a
 * separate issue (#742), so those endpoints (`POST /infra/nodes`, `POST /infra/edges`, the
 * `GET /infra/nodes/:id` detail) are intentionally NOT wired here yet.
 *
 * Edges are read PER-NODE (`GET /infra/nodes/:id/edges`) — the API has no global edges list. The
 * canvas fans those reads out across the loaded nodes and dedupes by edge id (see `use-infra-nodes`).
 */

const BASE = "/infra";

/**
 * Server-side filters for the node list. `kind`/`status`/`state` scope the result set; omit for all
 * confirmed nodes. The API excludes soft-deleted rows and returns a plain `InfraNode[]` (no page
 * envelope — the estate is small by design, ADR-0070).
 */
export interface InfraNodeFilters {
  kind?: InfraNode["kind"];
  status?: InfraNode["status"];
  state?: InfraNode["state"];
}

/** List topology nodes (`GET /infra/nodes`), optionally filtered. Newest first. */
export function getInfraNodes(
  filters: InfraNodeFilters = {},
  signal?: AbortSignal,
): Promise<InfraNode[]> {
  const params = new URLSearchParams();
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.status) params.set("status", filters.status);
  if (filters.state) params.set("state", filters.state);
  const qs = params.toString();
  return apiFetch<InfraNode[]>(qs ? `${BASE}/nodes?${qs}` : `${BASE}/nodes`, {
    signal,
  });
}

/**
 * A node's edges (`GET /infra/nodes/:id/edges`), active (open) only by default. The canvas calls
 * this once per node and dedupes by edge id to assemble the whole graph's edge set.
 */
export function getInfraNodeEdges(
  nodeId: string,
  signal?: AbortSignal,
): Promise<InfraEdge[]> {
  return apiFetch<InfraEdge[]>(`${BASE}/nodes/${nodeId}/edges`, { signal });
}

/**
 * Persist a node's canvas position (`PATCH /infra/nodes/:id/position`). Cheap and debounce-friendly
 * (ADR-0070 §6); the drag-stop handler trailing-debounces this so a drag persists once it settles.
 * Returns the updated node.
 */
export function updateInfraNodePosition(
  nodeId: string,
  x: number,
  y: number,
): Promise<InfraNode> {
  return apiFetch<InfraNode>(`${BASE}/nodes/${nodeId}/position`, {
    method: "PATCH",
    body: { x, y },
  });
}
