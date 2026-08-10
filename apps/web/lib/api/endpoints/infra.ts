import type {
  AgentFleetView,
  AgentPolicyOverride,
  AgentPolicySettings,
  AttachInfraSecret,
  BulkConfirmInfraNodes,
  BulkDiscardInfraNodes,
  ConfirmInfraNode,
  CreateInfraAutoConfirmRule,
  InfraAutoConfirmRule,
  InfraBulkResponse,
  UpdateInfraAutoConfirmRule,
  CreateInfraEdge,
  CreateInfraNode,
  InfraEdge,
  InfraIdentityMatch,
  InfraImpactResponse,
  InfraNode,
  InfraNodeDetail,
  InfraNodeFactChangeList,
  InfraGraph,
  InfraGraphEdges,
  InfraNodeListPage,
  InfraNodeListRole,
  InfraSecretRef,
  MergeInfraNode,
  UpdateInfraNode,
} from "@lazyit/shared";
import {
  InfraGraphEdgesSchema,
  InfraGraphSchema,
  InfraNodeListPageSchema,
} from "@lazyit/shared";
import { apiFetch } from "../client";

/**
 * Data-access for the infra topology graph (ADR-0070). The canvas screen (issue #741) wired the
 * three reads/writes the board needs; the rich drill-in detail and the create/edge/lifecycle WRITE
 * flows (issue #742) are wired below — the panel + write surface that makes this beat a Draw.io
 * diagram.
 *
 * The canvas reads active edges once from `GET /infra/graph/edges`. The per-node endpoint remains the
 * detail/history read, where closed relationships matter.
 *
 * ## The node read is TWO endpoints now (issue #1152)
 *
 * First-party lists use `GET /infra/nodes/page`, the house `Page<T>` envelope (ADR-0030) with
 * server-side `q`, a sort allowlist and a hard `limit` ceiling of 200 — {@link getInfraNodes}.
 * `GET /infra/nodes` remains only as the deprecated compatibility array until v2.0 and must not be
 * used by web consumers.
 *
 * The topology canvas cannot live on a page: a map missing a node is not a shorter map, it is a WRONG
 * map, because the missing node takes its edges with it and nothing on screen says so. So it got its
 * own read — {@link getInfraGraphNodes} — a narrow projection, complete by default, bounded at
 * `INFRA_GRAPH_NODES_MAX` and HONEST about the bound via `truncated`.
 */

const BASE = "/infra";

/**
 * Server-side filters for the node page (`GET /infra/nodes/page`, ADR-0030 / #1152). All of them
 * scope the SAME `where` the envelope's `total` counts, so a consumer showing a count is showing the
 * count of what it asked for.
 *
 *  - `kind` / `status` / `state` / `source` — plain enum scopes.
 *  - `ids` / `assetIds` — exact batch resolve, comma-encoded onto one param. The `GET /users?ids=`
 *    precedent (ADR-0030 §6 / #961): resolve the ids you actually reference instead of scanning a
 *    window and silently missing whatever fell outside it.
 *  - `q` — server-side text search over label / ipAddress / linked asset name / active owner
 *    name+email. It searches the TABLE, not the loaded page, which is why the Servers table no longer
 *    filters in memory.
 *
 * There is deliberately NO `deleted` param: this endpoint has no archived-nodes view to back it.
 */
export interface InfraNodeFilters {
  kind?: InfraNode["kind"];
  status?: InfraNode["status"];
  state?: InfraNode["state"];
  source?: InfraNode["source"];
  /** Reporting identity role; HOST excludes container and hypervisor-guest child namespaces. */
  role?: InfraNodeListRole;
  /** Exact node cuids — comma-encoded on the wire. */
  ids?: string[];
  /** Exact linked-Asset cuids — comma-encoded on the wire. */
  assetIds?: string[];
  q?: string;
}

/**
 * The full query for a page of nodes: the filters plus the house paging/sort params (ADR-0030).
 *
 * `limit` defaults to 50 server-side and is hard-capped at `MAX_PAGE_LIMIT` (200) — an over-max value
 * is REJECTED with a 400, never clamped, so a caller can never believe it asked for more than it got.
 * `sort` is an allowlist (`label`, `kind`, `status`, `state`, `ipAddress`, `lastReportedAt`,
 * `createdAt`, `updatedAt`); anything else 400s. Every sort carries the unique `id` as a tiebreaker,
 * so page boundaries are stable while reports land.
 */
export interface InfraNodeListParams extends InfraNodeFilters {
  limit?: number;
  offset?: number;
  sort?: string;
  dir?: "asc" | "desc";
}

/**
 * A page of topology nodes (`GET /infra/nodes/page`) — the house `{ items, total, limit, offset }`
 * envelope over the enriched `InfraNodeListItem` (the lean node PLUS the linked Asset's inventory
 * `assetName` and active `owners`, joined server-side in one query — ADR-0070 §6 / #750).
 *
 * Every param is omitted when empty, never sent blank: an empty `q` must not become `?q=`, because a
 * query key that churns between `{}` and `{ q: "" }` refetches on every keystroke that clears the box.
 */
