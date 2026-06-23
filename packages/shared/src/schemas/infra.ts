import { z } from "zod";
import { requireAtLeastOneKey } from "./primitives";

/**
 * Infra topology graph — InfraNode (the things) + InfraEdge (typed, timestamped relationships).
 * The generic visual CMDB of the server estate. Single source of truth for api (DTOs) and web
 * (forms/canvas). See docs/03-decisions/0070-infra-topology-graph.md.
 *
 * Date fields are ISO-8601 strings (the wire shape): the API serializes Prisma `DateTime`s to
 * strings, and `z.date()` can't be represented in JSON Schema / OpenAPI (ADR-0018).
 *
 * The full enum sets ship from day 1 (ADR-0070 §2/§3) so MVP and v1 never re-migrate; the API
 * decides which subset each phase exposes in the UI. The model is GENERIC on purpose — no
 * platform-specific kinds (no POD/NAMESPACE/K8S_NODE); a k8s pod is a CONTAINER, a namespace a
 * CLUSTER/OTHER grouping (ADR-0070 §2).
 */

// ── Enums (ADR-0070 §2/§3) ──────────────────────────────────────────────────────────────────────

/** What a node IS (ADR-0070 §2). Generic + extensible; new kinds are a one-line enum migration. */
export const InfraNodeKindSchema = z.enum([
  "PHYSICAL_HOST",
  "VM",
  "CONTAINER",
  "CLUSTER", // any logical grouping of hosts/nodes
  "NETWORK_DEVICE",
  "STORAGE",
  "APPLIANCE",
  "OTHER",
]);

/** Live state of a node. AGENT liveness (lastReportedAt) drives this in v2; manual until then. */
export const InfraNodeStatusSchema = z.enum(["ONLINE", "OFFLINE", "UNKNOWN"]);

/** Provenance (ADR-0070 §4): hand-entered vs auto-discovered by the v2 reporting agent. */
export const InfraNodeSourceSchema = z.enum(["MANUAL", "AGENT"]);

/** Lifecycle (ADR-0070 §4): PENDING = in the v2 review tray, CONFIRMED = on the live map. */
export const InfraNodeStateSchema = z.enum(["CONFIRMED", "PENDING"]);

/** Typed relationship between two nodes (ADR-0070 §3). See PLAUSIBLE_EDGE_TARGETS for source→target. */
export const InfraEdgeKindSchema = z.enum([
  "RUNS_ON", // source is hosted/executed by target (one active host per source)
  "MEMBER_OF", // source belongs to a logical group
  "DEPENDS_ON", // source needs target to function
  "BACKS_UP_TO", // source's data is backed up to target
  "CONNECTS_TO", // network adjacency — symmetric; API canonicalizes lower id as source
]);

// ── shortcuts + specs (ADR-0070 §1) ──────────────────────────────────────────────────────────────

/** Cap on the shortcuts list — SSH/web-UI/console links per node; a sane upper bound, not a real limit. */
export const INFRA_SHORTCUTS_MAX = 20;

/**
 * A quick-access link on a node: `{ label, url }` (SSH/web UI/console). `url` is URL-validated so a
 * bad link is a clean 400, not a broken anchor on the canvas. The node's `shortcuts` is an array of
 * these (nullable = none).
 */
export const InfraShortcutSchema = z.strictObject({
  label: z.string().trim().min(1).max(120),
  url: z.url().max(2000),
});
export const InfraShortcutsSchema = z.array(InfraShortcutSchema).max(INFRA_SHORTCUTS_MAX);

/**
 * Loose per-kind attributes (ADR-0007 posture — same as Asset.specs): any JSON object is accepted,
 * validated by the app, not the DB. Per-kind schema validation is deferred (ADR-0070 Future / the
 * existing TODO(specs) debt).
 */
const InfraSpecsSchema = z.record(z.string(), z.unknown());

// ── InfraNode wire shape + DTOs (ADR-0070 §1) ─────────────────────────────────────────────────────

