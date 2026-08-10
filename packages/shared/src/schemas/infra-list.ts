import { z } from "zod";
import {
  InfraEdgeSchema,
  InfraNodeListItemSchema,
  InfraNodeSchema,
} from "./infra";
import { pageSchema } from "./pagination";

/** Identity role used by the reporting-agent wizard; independent of the node's `kind`. */
export const InfraNodeListRoleSchema = z.enum(["HOST", "CHILD"]);

export type InfraNodeListRole = z.infer<typeof InfraNodeListRoleSchema>;

/**
 * The two READ contracts `GET /infra/nodes` was split into (issue #1152).
 *
 * ## Why a split at all
 *
 * One endpoint was serving two jobs with opposite requirements. The Servers table and the PENDING
 * review tray want a WINDOW — a screenful, ordered, searchable, and above all bounded, because both
 * of them POLL (the tray every 40s, the create-agent wizard every 5s). The topology canvas wants the
 * WHOLE graph: a map missing a node is not a shorter map, it is a wrong map — the missing node takes
 * its edges with it and the operator has no cue that anything is absent.
 *
 * So the list paginates on the house `Page<T>` contract ({@link InfraNodeListPageSchema}, ADR-0030)
 * and the canvas got its own read ({@link InfraGraphSchema}). The alternative — letting the canvas
 * ask the paged list for `limit=200` — was rejected: 200 sits BELOW the ADR-0095 `AGENT_GUESTS_MAX`
 * ceiling of 500 guests that a single hypervisor host can enrol, so one ordinary VMware/Proxmox host
 * would have silently pushed nodes off the map.
 *
 * ## Why the graph read is still bounded
 *
 * "Complete" and "unbounded" are not the same promise. The canvas read is capped at
 * {@link INFRA_GRAPH_NODES_MAX} and says so on the wire via `truncated`, so the one deliberately
 * unpaginated surface left has a limit an operator can SEE rather than a limit that shows up as a
 * missing box. The cap sits far above any realistic self-hosted estate (and far above what one host
 * can enrol), so `truncated: true` is a real anomaly worth surfacing, not routine noise.
 */

/**
 * `GET /infra/nodes` — the house `Page<T>` envelope over the lean {@link InfraNodeListItemSchema}
 * row (ADR-0030: `{ items, total, limit, offset }`, default page 50, hard max 200, an over-max
 * `limit` rejected with 400 rather than clamped).
 *
 * **This is a BREAKING wire-shape change**: the endpoint previously returned a bare
 * `InfraNodeListItem[]`. It follows the precedent ADR-0030 §4 set for `GET /assets/:id/articles`
 * (#220), where `ArticleListItem[]` → `Page<ArticleListItem>` landed front+back in one change.
 *
 * `total` is the count over the SAME `where` as `items` — it reflects the FILTERED set, never the
 * table — so a consumer that shows a count is showing the count of what it asked for.
 */
export const InfraNodeListPageSchema = pageSchema(InfraNodeListItemSchema);

export type InfraNodeListPage = z.infer<typeof InfraNodeListPageSchema>;

/**
 * The hard cap on `GET /infra/graph/nodes`. Chosen against the estate ceiling this product actually
 * has to survive: ADR-0095's `AGENT_GUESTS_MAX` is 500 guests from ONE hypervisor report, so the cap
 * has to clear several maxed-out hosts at once and still leave room. It is NOT the ADR-0030 page cap
 * (200) — this read is not a page, and reusing the page cap here is exactly the mistake the split
 * exists to avoid.
 */
export const INFRA_GRAPH_NODES_MAX = 2000;

/**
 * One node as the topology canvas draws it — a PROJECTION, not the list row.
 *
 * Derived from {@link InfraNodeSchema} with `pick` rather than re-declared, so a column that changes
 * type or name cannot leave the canvas contract quietly stale. The fields, and why each is here:
 *
 *  - `id` — React Flow node id, edge matching, selection/impact/spotlight sets.
 *  - `label`, `kind`, `status`, `ipAddress` — everything the node card and hover card render.
 *  - `x`, `y` — the free-move board position (null → the fallback grid layout).
 *  - `chassis` — never rendered, but `isEndpointChassis` partitions endpoints out of the board with
 *    it (ADR-0093 §2/§5). A scalar, so it costs nothing to carry.
 *
 * What is deliberately ABSENT is the point: `owners` and `assetName` each cost a relation join per
 * row (Asset → active AssetAssignment → User) on a read that is unpaginated AND polled, and the
 * canvas has never rendered either one. `shortcuts` is a jsonb blob only the drill-in shows, and
 * `specs` was already removed from the list row in #1135. Dropping them makes the canvas read
 * strictly cheaper than the list read it replaced.
 */
export const InfraGraphNodeSchema = InfraNodeSchema.pick({
  id: true,
  label: true,
  kind: true,
  status: true,
  ipAddress: true,
  chassis: true,
  x: true,
  y: true,
});

export type InfraGraphNode = z.infer<typeof InfraGraphNodeSchema>;

/**
 * `GET /infra/graph/nodes` — the bounded, complete-by-default graph read for the canvas.
 *
 * NOT a `Page<T>`, and deliberately so: there is no `offset`, because there is no second page to
 * fetch. The envelope's job is to make the ceiling honest rather than to address a window:
 *
 *  - `items` — up to {@link INFRA_GRAPH_NODES_MAX} nodes, in the same total order the list uses
 *    (`createdAt desc`, `id desc`).
 *  - `total` — how many live nodes exist. Equal to `items.length` in every normal estate.
 *  - `limit` — the cap that was applied, echoed so the client never hardcodes it.
 *  - `truncated` — REQUIRED (not optional, not defaulted): a client cannot read "absent" as "fine".
 *    When true the canvas MUST tell the operator the map is incomplete; a silently short map is the
 *    exact failure this whole split exists to prevent.
 */
export const InfraGraphSchema = z.object({
  items: z.array(InfraGraphNodeSchema),
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  truncated: z.boolean(),
});

export type InfraGraph = z.infer<typeof InfraGraphSchema>;

/** Hard cap for the canvas's active-edge read. */
export const INFRA_GRAPH_EDGES_MAX = 10_000;

/** `GET /infra/graph/edges` — active edges between live nodes, bounded without pagination. */
export const InfraGraphEdgesSchema = z.object({
  items: z.array(InfraEdgeSchema),
  total: z.number().int().min(0),
  limit: z.number().int().min(1),
  truncated: z.boolean(),
});

export type InfraGraphEdges = z.infer<typeof InfraGraphEdgesSchema>;