export async function getInfraNodes(
  params: InfraNodeListParams = {},
  signal?: AbortSignal,
): Promise<InfraNodeListPage> {
  const qs = new URLSearchParams();
  if (params.kind) qs.set("kind", params.kind);
  if (params.status) qs.set("status", params.status);
  if (params.state) qs.set("state", params.state);
  if (params.source) qs.set("source", params.source);
  if (params.role) qs.set("role", params.role);
  if (params.ids && params.ids.length > 0) qs.set("ids", params.ids.join(","));
  if (params.assetIds && params.assetIds.length > 0)
    qs.set("assetIds", params.assetIds.join(","));
  if (params.q) qs.set("q", params.q);
  if (params.limit !== undefined) qs.set("limit", String(params.limit));
  if (params.offset !== undefined) qs.set("offset", String(params.offset));
  if (params.sort) {
    qs.set("sort", params.sort);
    if (params.dir) qs.set("dir", params.dir);
  }
  const search = qs.toString();
  const path = search ? `${BASE}/nodes/page?${search}` : `${BASE}/nodes/page`;
  return InfraNodeListPageSchema.parse(
    await apiFetch<unknown>(path, { signal }),
  );
}

/**
 * The topology canvas's own read (`GET /infra/graph/nodes`, #1152) — the whole graph, in the narrow
 * projection the board actually draws (`id`, `label`, `kind`, `status`, `ipAddress`, `chassis`,
 * `x`, `y`). No `owners`, no `assetName`, no `shortcuts`: each of those cost a relation join per row
 * on a read that is unpaginated AND polled, and the canvas has never rendered one.
 *
 * No filters and no `offset`, deliberately — there is no second page to fetch. `truncated` is the
 * whole point of the envelope: the read is bounded at `INFRA_GRAPH_NODES_MAX`, and when the cap bites
 * the canvas MUST say so rather than draw a map that is quietly missing boxes. Same `infra:read` gate.
 */
export async function getInfraGraphNodes(signal?: AbortSignal): Promise<InfraGraph> {
  return InfraGraphSchema.parse(
    await apiFetch<unknown>(`${BASE}/graph/nodes`, { signal }),
  );
}

/**
 * The canvas's active relationships (`GET /infra/graph/edges`) in one bounded-complete envelope.
 * Runtime parsing keeps the required `truncated` signal from being accidentally treated as optional.
 */
