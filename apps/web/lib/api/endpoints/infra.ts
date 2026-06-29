import type {
  AttachInfraSecret,
  ConfirmInfraNode,
  CreateInfraEdge,
  CreateInfraNode,
  InfraEdge,
  InfraImpactResponse,
  InfraNode,
  InfraNodeDetail,
  InfraNodeListItem,
  InfraSecretRef,
  UpdateInfraNode,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for the infra topology graph (ADR-0070). The canvas screen (issue #741) wired the
 * three reads/writes the board needs; the rich drill-in detail and the create/edge/lifecycle WRITE
 * flows (issue #742) are wired below — the panel + write surface that makes this beat a Draw.io
 * diagram.
 *
 * Edges are read PER-NODE (`GET /infra/nodes/:id/edges`) — the API has no global edges list. The
 * canvas fans those reads out across the loaded nodes and dedupes by edge id (see `use-infra-nodes`).
 */

const BASE = "/infra";

/**
 * Server-side filters for the node list. `kind`/`status`/`state` scope the result set; omit for all
 * confirmed nodes. The API excludes soft-deleted rows and returns a plain `InfraNodeListItem[]` (no
 * page envelope — the estate is small by design, ADR-0070).
 */
export interface InfraNodeFilters {
  kind?: InfraNode["kind"];
  status?: InfraNode["status"];
  state?: InfraNode["state"];
}

/**
 * List topology nodes (`GET /infra/nodes`), optionally filtered. Newest first. Each row is an
 * `InfraNodeListItem` — the lean node PLUS the linked Asset's inventory `assetName` and active
 * `owners` (joined server-side in one query, ADR-0070 §6 / issue #750) so the Servers list can show
 * and search them inline. Hooks that only read `assetId` keep working (the list shape is a superset).
 */
export function getInfraNodes(
  filters: InfraNodeFilters = {},
  signal?: AbortSignal,
): Promise<InfraNodeListItem[]> {
  const params = new URLSearchParams();
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.status) params.set("status", filters.status);
  if (filters.state) params.set("state", filters.state);
  const qs = params.toString();
  return apiFetch<InfraNodeListItem[]>(
    qs ? `${BASE}/nodes?${qs}` : `${BASE}/nodes`,
    { signal },
  );
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

/**
 * The enriched drill-in (`GET /infra/nodes/:id`, ADR-0070 §6) — the asset-backed payoff: owners,
 * KB links, secret HANDLES (never values, INV-10), shortcuts, IP and the children list (active
 * inverse RUNS_ON). The whole reason this beats a Draw.io diagram.
 */
export function getInfraNodeDetail(
  nodeId: string,
  signal?: AbortSignal,
): Promise<InfraNodeDetail> {
  return apiFetch<InfraNodeDetail>(`${BASE}/nodes/${nodeId}`, { signal });
}

/**
 * The create flow's "track as asset" toggle (ADR-0070 §5) is API logic, not part of the persisted
 * node wire shape — it rides as its own body field (default-on server-side). `trackAsAsset: true`
 * (or omitted) links/creates a backing Asset; `false` makes a graph-only node (right for ephemeral
 * containers). Passing `assetId` links an existing Asset; omitting it lets the API mint a minimal one.
 */
export type CreateInfraNodeInput = CreateInfraNode & { trackAsAsset?: boolean };

/** Create a node (`POST /infra/nodes`). Asset-backed by default (ADR-0070 §5). Returns the new node. */
export function createInfraNode(input: CreateInfraNodeInput): Promise<InfraNode> {
  return apiFetch<InfraNode>(`${BASE}/nodes`, { method: "POST", body: input });
}

/**
 * Patch a node (`PATCH /infra/nodes/:id`) — any subset of editable fields: `status` (the lifecycle
 * toggle), `label`, `kind`, `ipAddress`, `shortcuts`, and `assetId: null` to DETACH the asset link
 * (the API soft-deletes an auto-created Asset, un-links a pre-existing one — ADR-0070 §5).
 */
export function updateInfraNode(
  nodeId: string,
  patch: UpdateInfraNode,
): Promise<InfraNode> {
  return apiFetch<InfraNode>(`${BASE}/nodes/${nodeId}`, {
    method: "PATCH",
    body: patch,
  });
}

/** Soft-delete a node (`DELETE /infra/nodes/:id`) — off the map, history kept (ADR-0070 §5). */
export function deleteInfraNode(nodeId: string): Promise<InfraNode> {
  return apiFetch<InfraNode>(`${BASE}/nodes/${nodeId}`, { method: "DELETE" });
}

/** Restore a soft-deleted node (`POST /infra/nodes/:id/restore`) — back onto the map. */
export function restoreInfraNode(nodeId: string): Promise<InfraNode> {
  return apiFetch<InfraNode>(`${BASE}/nodes/${nodeId}/restore`, {
    method: "POST",
  });
}

/**
 * Confirm a PENDING agent-reported node from the review tray (`POST /infra/nodes/:id/confirm`,
 * ADR-0074 §3). Flips `state` to CONFIRMED; `trackAsAsset` (default true server-side) mints the backing
 * Asset carrying the agent's host facts, so the auto-discovered host becomes a first-class Asset only on
 * human approval. Optional `kind`/`label` re-classify/rename at the confirm step. Returns the enriched
 * `InfraNodeDetail`. To DISCARD a proposal instead, soft-delete it (`deleteInfraNode`).
 */
export function confirmInfraNode(
  nodeId: string,
  body: ConfirmInfraNode,
): Promise<InfraNodeDetail> {
  return apiFetch<InfraNodeDetail>(`${BASE}/nodes/${nodeId}/confirm`, {
    method: "POST",
    body,
  });
}

/**
 * Blast radius (`GET /infra/nodes/:id/impact`, ADR-0070 §7) — the downstream set affected if this
 * node goes down: a transitive traversal over ACTIVE inverse RUNS_ON/DEPENDS_ON edges, each affected
 * node carrying its minimum hop `depth`. The query that justifies a graph over a static picture; the
 * canvas highlights `affected` and dims the rest. Read-gated server-side (`infra:read`).
 */
export function getInfraNodeImpact(
  nodeId: string,
  signal?: AbortSignal,
): Promise<InfraImpactResponse> {
  return apiFetch<InfraImpactResponse>(`${BASE}/nodes/${nodeId}/impact`, {
    signal,
  });
}

/**
 * A node's edges, including CLOSED ones (`GET /infra/nodes/:id/edges?active=false`). The canvas reads
 * active-only to draw the live graph; the drill-in panel reads the full history (active + closed) so
 * an operator can see migrations (a RUNS_ON close→open) and close an active edge.
 */
export function getInfraNodeEdgesHistory(
  nodeId: string,
  signal?: AbortSignal,
): Promise<InfraEdge[]> {
  return apiFetch<InfraEdge[]>(`${BASE}/nodes/${nodeId}/edges?active=false`, {
    signal,
  });
}

/**
 * Open an edge (`POST /infra/edges`). The API canonicalizes symmetric CONNECTS_TO, MIGRATES a RUNS_ON
 * (closes the source's active host, opens the new one), warns on implausible kind pairs, and surfaces
 * a friendly 409 if a one-active-host / duplicate-pair invariant is hit (ADR-0070 §3) — the caller
 * just toasts the API's message via `notifyError`.
 */
export function createInfraEdge(input: CreateInfraEdge): Promise<InfraEdge> {
  return apiFetch<InfraEdge>(`${BASE}/edges`, { method: "POST", body: input });
}

/** Close an edge (`POST /infra/edges/:id/close`) — set endedAt (the ADR-0019 migration marker). */
export function closeInfraEdge(edgeId: string): Promise<InfraEdge> {
  return apiFetch<InfraEdge>(`${BASE}/edges/${edgeId}/close`, {
    method: "POST",
  });
}

/**
 * Attach a secret HANDLE reference to a node (`POST /infra/nodes/:id/secrets`, ADR-0073 / issue #801).
 * A SOFT reference (handle + vaultId in the body, never a value — INV-10). The API enforces
 * infra:manage + secret:read AND live membership of the vault (403 non-member, 404 no live handle),
 * and upserts on `(node, vault, handle)` so re-attaching is idempotent. Returns the node's FULL
 * updated resolved `secretRefs` (handles only).
 */
export function attachInfraNodeSecret(
  nodeId: string,
  body: AttachInfraSecret,
): Promise<InfraSecretRef[]> {
  return apiFetch<InfraSecretRef[]>(`${BASE}/nodes/${nodeId}/secrets`, {
    method: "POST",
    body,
  });
}

/**
 * Detach a secret HANDLE reference from a node (`DELETE /infra/nodes/:id/secrets`, ADR-0073). The
 * handle + vaultId ride in the BODY (not the path — handles can contain dots). A topology edit:
 * infra:manage only, no vault membership needed; idempotent. Returns the node's FULL updated
 * resolved `secretRefs`.
 */
export function detachInfraNodeSecret(
  nodeId: string,
  body: AttachInfraSecret,
): Promise<InfraSecretRef[]> {
  return apiFetch<InfraSecretRef[]>(`${BASE}/nodes/${nodeId}/secrets`, {
    method: "DELETE",
    body,
  });
}