/** The full persisted InfraNode (API representation of the `infra_nodes` row). */
export const InfraNodeSchema = z.object({
  id: z.cuid(),
  kind: InfraNodeKindSchema,
  label: z.string().min(1),
  status: InfraNodeStatusSchema,
  // Asset linkage — default-on; SetNull detaches (never deletes) the node when the asset is removed.
  assetId: z.cuid().nullable(),
  ipAddress: z.string().nullable(), // primary IP, label-only (no validation/IPAM — ADR-0070 scope cut)
  shortcuts: InfraShortcutsSchema.nullable(),
  specs: InfraSpecsSchema.nullable(),
  x: z.number().nullable(), // canvas position (free-move board)
  y: z.number().nullable(),
  // Provenance + lifecycle (columns exist now; the v2 agent exercises them — ADR-0070 §4).
  source: InfraNodeSourceSchema,
  state: InfraNodeStateSchema,
  reportingSource: z.string().nullable(),
  externalId: z.string().nullable(),
  lastReportedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime().nullable(),
});

/**
 * Payload to create a node. `kind` + `label` are required; everything else is optional with a DB
 * default (status=UNKNOWN, source=MANUAL, state=CONFIRMED). `assetId` links an existing asset; the
 * "track as asset" default-on create flow (ADR-0070 §5) is API logic, not part of this wire shape.
 * Agent-only fields (source/state/reportingSource/externalId/lastReportedAt) are NOT in the body —
 * the v2 agent path sets them server-side (ADR-0070 §4), the X-User-Id actor pattern carried over.
 */
export const CreateInfraNodeSchema = z.strictObject({
  kind: InfraNodeKindSchema,
  label: z.string().trim().min(1).max(200),
  status: InfraNodeStatusSchema.optional(),
  assetId: z.cuid().optional(),
  ipAddress: z.string().trim().min(1).max(255).optional(),
  shortcuts: InfraShortcutsSchema.optional(),
  specs: InfraSpecsSchema.optional(),
  x: z.number().optional(),
  y: z.number().optional(),
});

/** Partial update; any subset of the editable fields (an empty body is rejected). */
export const UpdateInfraNodeSchema = requireAtLeastOneKey(
  z
    .strictObject({
      kind: InfraNodeKindSchema,
      label: z.string().trim().min(1).max(200),
      status: InfraNodeStatusSchema,
      assetId: z.cuid().nullable(), // null detaches the asset link
      ipAddress: z.string().trim().min(1).max(255).nullable(),
      shortcuts: InfraShortcutsSchema.nullable(),
      specs: InfraSpecsSchema.nullable(),
      x: z.number(),
      y: z.number(),
    })
    .partial(),
);

// ── InfraEdge wire shape + DTO (ADR-0070 §1/§3) ───────────────────────────────────────────────────