export async function getInfraGraphEdges(
  signal?: AbortSignal,
): Promise<InfraGraphEdges> {
  return InfraGraphEdgesSchema.parse(
    await apiFetch<unknown>(`${BASE}/graph/edges`, { signal }),
  );
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

// ── The review tray at scale (ADR-0074 §1 amendment, #1145) ────────────────────────────────────────

/**
 * Confirm many PENDING proposals at once (`POST /infra/nodes/bulk-confirm`). Each item carries the
 * SAME optional overrides the single confirm takes, and the API applies them through the same method —
 * so this removes the one-dialog-per-row cost, never the human approval.
 *
 * Resolves even when some items failed: the response is PER-ITEM (`applied`/`skipped`/`notFound`/
 * `failed` with a message), so the caller reports a partial batch instead of a bare "something broke".
 */
export function bulkConfirmInfraNodes(
  body: BulkConfirmInfraNodes,
): Promise<InfraBulkResponse> {
  return apiFetch<InfraBulkResponse>(`${BASE}/nodes/bulk-confirm`, {
    method: "POST",
    body,
  });
}

/** Discard many proposals at once (`POST /infra/nodes/bulk-discard`) — the existing soft delete, in bulk. */
export function bulkDiscardInfraNodes(
  body: BulkDiscardInfraNodes,
): Promise<InfraBulkResponse> {
  return apiFetch<InfraBulkResponse>(`${BASE}/nodes/bulk-discard`, {
    method: "POST",
    body,
  });
}

/** The saved auto-confirm rules, oldest first — the order the server evaluates them in. */
export function getInfraAutoConfirmRules(
  signal?: AbortSignal,
): Promise<InfraAutoConfirmRule[]> {
  return apiFetch<InfraAutoConfirmRule[]>(`${BASE}/auto-confirm-rules`, { signal });
}

/** Save a rule. It applies only to reports that arrive AFTER it is saved — never retroactively. */
export function createInfraAutoConfirmRule(
  body: CreateInfraAutoConfirmRule,
): Promise<InfraAutoConfirmRule> {
  return apiFetch<InfraAutoConfirmRule>(`${BASE}/auto-confirm-rules`, {
    method: "POST",
    body,
  });
}

/** Patch a rule — including the `enabled` toggle, which is the fastest way to revoke one. */
export function updateInfraAutoConfirmRule(
  ruleId: string,
  body: UpdateInfraAutoConfirmRule,
): Promise<InfraAutoConfirmRule> {
  return apiFetch<InfraAutoConfirmRule>(`${BASE}/auto-confirm-rules/${ruleId}`, {
    method: "PATCH",
    body,
  });
}

/** Delete a rule (soft delete). Nodes it already confirmed stay confirmed. */
export function deleteInfraAutoConfirmRule(
  ruleId: string,
): Promise<InfraAutoConfirmRule> {
  return apiFetch<InfraAutoConfirmRule>(`${BASE}/auto-confirm-rules/${ruleId}`, {
    method: "DELETE",
  });
}

/**
 * Re-image adoption hints (`GET /infra/nodes/:id/identity-matches`, ADR-0074 §3 / #1141) — other live
 * nodes whose stored corroborating evidence shares a burned-in serial or MAC with this one. Read-only:
 * it is what lets the tray ask *"this looks like `srv-app-04` re-imaged — adopt?"* instead of leaving
 * a curated node to drift OFFLINE beside a proposal nobody connects to it. Empty for a node reported
 * by an agent older than contract v2 (no `identifiers[]` stored) — no hint is better than a wrong one.
 */
export function getInfraNodeIdentityMatches(
  nodeId: string,
  signal?: AbortSignal,
): Promise<InfraIdentityMatch[]> {
  return apiFetch<InfraIdentityMatch[]>(
    `${BASE}/nodes/${nodeId}/identity-matches`,
    { signal },
  );
}

/**
 * Re-key a duplicate into an existing node (`POST /infra/nodes/:id/merge-into`, ADR-0074 §3 / #1141):
 * the addressed node's agent reporting key is transplanted onto `targetNodeId` so future reports land
 * there, and the duplicate is archived with the merge stamped on it. Identity moves; curation does
 * NOT — the target keeps its label, state, kind, position and asset link. Returns the target's
 * refreshed detail.
 */
export function mergeInfraNodeInto(
  nodeId: string,
  body: MergeInfraNode,
): Promise<InfraNodeDetail> {
  return apiFetch<InfraNodeDetail>(`${BASE}/nodes/${nodeId}/merge-into`, {
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
/**
 * A page of a node's recorded fact history (`GET /infra/nodes/:id/changes`, ADR-0074 §3 amendment,
 * #1143) — what MOVED, newest first. Keyset-paginated on the append-only autoincrement id: a page
 * asks for rows BELOW the last id it saw, so nothing is skipped or repeated while reports land.
 */
export function getInfraNodeChanges(
  nodeId: string,
  params: { limit?: number; cursor?: number } = {},
  signal?: AbortSignal,
): Promise<InfraNodeFactChangeList> {
  const query = new URLSearchParams();
  if (params.limit !== undefined) query.set("limit", String(params.limit));
  if (params.cursor !== undefined) query.set("cursor", String(params.cursor));
  const suffix = query.size ? `?${query.toString()}` : "";
  return apiFetch<InfraNodeFactChangeList>(
    `${BASE}/nodes/${nodeId}/changes${suffix}`,
    { signal },
  );
}

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

/**
 * The agent fleet read (`GET /infra/agents/fleet`, ADR-0094 §4 / #1206) — *"how many agents do I
 * have, on what versions, who has not checked in, and who is degraded?"* in ONE request.
 *
 * Read-only and derived: every field comes from data the server already stores, and nothing here
 * pushes anything toward a host. The response carries the instance's own `serverVersion` alongside
 * the rows, so the table can never render a distribution against a version it did not come from.
 *
 * NOT polled like `getInfraNodes` is. This is a page an operator navigates to and reads, not a live
 * board — and the read is heavier (it projects `specs.host.os.family` and `specs.diagnostics` per
 * row), which is exactly why #1135 kept `specs` off the list projection in the first place.
 */
export function getAgentFleet(signal?: AbortSignal): Promise<AgentFleetView> {
  return apiFetch<AgentFleetView>(`${BASE}/agents/fleet`, { signal });
}

/**
 * Read the INSTANCE DEFAULT agent policy + the instance-wide revision (`GET /infra/agent-policy`,
 * ADR-0074 §7 amendment / #1140). `settings` is the stored layer Settings → Instance edits;
 * `effective` is that layer resolved over the built-in defaults — it is what a host with NO narrower
 * override runs, and deliberately not a promise about hosts that do have one.
 */
export function getAgentPolicy(
  signal?: AbortSignal,
): Promise<AgentPolicySettings> {
  return apiFetch<AgentPolicySettings>(`${BASE}/agent-policy`, { signal });
}

/**
 * Replace the instance-default agent policy (`PUT /infra/agent-policy`). The body is a PARTIAL
 * policy: every omitted field falls back to the built-in default, so `{}` restores all of them.
 * Bumps the revision, which every agent then echoes back on its next report.
 */
export function putAgentPolicy(
  body: AgentPolicyOverride,
): Promise<AgentPolicySettings> {
  return apiFetch<AgentPolicySettings>(`${BASE}/agent-policy`, {
    method: "PUT",
    body,
  });
}