/** The full persisted InfraEdge (API representation of the `infra_edges` row). */
export const InfraEdgeSchema = z.object({
  id: z.cuid(),
  sourceId: z.cuid(),
  targetId: z.cuid(),
  kind: InfraEdgeKindSchema,
  startedAt: z.iso.datetime(),
  endedAt: z.iso.datetime().nullable(), // null = active; migration = close one, open next (ADR-0019 pattern)
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/**
 * Payload to open an edge. `sourceId`/`targetId`/`kind` are required. A self-loop is rejected here
 * (a node can't relate to itself). The API enforces the DB-level invariants zod can't see:
 * one-active-host-per-source for RUNS_ON and canonical-pair uniqueness for the symmetric CONNECTS_TO
 * (partial unique indexes — ADR-0070 §3); it also WARNS on implausible (sourceKind→targetKind) pairs
 * via PLAUSIBLE_EDGE_TARGETS below (a warning, not a hard constraint, to stay generic).
 */
export const CreateInfraEdgeSchema = z
  .strictObject({
    sourceId: z.cuid(),
    targetId: z.cuid(),
    kind: InfraEdgeKindSchema,
  })
  .refine((e) => e.sourceId !== e.targetId, {
    error: "An edge's source and target must be different nodes",
    path: ["targetId"],
  });

// ── Plausibility table (ADR-0070 §3) — data the API WARNS on, NOT a hard constraint ───────────────

export type InfraNodeKind = z.infer<typeof InfraNodeKindSchema>;
export type InfraEdgeKind = z.infer<typeof InfraEdgeKindSchema>;

/**
 * For each edge kind, the (sourceKind → allowed targetKinds) pairs that make sense (ADR-0070 §3).
 * DOCUMENTATION-AS-DATA the API can use to WARN ("a CONTAINER does not usually RUNS_ON a
 * NETWORK_DEVICE") rather than block — keeping the model generic. NOT a DB constraint.
 *
 * Minimal on purpose (ponytail): only the host/group spine is encoded. The looser kinds
 * (DEPENDS_ON / BACKS_UP_TO / CONNECTS_TO) legitimately accept any source→target, so they're absent
 * from the map — `isPlausibleEdge` treats an absent kind, and an absent source within a kind, as
 * "plausible". The table only flags pairs we're confident are WRONG; everything else passes unwarned.
 */
export const PLAUSIBLE_EDGE_TARGETS: Partial<
  Record<InfraEdgeKind, Partial<Record<InfraNodeKind, readonly InfraNodeKind[]>>>
> = {
  // A workload runs on a host or a cluster; a container can also run on a VM.
  RUNS_ON: {
    VM: ["PHYSICAL_HOST", "CLUSTER"],
    CONTAINER: ["PHYSICAL_HOST", "VM", "CLUSTER"],
  },
  // A host/VM/storage/appliance belongs to a logical group (cluster or OTHER grouping).
  MEMBER_OF: {
    PHYSICAL_HOST: ["CLUSTER", "OTHER"],
    VM: ["CLUSTER", "OTHER"],
    STORAGE: ["CLUSTER", "OTHER"],
    APPLIANCE: ["CLUSTER", "OTHER"],
  },
};

/**
 * Is this (kind, sourceKind → targetKind) edge a plausible one? Kinds absent from the table
 * (DEPENDS_ON/BACKS_UP_TO/CONNECTS_TO) are always plausible; for a mapped kind, a source not listed
 * is also treated as plausible (the table only flags the pairs we're confident are WRONG). Returns
 * false only when the source IS in the map but the target isn't in its allowed set. Pure +
 * framework-agnostic so api (the warning) and web (a client-side hint) agree.
 */
export function isPlausibleEdge(
  kind: InfraEdgeKind,
  sourceKind: InfraNodeKind,
  targetKind: InfraNodeKind,
): boolean {
  const bySource = PLAUSIBLE_EDGE_TARGETS[kind];
  const allowed = bySource?.[sourceKind];
  return allowed === undefined || allowed.includes(targetKind);
}

// ── Impact / blast-radius response (ADR-0070 §7) ──────────────────────────────────────────────────

/**
 * `GET /infra/nodes/:id/impact` — the downstream set reachable from a node over inverse
 * RUNS_ON/DEPENDS_ON edges (what is affected if this node goes down). The wire shape only; the
 * recursive traversal is API logic. Each affected node carries enough to highlight it on the canvas.
 */
export const InfraImpactNodeSchema = z.object({
  id: z.cuid(),
  label: z.string(),
  kind: InfraNodeKindSchema,
  status: InfraNodeStatusSchema,
  /** Edge hops from the root (1 = directly hosted/dependent, 2 = transitively, …). */
  depth: z.number().int().min(1),
});

export const InfraImpactResponseSchema = z.object({
  rootId: z.cuid(),
  affected: z.array(InfraImpactNodeSchema),
});

// ── Inferred types ────────────────────────────────────────────────────────────────────────────────

export type InfraNodeStatus = z.infer<typeof InfraNodeStatusSchema>;
export type InfraNodeSource = z.infer<typeof InfraNodeSourceSchema>;
export type InfraNodeState = z.infer<typeof InfraNodeStateSchema>;
export type InfraShortcut = z.infer<typeof InfraShortcutSchema>;
export type InfraNode = z.infer<typeof InfraNodeSchema>;
export type CreateInfraNode = z.infer<typeof CreateInfraNodeSchema>;
export type UpdateInfraNode = z.infer<typeof UpdateInfraNodeSchema>;
export type InfraEdge = z.infer<typeof InfraEdgeSchema>;
export type CreateInfraEdge = z.infer<typeof CreateInfraEdgeSchema>;
export type InfraImpactNode = z.infer<typeof InfraImpactNodeSchema>;
export type InfraImpactResponse = z.infer<typeof InfraImpactResponseSchema>;
