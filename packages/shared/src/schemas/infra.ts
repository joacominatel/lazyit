import { z } from "zod";
import { requireAtLeastOneKey } from "./primitives";
import { ArticleListItemSchema } from "./article-list";
// One-way only: `agent-policy` is a LEAF and never imports this file back (see its own note on why).
import { AgentPolicySchema } from "./agent-policy";

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

/**
 * Who owns the node's `ipAddress` (ADR-0074 §3 fact-promotion, issue #1081). `AGENT` (the default)
 * means the value is a discovered live fact — each report OVERWRITES it. `MANUAL` means a human typed
 * it in the panel, so the agent must NEVER clobber it. The default is AGENT because the only writer
 * that needs the distinction is the report path; a manually-created node never receives reports, so
 * its default AGENT is harmless, and the human IP-edit path stamps MANUAL server-side.
 */
export const InfraNodeIpSourceSchema = z.enum(["AGENT", "MANUAL"]);

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

// ── IP address value-object (ADR-0090, issue #847) ────────────────────────────────────────────────

/**
 * A single IPv4 OR IPv6 address, trimmed then FORMAT-validated (ADR-0090, issue #847). The shared
 * value-object BOTH write paths reuse — the manual node edit (a clean 400 on garbage, via the DTO) and
 * the agent-promotion path (validate-or-drop in {@link primaryIpv4}, never a 400 on a whole report).
 * Native zod-v4 validators (`z.ipv4()`/`z.ipv6()`) — NO new dependency (they back `z.string().ip()`'s
 * successor). Normalization is TRIM-ONLY: zod validates the address but does not canonicalize IPv6
 * (`2001:db8::1` and its expanded form stay distinct strings) — good enough for a display fact plus a
 * best-effort soft conflict hint, and it never rewrites what the operator typed. `InfraNodeSchema`
 * keeps the looser `z.string().nullable()` on the READ side (tolerance for legacy label-only rows).
 */
export const IpAddressSchema = z
  .string()
  .trim()
  .pipe(z.union([z.ipv4(), z.ipv6()]));

// ── Host form factor (ADR-0074 §2 contract v2, #1138; routed on by ADR-0093) ──────────────────────

/**
 * What the host physically IS — the hint `kind` inference (#1139) reads to stop landing every
 * reported host as `PHYSICAL_HOST`. `vm`/`container` come from the virtualization probe, the rest
 * from SMBIOS chassis type (or its per-OS equivalent).
 *
 * Declared here rather than with the rest of the contract-v2 vocabularies below because ADR-0093 §2
 * makes it a persisted `InfraNode` column, and {@link InfraNodeSchema} is evaluated before them.
 */
export const AgentChassisSchema = z.enum([
  "server",
  "desktop",
  "laptop",
  "vm",
  "container",
  "unknown",
]);

/**
 * The chassis values that make a reported host an ENDPOINT rather than estate topology (ADR-0093 §5,
 * decision 1 of 2026-08-03). A workstation is somebody's desk, not infrastructure: on a representative
 * estate it is ~180 of the ~245 boxes the agent reports, and drawing all of them is what makes the
 * canvas unusable. `server`, `vm` and `container` are emphatically NOT endpoints.
 */
export const ENDPOINT_CHASSIS: readonly AgentChassis[] = ["laptop", "desktop"];

/**
 * Is this node an endpoint — a laptop or a desktop (ADR-0093 §5)?
 *
 * The pure mapper the canvas's default "hide endpoints" treatment reads, and the reason §1 could leave
 * `inferNodeKind` untouched: form factor is an ORTHOGONAL fact, not a second answer to the "virtual or
 * physical?" question `kind` already answers. A laptop *is* a `PHYSICAL_HOST`; it is also an endpoint.
 *
 * **NO SIGNAL IS NOT AN ENDPOINT.** `null`/`undefined` (a manual node, a pre-v2 agent, a report that
 * predates the column and has not re-reported yet) and the explicit `unknown` (the probe did not run —
 * a container reading `/sys/class/dmi` sees the HOST's board, so the Linux collector forces it) both
 * answer `false`. Routing may only ever remove noise a POSITIVE fact identified; it must never hide a
 * host on a guess, because a host that silently vanishes from every surface is worse than a noisy map.
 */
export function isEndpointChassis(chassis: string | null | undefined): boolean {
  return chassis != null && (ENDPOINT_CHASSIS as readonly string[]).includes(chassis);
}

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
  // Who owns `ipAddress` (issue #1081): AGENT = a discovered live fact reports overwrite; MANUAL = a
  // human-typed value the agent never clobbers. `.nullish()` so an older API/read never breaks web.
  ipAddressSource: InfraNodeIpSourceSchema.nullish(),
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
  // The reporting agent's own build version at its last check-in (ADR-0074/0083, issue #907). Null
  // for manual nodes + pre-stamp agents; the UI compares it to `GET /instance/version` to show an
  // "agent outdated" hint when the agent is a MAJOR behind the server (display-only, never a gate).
  agentVersion: z.string().nullable(),
  /**
   * What the host physically IS (ADR-0093 §2) — the agent-owned form factor, written from
   * `host.chassis` on EVERY report, create and refresh alike. Chassis is a FACT (the `ipAddress`
   * class), not curation (the `kind` class): a re-image or a board swap changes the truth and the
   * column follows it. There is deliberately no `chassisSource` and no `MANUAL` counterpart, because
   * chassis is never on the create/update DTOs — a human cannot edit it, so there is no human write to
   * protect. A hand-drawn node has `chassis: null` and is always on the canvas.
   *
   * `.nullish().catch(null)` is the read-tolerance this needs and the `.catch(undefined)` on the wire
   * schema promises: a value a future collector invents must degrade to "no signal" on READ, exactly
   * as it degrades on the write boundary — never fail a whole node payload. Null on every row that
   * predates the column (which self-heals on that host's next report), on every manual node, and on
   * every CONTAINER child, whose blob carries no `host` key at all (#1139).
   *
   * Small enough to sit on the LIST row — unlike `specs`, which `InfraNodeListItemSchema` omits
   * (#1135) — which is what lets the canvas filter endpoints client-side with no second request.
   */
  chassis: AgentChassisSchema.nullish().catch(null),
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
  // Format-validated (ADR-0090, #847): a malformed IP is a clean 400 here, never a persisted label.
  ipAddress: IpAddressSchema.optional(),
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
      // `null` runs the ADR-0070 §5 detach; a cuid ATTACHES — but only to a node that carries no
      // asset yet. Swapping the asset of an already-linked node (a RE-POINT) is a 400, because it
      // would drop the previous link without the §5 detach and orphan an auto-created asset (#1117).
      // That rule needs the node's CURRENT `assetId`, which a schema never sees, so it is enforced
      // in `InfraService.updateNode` — along with the soft-delete-scoped liveness check on the id.
      assetId: z.cuid().nullable(),
      // Format-validated (ADR-0090, #847); `null` clears the IP (stamped MANUAL server-side).
      ipAddress: IpAddressSchema.nullable(),
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

// ── Node drill-in detail (ADR-0070 §6) — the asset-backed payoff panel ────────────────────────────

/**
 * The active owner of an asset-backed node, surfaced through the node's linked Asset's active
 * `AssetAssignment` (asset-centric ownership — ADR-0004/0019; ownership is a join, never a column).
 * A lean summary (NOT the full User row): just enough to render an avatar + name. An asset may have
 * 0..n active owners (multi-owner), so the drill-in carries an array. `userId` is the User uuid.
 */
export const InfraNodeOwnerSchema = z.object({
  assignmentId: z.cuid(),
  userId: z.uuid(),
  firstName: z.string(),
  lastName: z.string(),
  email: z.email(),
  /** Non-null when the owner left the company but the assignment was never released (history kept). */
  deletedAt: z.iso.datetime().nullable(),
});

/**
 * A child node — one hosted on this node via an ACTIVE inverse `RUNS_ON` edge (ADR-0070 §6: "the
 * children list derived from RUNS_ON edges"). A lean summary so the panel can list + link to each
 * child without a second round-trip.
 */
export const InfraNodeChildSchema = z.object({
  id: z.cuid(),
  label: z.string(),
  kind: InfraNodeKindSchema,
  status: InfraNodeStatusSchema,
});

/**
 * A secret reference surfaced on the drill-in — HANDLES ONLY, NEVER a decrypted value (INV-10,
 * [[0061-secret-manager-zero-knowledge]]). The handle is the `{{ lazyit_secret.HANDLE }}` chip token;
 * `label` is the human title. Deliberately carries NO ciphertext/iv/authTag — the server is
 * structurally incapable of decryption and this surface must never approach the value side.
 *
 * Populated from a node's `InfraNodeSecretRef` soft links, resolved to LIVE SecretItem metadata at
 * read (ADR-0073, issue #801). A ref whose secret was soft-deleted or renamed away (the handle is
 * editable + only live-unique) is dropped on resolution — never a dangling chip.
 */
export const InfraSecretRefSchema = z.object({
  handle: z.string(),
  label: z.string(),
  vaultId: z.cuid(),
});

/**
 * A lean, DISPLAY-ONLY reference to a live Asset, surfaced on the node drill-in (ADR-0093 §7/§8) — just
 * enough for a human to recognise the row before they act on it. Three fields, deliberately: the `id`
 * for a click-through, the `name` the operator curated, and the `serial` that is the whole basis on
 * which the server matched it. NOT the Asset shape — a full Asset on a node read is a second inventory
 * API nobody asked for, and this must stay cheap enough to compute on every drill-in.
 */
export const InfraAssetCandidateSchema = z.object({
  id: z.cuid(),
  name: z.string(),
  serial: z.string().nullable(),
});

/**
 * `GET /infra/nodes/:id` — the enriched drill-in (ADR-0070 §6). The whole reason to build this over a
 * Draw.io diagram: the node PLUS its asset-backed payoff (owner, KB links, secret handles, shortcuts,
 * IP) and its children (active inverse RUNS_ON). `label` is the canvas display name and always wins;
 * `assetName` is the secondary "inventory name" from the linked Asset (null when graph-only). The KB
 * links reuse the lean `ArticleListItem` shape (PUBLISHED only, folder-scoped to the caller).
 */
export const InfraNodeDetailSchema = InfraNodeSchema.extend({
  /** The linked Asset's `name` (the secondary "inventory name"); null when the node is graph-only. */
  assetName: z.string().nullable(),
  /**
   * WHICH DETACH this node's link would run (#1202) — the linked Asset's `_infraAutoCreated`
   * provenance marker, projected as a boolean.
   *
   * `PATCH { assetId: null }` has two materially different outcomes and the client could not tell
   * them apart until this field existed: `true` means lazyit minted the Asset, so a detach
   * **soft-deletes** it (`AssetsService.remove` — a DELETED history event, dropped from search);
   * `false` means a human curated it, so a detach **only un-links** and the row is untouched. That
   * is the ADR-0093 §4 marker rule, and it is deliberately never stamped on the adopt branch.
   *
   * Display-only, computed per read, and NEVER a gate — the `ipConflict`/`assetCandidate` mold. The
   * detach re-derives its own answer from `specs` at the moment it runs, so a stale value can only
   * mis-word a dialog, never mis-delete a row.
   *
   * `.nullish()` for read tolerance (CLAUDE.md #8): an older API omits it entirely, and a graph-only
   * node has no link to describe. **A consumer must treat null/absent as the DESTRUCTIVE branch** —
   * unknown provenance is exactly when a confirmation must not promise "nothing will be deleted".
   */
  assetAutoCreated: z.boolean().nullish(),
  /** Active owners via the linked Asset's `AssetAssignment`s; `[]` when graph-only or unowned. */
  owners: z.array(InfraNodeOwnerSchema),
  /** PUBLISHED KB articles linked to the node's Asset (folder-scoped); `[]` when graph-only. */
  articleLinks: z.array(ArticleListItemSchema),
  /** Secret HANDLES only (never values, INV-10); resolved from the node's links (ADR-0073, #801). */
  secretRefs: z.array(InfraSecretRefSchema),
  /** Nodes hosted on this one via an ACTIVE inverse RUNS_ON edge. */
  children: z.array(InfraNodeChildSchema),
  /**
   * SOFT duplicate-IP signal (ADR-0090, #847): other LIVE nodes carrying this node's exact `ipAddress`
   * (lean `{ id, label, kind, status }` peers, self excluded). Display-only — a badge on the drill-in;
   * it NEVER blocks a create/update and there is NO DB uniqueness. `[]` when the node has no IP or no
   * peer shares it. `.nullish()` for read tolerance: an older API omits it → web treats it as "no
   * conflict". Exact-string match, so the same IPv6 typed in two forms won't pair (accepted best-effort).
   */
  ipConflict: z.array(InfraNodeChildSchema).nullish(),
  /**
   * The agent-policy generation this node last ECHOED (#1140) — the acknowledgement half of the
   * policy channel, and the difference between having central configuration and believing you have
   * it. Compare it to the instance revision from `GET /infra/agent-policy`: equal means *applied*,
   * lower means *pending* until this host's next check-in.
   *
   * Null for a manual node and for any agent that predates the policy channel — which the UI must
   * render as "not reporting a policy", never as "pending", since a pre-#1140 agent will never echo
   * one however long it is waited for.
   */
  policyRevision: z.number().int().nonnegative().nullish(),
  /**
   * When the echoed revision last CHANGED — i.e. when this host actually picked a new policy up.
   *
   * The node's OWN policy override is deliberately NOT part of this shape. It exists as a column and
   * as `PUT /infra/nodes/:id/agent-policy`, but the shipped UI edits the instance default only, so
   * declaring the override here would advertise a drill-in surface this build does not have.
   */
  policyAppliedAt: z.iso.datetime().nullish(),
  /**
   * FORESIGHT at the confirm gate (ADR-0093 §7): the live Asset a confirm would ADOPT rather than
   * mint, so the tray can say *"Confirm will link **Dell-XPS-7490** (existing)"* instead of *"will
   * create"*. `null` means a confirm mints a brand-new Asset — today's behaviour.
   *
   * Computed per read, DISPLAY-ONLY, and NEVER a gate: the confirm re-derives its own answer from the
   * node as it stands at that moment, so a stale or absent candidate can only ever mislead a human,
   * never mis-link a machine. `trackAsAsset` stays a boolean on a `strictObject` precisely because
   * what the operator needed was this, not a new input — adoption is HOW `true` is satisfied, chosen
   * by the server from evidence, not a third thing the caller asks for.
   *
   * Populated only for a node that is **PENDING and carries no Asset** — the one state in which a
   * confirm can still adopt — and only when the ADR-0093 §3a corroboration gate is satisfied, so a
   * populated field is a promise the confirm will keep rather than an optimistic guess.
   * `.nullish()` for read tolerance, the [[0090-ipam-validated-ip]] `ipConflict` mold: an older API
   * omits it and web reads that as "will create".
   */
  assetCandidate: InfraAssetCandidateSchema.nullish(),
  /**
   * DUPLICATE SUSPICION (ADR-0093 §8.5) — for the installs that already minted duplicates before
   * adoption existed. The #1081 collision retry answered *"this serial already exists"* with *"then
   * make a second Asset without one"*, and its outcome is cheaply recognisable: this node's linked
   * Asset was auto-created (`_infraAutoCreated`), carries a **null** serial, and the node's reported
   * `specs.host.hardware.serial` sanitizes to a value a DIFFERENT live Asset holds. That other Asset
   * is what this field names.
   *
   * A HINT, never a gate, and never an automatic merge. Machine-merging two inventory rows —
   * assignments, history, tags, attachments — is not something an upgrade does while nobody is
   * looking. The remedy is the existing deliberate two-step (§7): `assetId: null` to detach (the
   * auto-created Asset carries the marker, so it is soft-deleted), then a second patch carrying the
   * curated id. `null` in the overwhelmingly normal case.
   */
  duplicateAssetSuspicion: InfraAssetCandidateSchema.nullish(),
});

/**
 * `GET /infra/nodes` list row (ADR-0070 §6, issue #750). The lean `InfraNodeSchema` plus the two
 * facts the Servers list shows inline — the linked Asset's inventory `name` and its active owners —
 * so the list can render + search them WITHOUT an N+1 detail fetch per row. A SIBLING of
 * `InfraNodeSchema` (NOT a mutation of it) because other callers depend on the lean node shape.
 * Owners reuse the same lean `InfraNodeOwnerSchema` as the drill-in, so the "departed owner"
 * (deletedAt set) affordance renders identically. `assetName` is null when the node is graph-only
 * or its linked asset is soft-deleted (the API never leaks a detached/archived asset's name).
 *
 * MINUS `specs` (issue #1135). On an agent-reported host the blob is the WHOLE inventory — the full
 * installed-software list, ~1500 entries — and this list is polled by the PENDING tray every 40s and
 * by the create-agent wizard every 5s, so carrying it per row makes a liveness poll cost megabytes.
 * Nothing renders `specs` from a list row: the reported-facts section reads it off the drill-in
 * (`InfraNodeDetailSchema`, `GET /infra/nodes/:id`), which deliberately keeps the full blob. The
 * `omit` is what stops the contract from lying — the API's projection no longer selects the column.
 */
export const InfraNodeListItemSchema = InfraNodeSchema.omit({
  specs: true,
}).extend({
  /** The linked Asset's `name` (inventory name); null when graph-only or the asset is soft-deleted. */
  assetName: z.string().nullable(),
  /** Active owners via the linked Asset's `AssetAssignment`s; `[]` when graph-only or unowned. */
  owners: z.array(InfraNodeOwnerSchema),
});

// ── Node → secret linkage (ADR-0073, issue #801) ──────────────────────────────────────────────────

/**
 * Attach (or detach) a secret HANDLE reference to a node — the request body for
 * `POST`/`DELETE /infra/nodes/:id/secrets`. A SOFT reference (handle + vaultId, NO FK), mirroring the
 * KB chip + SecretAuditLog convention: the server stores metadata only, never a value (INV-10,
 * [[0061-secret-manager-zero-knowledge]]). `handle` is the editable, live-unique secret identifier
 * (max 80, matching SecretItem.handle); `vaultId` scopes it to the vault the caller must be a LIVE
 * member of (the layer-2 authz the API enforces). The node id is the route param, the actor the
 * X-User-Id principal — neither rides in the body (house style). Detach reuses this exact shape.
 */
export const AttachInfraSecretSchema = z.strictObject({
  handle: z.string().trim().min(1).max(80),
  vaultId: z.cuid(),
});

// ── Server reporting agent (ADR-0074 §2) — the wire contract v2 (#1138) ───────────────────────────
//
// Contract v2 makes the wire genuinely OS-neutral, which ADR-0074 §1 always claimed and the v1 shape
// was not: it had no platform discriminator to branch on, carried IPv4 only (a v6-only host reported
// no address at all), and documented its single identity key as `/etc/machine-id` — which Windows and
// macOS do not have. Every v2 field is ADDITIVE and OPTIONAL, except `os.family`, which is defaulted
// so a pre-v2 agent keeps reporting through an instance upgrade untouched. See the ADR-0074 §2
// amendment (2026-07-31, #1138) for the full reasoning.
//
// DEGRADE, NEVER REJECT — the posture every vocabulary below follows. An unknown enum VALUE is not a
// 400: an enum member is a guess about a world (chassis types, hypervisors, package managers) that
// keeps producing values we did not enumerate, and rejecting one costs the operator a whole HOST.
// Vocabularies with a natural unknown member fall back to it (`other`/`unknown`); `software[].source`,
// which has none, degrades to absent. The fact is lost; the host is not.

/**
 * The platform discriminator (#1138) — the one thing every downstream consumer needs to branch on
 * (auto-classification, per-OS collectors, the fleet view). REQUIRED on the wire but DEFAULTED to
 * `linux` server-side, because every agent that exists before v2 is a Linux-only collector: an
 * upgraded server reading an old report is reading a Linux host, and saying so is honest rather than
 * inventing an `unknown`.
 */
export const AgentOsFamilySchema = z.enum(["linux", "windows", "darwin", "bsd", "other"]);

// `AgentChassisSchema` — the host form-factor vocabulary — is declared EARLY, above the InfraNode wire
// shape, because `InfraNodeSchema.chassis` (ADR-0093 §2) persists it as a column and a `const` cannot
// be referenced before it is evaluated. It belongs to this contract-v2 vocabulary block conceptually.

/**
 * The virtualization technology the host runs UNDER (`none` = bare metal). `other` is deliberate and
 * load-bearing: `systemd-detect-virt` alone emits ~30 values and every OS adds more, so an
 * unenumerated hypervisor degrades to "virtualized, kind unknown" instead of 400-ing the report.
 */
export const AgentVirtualizationTypeSchema = z.enum([
  "none",
  "kvm",
  "vmware",
  "hyperv",
  "xen",
  "lxc",
  "docker",
  "wsl",
  "other",
]);

/**
 * A corroborating host identifier (#1138) — the set the identity/dedup work (#1141) consumes to
 * recognise the SAME host across a re-install, a NIC swap or an OS reinstall. `externalId` remains
 * the PRIMARY dedup key (ADR-0074 §3: one host = one node, forever); these are evidence beside it,
 * never a second key. `machine-id` is Linux, `windows-machine-guid` Windows, `platform-uuid` macOS,
 * `smbios-uuid`/`serial`/`mac` are cross-platform hardware facts.
 *
 * `other` is a LABELLED escape hatch, not an inert one: an identifier whose `kind` this build does
 * not recognise keeps its wire label in `namespace` (see {@link AgentIdentifierSchema}). That is the
 * deliberate asymmetry with `software[].source`, which degrades to ABSENT — a package's `source` is
 * decoration on a fact that stands alone (the package name is still fully usable without it), while
 * an identifier's `kind` is CONSTITUTIVE: a value with no kind cannot be compared to anything. The
 * only degradations available are "drop the evidence" or "keep it under a catch-all", so we keep it,
 * and we keep the label with it so two different unknown kinds never collapse into one.
 */
export const AgentIdentifierKindSchema = z.enum([
  "machine-id",
  "smbios-uuid",
  "windows-machine-guid",
  "platform-uuid",
  "serial",
  "mac",
  "other",
]);

/**
 * The lifecycle state a container runtime reports (#1139) — Docker's `State` vocabulary, which
 * Podman and containerd mirror. `unknown` is the landing spot for anything else, on the same
 * degrade-never-reject rule as every other vocabulary here: a runtime that invents a state must cost
 * the operator a FACT, never the container.
 */
export const AgentContainerStateSchema = z.enum([
  "running",
  "created",
  "restarting",
  "paused",
  "exited",
  "removing",
  "dead",
  "unknown",
]);

/** Transport of a published container port. `sctp` is rare but real; the runtimes all emit it. */
export const AgentContainerPortProtocolSchema = z.enum(["tcp", "udp", "sctp"]);

/**
 * The hypervisor PLATFORM an agent found itself running on (ADR-0095) — the vocabulary the guest
 * inventory branches on (which CLI/API the collector used, which `ref` format the guests carry).
 * `other` is deliberate and load-bearing on the same degrade-never-reject rule as every vocabulary
 * here: the hypervisor world keeps producing platforms we did not enumerate, and rejecting one would
 * cost the operator a whole HOST — the value folds to `other` and the guests still land.
 */
export const AgentHypervisorPlatformSchema = z.enum([
  "proxmox",
  "hyperv",
  "libvirt",
  "xcpng",
  "other",
]);

/**
 * What KIND of guest the hypervisor runs (ADR-0095) — the fact {@link guestNodeKind} projects into
 * the child node's `kind` (`lxc` is a CONTAINER, everything else a VM). Named after the technology
 * rather than the platform because Proxmox alone spans two of them (`qemu` VMs + `lxc` containers).
 * An unknown value folds to `other`, never a 400.
 */
export const AgentGuestKindSchema = z.enum(["qemu", "lxc", "hyperv", "libvirt", "other"]);

/**
 * The lifecycle state the hypervisor reports for a guest (ADR-0095) — the container-state analogue
 * one level up ({@link AgentContainerStateSchema}), collapsed to the states every platform agrees
 * on. `other` is the landing spot for anything else: a platform that invents a state must cost the
 * operator a FACT, never the guest.
 */
export const AgentGuestStateSchema = z.enum([
  "running",
  "stopped",
  "paused",
  "suspended",
  "other",
]);

/**
 * What a report says about the installed-software list (#1142) — **FOUR answers, not two.**
 *
 * Before this field the wire had exactly two: a `software` array, or nothing. The server read
 * "nothing" as "no software" and DELETED whatever it held. That reading was at least uniform:
 * `applySoftwarePolicy` returned `undefined` for every empty outcome alike — a policy that turned the
 * collector off (#1140), a collector that could not enumerate, a filter that excluded every package —
 * so the absent key really did carry nothing beyond "no list in this report". It is the wrong reading
 * of the case #1142 introduces, where the agent omits an unchanged list to save ~90% of the payload.
 * Collapsing those outcomes into one absent key gives an operator either an inventory that silently rots
 * (a frozen package list from months ago, with nothing on screen saying so) or one that silently
 * empties. This enum is what keeps them apart:
 *
 *  - `reported` — the list is IN this report; store it.
 *  - `unchanged` — identical to the last accepted report; **keep what is stored**. `softwareHash`
 *    says WHICH list, so the server can tell an honest delta from a claim it cannot corroborate.
 *  - `unavailable` — the collector could not enumerate packages (no supported package manager, a
 *    timed-out `dpkg-query`); **keep what is stored**, because "I could not look" is not "there is
 *    nothing". `diagnostics.warnings` usually names the reason — the collector is silent about a
 *    plain non-zero exit, which is an ANSWER elsewhere in the agent rather than a degradation.
 *  - `disabled` — the agent policy says do not report software; **clear the stored list**, so the
 *    panel stops showing an inventory nobody is collecting any more.
 *
 * An UNRECOGNISED value degrades to `unavailable`, not to absent — see the field on
 * {@link AgentReportSchema}. Every other vocabulary in this contract degrades toward "we know less";
 * this is the one where "we know less" and "delete the operator's data" are different directions, and
 * the safe one is named.
 */
export const AgentSoftwareStateSchema = z.enum([
  "reported",
  "unchanged",
  "unavailable",
  "disabled",
]);
export type AgentSoftwareState = z.infer<typeof AgentSoftwareStateSchema>;

/**
 * Cap on `softwareHash`. Comfortably above what {@link softwareFingerprint} produces, so the cap is a
 * bound on an attacker-controlled string that lands in a jsonb column, never a rejection of an agent
 * whose fingerprint format this build does not recognise.
 */
export const AGENT_SOFTWARE_HASH_MAX = 64;

/** Where a listed package came from — the provenance that makes a cross-OS software list comparable. */
export const AgentSoftwareSourceSchema = z.enum([
  "dpkg",
  "rpm",
  "apk",
  "registry",
  "msi",
  "appx",
  "winget",
  "brew",
  "app-bundle",
  "pkg",
]);

/**
 * IPv6 address scope as the OS reports it (`ip -j addr`'s `scope`, Windows' equivalent). Carried so
 * the promotion mapper can tell a routable address from one that is only meaningful on the wire it
 * sits on — see {@link primaryIpv6}.
 */
export const AgentIpv6ScopeSchema = z.enum(["global", "site", "link", "host"]);

/**
 * Cap on `host.identifiers` — a corroborating SET, not a log; a sane upper bound, not a real limit.
 * Enforced by TRUNCATION, never by a 400: these fields exist to serve agents that are NOT
 * version-locked to the instance, so making them the contract's only hard rejections would defeat
 * the amendment they belong to.
 */
export const AGENT_IDENTIFIERS_MAX = 16;

/** Cap on a single identifier value — long enough for any real UUID/serial, short enough to be inert. */
export const AGENT_IDENTIFIER_VALUE_MAX = 200;

/**
 * The wire cap on `externalId`. Named rather than inlined because #1141's {@link disambiguateExternalId}
 * has to bound the key it derives against the same number.
 */
export const AGENT_EXTERNAL_ID_MAX = 200;

/** Caps on `diagnostics.warnings` — same truncate-don't-reject rule as the identifier set. */
export const AGENT_WARNINGS_MAX = 50;
export const AGENT_WARNING_LENGTH_MAX = 300;

/**
 * Cap on `host.containers` (#1139) — TRUNCATED past it, never rejected, same rule as the identifier
 * set. 100 is deliberately generous for the estate ADR-0074 targets (a 5–20-person shop running
 * Docker Compose) while still bounding what ONE report can ask the server to enrol: every element
 * past the cap would be a child NODE, and the #1134 enrollment throttle charges each one. A host
 * genuinely running more than 100 containers is a Kubernetes node, which is
 * a different product conversation than the one ADR-0074 §1 scoped.
 */
export const AGENT_CONTAINERS_MAX = 100;

/** Cap on the published-port list of ONE container — an inventory fact, not a port scan. */
export const AGENT_CONTAINER_PORTS_MAX = 32;

/**
 * Cap on `host.guests` (ADR-0095) — TRUNCATED past it, never rejected, same rule as
 * {@link AGENT_CONTAINERS_MAX}. Deliberately larger than the container cap: one hypervisor NODE
 * legitimately runs hundreds of guests (a Proxmox host in a homelab-to-SMB estate commonly carries
 * 50–200), and every element past the cap would be a child node the #1134 enrollment throttle
 * charges — 500 bounds what ONE report can ask the server to enrol while losing nobody real.
 */
export const AGENT_GUESTS_MAX = 500;

/** Cap on ONE guest's reported MAC list — corroborating evidence (#1141), not a NIC inventory. */
export const AGENT_GUEST_MACS_MAX = 16;

/**
 * The CANONICAL form of an identifier value for its kind (#1138) — the rule #1141 reconciles across
 * operating systems. Without it the same physical host produces non-equal evidence depending on who
 * read it: Windows prints a MAC as `AA-BB-CC-DD-EE-FF`, Linux as `aa:bb:cc:dd:ee:ff`, some switch
 * agents as `aabb.ccdd.eeff`; a `product_uuid` comes back braced and upper-cased on Windows and bare
 * lower-case on Linux. Three spellings of one fact are three hosts to anything that compares strings,
 * so the contract — not each consumer — decides the spelling, and it decides it at PARSE time so the
 * canonical form is what gets stored and what any future consumer sees.
 *
 * Deliberately conservative: a value that does not fit its kind's expected shape is trimmed and
 * otherwise left alone rather than mangled. Serial CASE is preserved — vendors ship case-significant
 * serials and upper-casing them would manufacture collisions on the unique `Asset.serial`.
 */
export function normalizeIdentifierValue(kind: AgentIdentifierKind, value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  switch (kind) {
    case "mac":
      return normalizeMacValue(trimmed);
    case "smbios-uuid":
    case "platform-uuid":
    case "windows-machine-guid":
      return normalizeUuidValue(trimmed);
    case "machine-id":
      // Hex, and the only variance between readers is casing.
      return trimmed.toLowerCase();
    case "serial":
      // dmidecode and WMI disagree on internal padding; casing is meaningful, whitespace is not.
      return trimmed.replace(/\s+/g, " ");
    default:
      return trimmed;
  }
}

/** `AA-BB-CC-DD-EE-FF` / `aabb.ccdd.eeff` / `AABBCCDDEEFF` → `aa:bb:cc:dd:ee:ff` (EUI-48 and EUI-64). */
function normalizeMacValue(value: string): string {
  const hex = value.replace(/[^0-9a-fA-F]/g, "").toLowerCase();
  // 12 hex = EUI-48, 16 = EUI-64, 40 = InfiniBand. Anything else is not a MAC we can regroup safely.
  if (hex.length === 12 || hex.length === 16 || hex.length === 40) {
    return (hex.match(/../g) ?? []).join(":");
  }
  return value.toLowerCase();
}

/** `{4C4C4544-…}` / `4C4C4544…` (undashed) → the bare lower-case dashed 8-4-4-4-12 form. */
function normalizeUuidValue(value: string): string {
  const bare = value.replace(/^[{(]+/, "").replace(/[)}]+$/, "").trim().toLowerCase();
  const hex = bare.replace(/-/g, "");
  if (!/^[0-9a-f]{32}$/.test(hex)) return bare;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * dmidecode serial placeholders that mean "no real serial" — OEMs ship these literal strings on
 * boards nobody flashed. Lower-cased for a case-insensitive match. `"0"` is also caught by the
 * all-same-char guard below, but listed for clarity.
 */
const SERIAL_JUNK_PLACEHOLDERS = new Set([
  "to be filled by o.e.m.",
  "system product name",
  "default string",
  "none",
  "not specified",
  "o.e.m.",
  "not applicable",
  "0",
]);

/**
 * SMBIOS/platform UUIDs shipped verbatim on whole production runs of consumer boards. All-zero and
 * all-F are also caught by the repeated-character rule once separators are stripped; they are listed
 * because naming them is the documentation, and a reader should not have to derive it.
 */
const PLACEHOLDER_IDENTITY_UUIDS = new Set([
  "03000200-0400-0500-0006-000700080009",
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
]);

/** A single character repeated (`000000`, `......`) is a placeholder, not a real identity value. */
const isRepeatedCharacter = (value: string): boolean => /^(.)\1*$/.test(value);

/**
 * The kinds whose canonical form is hex digits plus separators. Only these get the separator-stripped
 * repetition check: `serial` keeps its #1081 rule verbatim (vendor formats are arbitrary, and
 * stripping `-` from a real serial could turn a legitimate one into a false placeholder), and `other`
 * is an opaque vendor tag we have no shape for.
 */
const HEX_IDENTIFIER_KINDS = new Set<AgentIdentifierKind>([
  "machine-id",
  "smbios-uuid",
  "platform-uuid",
  "windows-machine-guid",
  "mac",
]);

/**
 * The junk rule shared by every identity value we might promote — one list, one place. Extracted from
 * {@link sanitizeSerial} (#1081) rather than re-derived, so `Asset.serial` and `host.identifiers`
 * can never disagree about what counts as evidence.
 */
function isJunkIdentityValue(value: string): boolean {
  return SERIAL_JUNK_PLACEHOLDERS.has(value.toLowerCase()) || isRepeatedCharacter(value);
}

/**
 * The canonical form of an identifier value, or `undefined` when the value is JUNK (#1138).
 *
 * Normalisation alone was not enough: `normalizeIdentifierValue` made `Default string` and
 * `03000200-0400-0500-0006-000700080009` *consistently spelled*, which is exactly the wrong outcome
 * for evidence. #1141 corroborates hosts by COMPARING these values, so two unrelated boards both
 * reporting an OEM placeholder would match as the same physical host — a confidently wrong CMDB,
 * which is worse than an empty one. The `Asset.serial` path had refused these strings since #1081;
 * this reuses that same list instead of opening a second door for the same junk.
 *
 * Callers must OMIT an identifier that sanitizes to nothing — never emit it with an empty value.
 */
export function sanitizeIdentifierValue(
  kind: AgentIdentifierKind,
  value: string,
): string | undefined {
  const normalized = normalizeIdentifierValue(kind, value);
  if (!normalized || isJunkIdentityValue(normalized)) return undefined;
  if (PLACEHOLDER_IDENTITY_UUIDS.has(normalized)) return undefined;
  // The separators are what let junk through the check above: `00:00:00:00:00:00` and
  // `00000000-0000-0000-0000-000000000000` are not "all the same character" until they are stripped.
  if (HEX_IDENTIFIER_KINDS.has(kind) && isRepeatedCharacter(normalized.replace(/[-:.]/g, ""))) {
    return undefined;
  }
  return normalized;
}

/**
 * One corroborating identifier, canonicalised and SANITIZED at parse time (#1138). Every field
 * degrades rather than rejects — `.catch("")` covers a missing/wrong-typed key, and an identifier
 * left with no usable value (absent, empty, or junk) is dropped by the array below instead of
 * 400-ing the whole report.
 *
 * An unrecognised `kind` becomes `other` and its wire label is preserved in `namespace`, so the
 * relabel is visible to a human and distinguishable from a different unknown kind. `namespace` is
 * also how an agent deliberately namespaces its own identifier (`{ kind: 'other', namespace:
 * 'vendor:acme-tag' }`) — the escape hatch carries meaning instead of swallowing it.
 */
const AgentIdentifierObjectSchema = z
  .object({
    kind: z
      .string()
      .catch("")
      .transform((v) => v.trim().slice(0, 60)),
    namespace: z
      .string()
      .catch("")
      .transform((v) => v.trim().slice(0, 60)),
    value: z
      .string()
      .catch("")
      .transform((v) => v.trim().slice(0, AGENT_IDENTIFIER_VALUE_MAX)),
  })
  .transform((raw) => {
    const known = AgentIdentifierKindSchema.safeParse(raw.kind);
    const kind = known.success ? known.data : ("other" as const);
    // An unknown kind is not thrown away: it becomes the namespace, unless the agent already set one.
    const namespace = raw.namespace || (known.success ? "" : raw.kind);
    return {
      kind,
      ...(namespace ? { namespace } : {}),
      value: sanitizeIdentifierValue(kind, raw.value) ?? "",
    };
  });

/**
 * The wire form of {@link AgentIdentifierObjectSchema}, tolerant of a NON-OBJECT element — the same
 * posture {@link AgentNicIpv6Schema} takes, on the same reasoning: a third-party or older collector
 * sending the wrong shape must degrade to a dropped element, not make the whole host vanish from the
 * inventory with a 400. A non-object has no `kind`, and a value with no kind cannot be compared to
 * anything, so it collapses to `{}` and the array below drops it. The drop is never silent —
 * {@link agentReportSkewPaths} records it against `host.identifiers`.
 */
export const AgentIdentifierSchema = z.preprocess(
  (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {}),
  AgentIdentifierObjectSchema,
);
export type AgentIdentifier = z.infer<typeof AgentIdentifierSchema>;

/**
 * One published port of a container (#1139). `containerPort` is the only required field — a port
 * mapping with no container-side port is not a mapping — so an element without one is dropped by the
 * array below. Every other field degrades to absent: a runtime that omits `hostPort` published the
 * port on an ephemeral/random one, which is still worth recording as "this port is exposed".
 */
const AgentContainerPortObjectSchema = z
  .object({
    containerPort: z.number().int().min(0).max(65535).optional().catch(undefined),
    hostPort: z.number().int().min(0).max(65535).optional().catch(undefined),
    hostIp: z
      .string()
      .optional()
      .catch(undefined)
      .transform((v) => v?.trim().slice(0, 64) || undefined),
    protocol: AgentContainerPortProtocolSchema.optional().catch(undefined),
  })
  // Emit only the keys the runtime actually reported: a stored blob full of explicit `undefined`s
  // reads as "we looked and found nothing" where the truth is "we were never told".
  .transform((raw) => ({
    ...(raw.containerPort !== undefined ? { containerPort: raw.containerPort } : {}),
    ...(raw.hostPort !== undefined ? { hostPort: raw.hostPort } : {}),
    ...(raw.hostIp !== undefined ? { hostIp: raw.hostIp } : {}),
    ...(raw.protocol !== undefined ? { protocol: raw.protocol } : {}),
  }));

/** The wire form, tolerant of a non-object element — the posture every array in this contract takes. */
const AgentContainerPortSchema = z.preprocess(
  (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {}),
  AgentContainerPortObjectSchema,
);

/**
 * One container the host runs (#1139) — the child node the server mints, with an active `RUNS_ON`
 * edge back to the reporting host. This is the first contract field that describes something OTHER
 * than the reporting host itself, which is why `name` carries the whole weight: it is the IDENTITY
 * KEY (see {@link containerExternalId}), and identity keys in this contract are permanent (ADR-0074
 * §3 — one thing = one node, forever).
 *
 * `name` and NOT the runtime's container `id`, deliberately. A container id is regenerated on every
 * `docker compose up --force-recreate`, every image bump and every `restart: always` rebuild, so an
 * id-keyed node would mint a fresh PENDING proposal on each deploy and leave the old one behind — the
 * duplicate-node failure this contract's host key was designed to avoid, reproduced one level down.
 * A compose service's name is stable exactly across those events and is also what the operator calls
 * the thing. The id still ships as corroborating EVIDENCE (like `host.identifiers`), never as a key.
 *
 * Every other field degrades to absent; an element left with no usable `name` is dropped by the array
 * rather than 400-ing the whole host, and the drop is recorded by {@link agentReportSkewPaths}.
 */
const AgentContainerObjectSchema = z
  .object({
    name: z
      .string()
      .catch("")
      .transform((v) => v.trim().slice(0, 200)),
    /** The runtime's own container id — corroborating evidence, NEVER the identity key (see above). */
    id: z
      .string()
      .optional()
      .catch(undefined)
      .transform((v) => v?.trim().slice(0, 128) || undefined),
    image: z
      .string()
      .optional()
      .catch(undefined)
      .transform((v) => v?.trim().slice(0, 300) || undefined),
    /** The immutable content digest — what actually pins "which build is running" across a tag reuse. */
    imageDigest: z
      .string()
      .optional()
      .catch(undefined)
      .transform((v) => v?.trim().slice(0, 200) || undefined),
    /**
     * ABSENT and `unknown` are different answers and both are kept: absent means the collector did
     * not report a state at all, `unknown` means it reported one this build does not enumerate. A
     * plain `.catch(undefined)` would have collapsed the second into the first and lost the fact that
     * the runtime said SOMETHING — which is exactly the skew signal #1138 exists to preserve.
     */
    state: z
      .string()
      .optional()
      .catch(undefined)
      .transform((v) =>
        v === undefined
          ? undefined
          : (AgentContainerStateSchema.safeParse(v.trim().toLowerCase()).data ?? "unknown"),
      ),
    ports: z
      .array(AgentContainerPortSchema)
      .optional()
      .catch(undefined)
      .transform((list) => {
        const kept = list
          ?.filter((p) => p.containerPort !== undefined)
          .slice(0, AGENT_CONTAINER_PORTS_MAX);
        return kept?.length ? kept : undefined;
      }),
  })
  .transform((raw) => ({
    name: raw.name,
    ...(raw.id !== undefined ? { id: raw.id } : {}),
    ...(raw.image !== undefined ? { image: raw.image } : {}),
    ...(raw.imageDigest !== undefined ? { imageDigest: raw.imageDigest } : {}),
    ...(raw.state !== undefined ? { state: raw.state } : {}),
    ...(raw.ports !== undefined ? { ports: raw.ports } : {}),
  }));

/** The wire form of {@link AgentContainerObjectSchema}, tolerant of a non-object element. */
export const AgentContainerSchema = z.preprocess(
  (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {}),
  AgentContainerObjectSchema,
);
export type AgentContainer = z.infer<typeof AgentContainerSchema>;

/**
 * The hypervisor a reporting host RUNS (ADR-0095) — a fact about the host itself, unlike
 * {@link AgentVirtualizationTypeSchema}, which says what the host runs UNDER. `platform` is the only
 * key with weight (the discriminator every consumer branches on) and it FOLDS rather than rejects:
 * an unenumerated platform degrades to `other` and the guest list still lands. The optional facts
 * are display context (`clusterName`/`nodeName` are how a Proxmox operator names the box), trimmed
 * and capped like every sibling string.
 */
const AgentHypervisorObjectSchema = z
  .object({
    platform: z
      .string()
      .catch("")
      .transform(
        (v) => AgentHypervisorPlatformSchema.safeParse(v.trim().toLowerCase()).data ?? "other",
      ),
    version: z
      .string()
      .optional()
      .catch(undefined)
      .transform((v) => v?.trim().slice(0, 120) || undefined),
    clusterName: z
      .string()
      .optional()
      .catch(undefined)
      .transform((v) => v?.trim().slice(0, 200) || undefined),
    nodeName: z
      .string()
      .optional()
      .catch(undefined)
      .transform((v) => v?.trim().slice(0, 200) || undefined),
  })
  // Emit only what was reported — same rule as the container element (never stored explicit
  // `undefined`s that read as "we looked and found nothing").
  .transform((raw) => ({
    platform: raw.platform,
    ...(raw.version !== undefined ? { version: raw.version } : {}),
    ...(raw.clusterName !== undefined ? { clusterName: raw.clusterName } : {}),
    ...(raw.nodeName !== undefined ? { nodeName: raw.nodeName } : {}),
  }));
export type AgentHypervisor = z.infer<typeof AgentHypervisorObjectSchema>;

/**
 * One guest the hypervisor runs (ADR-0095) — the container child contract (#1139) one level up: a
 * child node the server mints, with an active `RUNS_ON` edge back to the reporting host.
 *
 * `ref` is the IDENTITY KEY (see {@link guestExternalId}), and identity keys in this contract are
 * permanent (ADR-0074 §3 — one thing = one node, forever). It is the platform's own STABLE guest
 * identifier — the Proxmox VMID, the Hyper-V VM GUID, the libvirt domain UUID — chosen over `name`
 * (guests get renamed without being re-created, the exact inverse of the container tradeoff, where
 * the NAME is the stable half) and over the runtime instance id (regenerated per boot on some
 * platforms). `name` is the label the operator knows the guest by; an element left with no usable
 * ref OR name is dropped by the array rather than 400-ing the whole host.
 *
 * `smbiosUuid` and `macs` are corroborating identity EVIDENCE (#1141), never keys: they are what
 * lets a future agent installed INSIDE the guest be recognised as the same machine. Both arrive
 * canonicalised the one way the identifier contract canonicalises them ({@link
 * sanitizeIdentifierValue}), so the two sides can never disagree about the spelling of one fact —
 * a guarantee this JSDoc claimed before `smbiosUuid` actually honoured it (#1227).
 * Every other field degrades to absent on a nonsense value.
 */
const AgentGuestObjectSchema = z
  .object({
    ref: z
      .string()
      .catch("")
      .transform((v) => v.trim().slice(0, 200)),
    name: z
      .string()
      .catch("")
      .transform((v) => v.trim().slice(0, 200)),
    kind: z
      .string()
      .catch("")
      .transform((v) => AgentGuestKindSchema.safeParse(v.trim().toLowerCase()).data ?? "other"),
    /**
     * ABSENT and `other` are different answers and both are kept, exactly as the container element
     * keeps absent apart from `unknown`: absent means the platform reported no state at all, `other`
     * that it reported one this build does not enumerate — the skew signal #1138 preserves.
     */
    state: z
      .string()
      .optional()
      .catch(undefined)
      .transform((v) =>
        v === undefined
          ? undefined
          : (AgentGuestStateSchema.safeParse(v.trim().toLowerCase()).data ?? "other"),
      ),
    /**
     * The guest's SMBIOS UUID as the hypervisor assigns it — canonicalised through the SAME
     * {@link sanitizeIdentifierValue} the report side's `smbios-uuid` identifier goes through, which
     * is what makes the two comparable BY CONSTRUCTION rather than by luck (#1227).
     *
     * It used to be a bare `trim().toLowerCase()`, and that silently spelled one fact two ways: the
     * report side strips `{}` and re-hyphenates undashed hex, this side did neither. Proxmox dodged
     * it (PVE writes bare dashed lower-case) and Hyper-V dodged it (its collector strips the braces
     * itself), so the §6 join worked by collector accident on exactly the two platforms shipped —
     * and VMware's raw `bios_uuid`, which ADR-0095 §1 promises slots in with no contract change,
     * would have walked straight into it. Junk (all-zero, the OEM-baked placeholder runs) is now
     * DROPPED here too, matching the sibling `macs` rule: evidence that cannot corroborate must
     * never be stored as if it could.
     *
     * READ-TOLERANT BY CONSTRUCTION: the sanitiser is idempotent over the already-canonical values
     * every stored blob carries, so nothing needs a backfill and nothing re-proposes.
     *
     * THE TRUNCATION IS PART OF THE SYMMETRY, not an afterthought. `normalizeUuidValue` re-renders
     * anything UUID-shaped and returns everything else unchanged, so a long non-UUID value survives
     * both sides and is then CUT — and cutting it at 64 here while the report side cuts at
     * {@link AGENT_IDENTIFIER_VALUE_MAX} would make those two operands unequal for every value
     * between the two lengths, however perfectly normalised. Same `trim().slice(MAX)`-then-sanitize
     * order as {@link AgentIdentifierObjectSchema}, so the two really are one rule applied twice.
     */
    smbiosUuid: z
      .string()
      .optional()
      .catch(undefined)
      .transform((v) =>
        v === undefined
          ? undefined
          : sanitizeIdentifierValue("smbios-uuid", v.trim().slice(0, AGENT_IDENTIFIER_VALUE_MAX)),
      ),
    macs: z
      .array(z.string().catch(""))
      .optional()
      .catch(undefined)
      .transform((list) => {
        if (!list) return undefined;
        const kept: string[] = [];
        for (const raw of list) {
          // The one canonical MAC spelling (#1138), with junk (all-zero placeholders) dropped —
          // evidence that cannot corroborate must never be stored as if it could.
          const mac = sanitizeIdentifierValue("mac", raw);
          if (mac && !kept.includes(mac)) kept.push(mac);
          if (kept.length >= AGENT_GUEST_MACS_MAX) break;
        }
        return kept.length ? kept : undefined;
      }),
    cores: z.number().int().positive().optional().catch(undefined),
    memoryBytes: z.number().int().nonnegative().optional().catch(undefined),
    /** What the hypervisor believes the guest runs (`ostype`, a template hint) — a hint, never a fact. */
    osHint: z
      .string()
      .optional()
      .catch(undefined)
      .transform((v) => v?.trim().slice(0, 200) || undefined),
  })
  .transform((raw) => ({
    ref: raw.ref,
    name: raw.name,
    kind: raw.kind,
    ...(raw.state !== undefined ? { state: raw.state } : {}),
    ...(raw.smbiosUuid !== undefined ? { smbiosUuid: raw.smbiosUuid } : {}),
    ...(raw.macs !== undefined ? { macs: raw.macs } : {}),
    ...(raw.cores !== undefined ? { cores: raw.cores } : {}),
    ...(raw.memoryBytes !== undefined ? { memoryBytes: raw.memoryBytes } : {}),
    ...(raw.osHint !== undefined ? { osHint: raw.osHint } : {}),
  }));

/** The wire form of {@link AgentGuestObjectSchema}, tolerant of a non-object element. */
export const AgentGuestSchema = z.preprocess(
  (v) => (typeof v === "object" && v !== null && !Array.isArray(v) ? v : {}),
  AgentGuestObjectSchema,
);
export type AgentGuest = z.infer<typeof AgentGuestSchema>;

/**
 * One IPv6 address as the OS reports it (#1138). A bare `string[]` was not enough to choose a node's
 * displayed address: without scope and the RFC 4941 flags, "the first non-`fe80:` entry" can be a
 * TEMPORARY privacy address (regenerated on a timer) or a DEPRECATED one (past its preferred
 * lifetime) — either would put an address on the map that stops resolving to the host within hours.
 * `prefixLength` rides along because it is free at collection time and the alternative is inferring
 * it later from nothing.
 */
const AgentNicIpv6ObjectSchema = z.object({
  address: z
    .string()
    .catch("")
    .transform((v) => v.trim().slice(0, 64)),
  prefixLength: z.number().int().min(0).max(128).optional().catch(undefined),
  scope: AgentIpv6ScopeSchema.optional().catch(undefined),
  /** RFC 4941 privacy address — rotates by design, so never a stable identity for the host. */
  temporary: z.boolean().optional().catch(undefined),
  /** Past its preferred lifetime: still bound, no longer used for new connections. */
  deprecated: z.boolean().optional().catch(undefined),
});
export type AgentNicIpv6 = z.infer<typeof AgentNicIpv6ObjectSchema>;

/**
 * The wire form of {@link AgentNicIpv6ObjectSchema}, tolerant of a bare address string so a
 * third-party or older collector that only has the address still reports it (degrade, never reject).
 */
export const AgentNicIpv6Schema = z.preprocess(
  (v) =>
    typeof v === "string"
      ? { address: v }
      : typeof v === "object" && v !== null && !Array.isArray(v)
        ? v
        : {},
  AgentNicIpv6ObjectSchema,
);

/**
 * The report a self-installing collector POSTs to `POST /infra/report` (ADR-0074). This single zod
 * schema is the SOURCE OF TRUTH for the wire, imported by BOTH the agent binary and the API handler
 * (the monorepo payoff — zero drift). Everything beyond the two dedup keys (`reportingSource` +
 * `externalId`) and `host.hostname` is OPTIONAL: the agent degrades gracefully when it lacks privilege
 * (`dmidecode` needs root) or a tool is missing, so a PARTIAL report is VALID — never a 400
 * (ADR-0074 §2/§3).
 *
 * THE ROOT IS `z.object`, NOT `z.strictObject` (#1138). It was strict, on the rationale that the agent
 * is version-locked to the instance it downloaded itself from (ADR-0074 §6) so an unknown key could
 * only be a bug. That rationale holds today and stops holding the moment an agent ships on its own
 * schedule — a Windows MSI pushed by GPO/Intune (#1144), self-update (#1146), or an agent baked into a
 * golden image. Then a NEWER agent against an OLDER server was a hard 400, i.e. the host VANISHES from
 * the inventory: for a CMDB that is strictly worse than accepting what we understand, and it is the
 * same silent-and-misdiagnosed failure shape as #1132. The decisive detail is that only the ROOT was
 * strict — every nested object here is a plain `z.object`, which strips unknown keys silently, so the
 * schema already did forward-compat everywhere except its outermost layer. The strictness was
 * inconsistent, not protective.
 *
 * The signal is MOVED, not lost: the handler diffs the RAW body against its own parse via
 * {@link agentReportSkewPaths} and records every path it dropped or had to coerce — at any depth, not
 * just the root — so a typo'd key is still diagnosable, which matters most next to #1142, where an
 * ABSENT `software` key will come to mean "unchanged".
 */
export const AgentReportSchema = z.object({
  /** The collector binary's own version (skew diagnostics + the ADR-0083/#907 version handshake). */
  agentVersion: z.string().min(1).max(40),
  /** Stable per install (e.g. `agent:<machine-id-prefix>`); the dedup scope. */
  reportingSource: z.string().min(1).max(120),
  /**
   * The stable per-OS-install dedup key — `/etc/machine-id` on Linux, the MachineGuid on Windows, the
   * platform UUID on macOS. One host = one node, forever. Still the PRIMARY key; `host.identifiers`
   * corroborates it (#1141) but never replaces it.
   */
  externalId: z.string().min(1).max(AGENT_EXTERNAL_ID_MAX),
  /** When the agent gathered this report (ISO-8601). */
  reportedAt: z.iso.datetime(),
  host: z.object({
    /** The only REQUIRED host fact — used as the new node's label. The SHORT name, never an FQDN. */
    hostname: z.string().min(1).max(255),
    /**
     * The host's fully-qualified name where it has one (#1138). Separate from `hostname` on purpose:
     * a Windows collector would otherwise have to overload `hostname` with `host.domain.tld` or wait
     * for a v3, and §3 promises there is no v3 identity migration. Free to leave unset on Linux.
     */
    fqdn: z.string().trim().max(255).optional().catch(undefined),
    /**
     * Directory membership (#1138) — Active Directory / LDAP domain the host is joined to. `joined`
     * distinguishes "joined to `corp.example.com`" from "workgroup/standalone", which is the fact an
     * operator actually triages on; the same shape fits macOS directory binding and Linux realmd.
     */
    domain: z
      .object({
        name: z.string().trim().max(255).optional().catch(undefined),
        joined: z.boolean().optional().catch(undefined),
      })
      .optional()
      .catch(undefined),
    os: z
      .object({
        /** REQUIRED on the wire, defaulted to `linux` for pre-v2 agents (see the schema note). */
        family: AgentOsFamilySchema.catch("other").default("linux"),
        name: z.string().max(200).optional(),
        version: z.string().max(200).optional(),
        kernel: z.string().max(200).optional(),
        /** The build identifier where the platform has one distinct from `version` (Windows, macOS). */
        build: z.string().max(200).optional(),
      })
      .optional(),
    /** What the host IS (#1139 will infer `kind` from it); degrades to absent on an unknown value. */
    chassis: AgentChassisSchema.optional().catch(undefined),
    /** What it runs UNDER. `{ type: 'none' }` is a POSITIVE bare-metal finding, not "unknown". */
    virtualization: z
      .object({
        type: AgentVirtualizationTypeSchema.catch("other"),
        /** The hypervisor host, when the guest can see it (rarely). */
        host: z.string().max(200).optional(),
      })
      .optional(),
    /**
     * Corroborating identity evidence for #1141 — never a dedup key on its own. Values arrive
     * CANONICALISED and SANITIZED (see {@link sanitizeIdentifierValue}), so an OEM placeholder can
     * never corroborate two unrelated hosts into one; the set is TRUNCATED past
     * {@link AGENT_IDENTIFIERS_MAX} and entries left with no usable value — absent, empty, junk, or
     * a malformed non-object element — are dropped, never 400-ed.
     */
    identifiers: z
      .array(AgentIdentifierSchema)
      .transform((list) => {
        const kept = list.filter((i) => i.value.length > 0).slice(0, AGENT_IDENTIFIERS_MAX);
        // An EMPTY set says nothing; omit the key rather than assert "this host has no identity".
        return kept.length ? kept : undefined;
      })
      .optional(),
    /**
     * The containers this host runs (#1139) — the one field in this contract that describes something
     * other than the reporting host, because a container is a NODE of its own with a `RUNS_ON` edge
     * back to its host, not an attribute of the host.
     *
     * ABSENT and EMPTY are DIFFERENT answers and the server acts on the difference. Absent = the
     * collector never probed (no readable container socket, an older agent, a non-Linux collector),
     * so the server must touch nothing — a host that stops reporting containers because its agent was
     * downgraded must not retire the children it already has. `[]` = the probe RAN and found none,
     * which is a positive finding that retires them. That is why this array does NOT collapse to
     * `undefined` when empty, unlike {@link AGENT_IDENTIFIERS_MAX}'s set, where an empty set says
     * nothing at all.
     *
     * TRUNCATED past {@link AGENT_CONTAINERS_MAX}; elements with no usable `name` — absent, empty, or
     * a malformed non-object — are dropped, never 400-ed, and the drop is recorded in `agentSkew`.
     */
    containers: z
      .array(AgentContainerSchema)
      .transform((list) => list.filter((c) => c.name.length > 0).slice(0, AGENT_CONTAINERS_MAX))
      .optional(),
    /**
     * The hypervisor this host RUNS (ADR-0095) — present only when the collector positively found
     * one (a readable Proxmox/Hyper-V/libvirt/XCP-ng control surface). ABSENT means "no hypervisor
     * probe ran or none found", never "no hypervisor" — the same absent-≠-empty posture as
     * `containers`. A malformed block degrades to absent, never a 400 on the whole host.
     */
    hypervisor: AgentHypervisorObjectSchema.optional().catch(undefined),
    /**
     * The guests this hypervisor runs (ADR-0095) — the container child contract (#1139) one level
     * up: each element becomes a child NODE with a `RUNS_ON` edge back to the reporting host, keyed
     * by {@link guestExternalId}.
     *
     * ABSENT and EMPTY are DIFFERENT answers and the server acts on the difference, exactly as it
     * does for `containers`. Absent = the collector never probed (an older agent, no hypervisor, a
     * policy that turned `collect.hypervisor` off), so the server must touch nothing — a host that
     * stops reporting guests because its agent was downgraded must not retire the children it
     * already has. `[]` = the probe RAN and found none, a positive finding that retires them.
     *
     * TRUNCATED past {@link AGENT_GUESTS_MAX}; elements with no usable `ref`/`name` — absent,
     * empty, or a malformed non-object — are dropped, never 400-ed, and the drop is recorded in
     * `agentSkew`.
     */
    guests: z
      .array(AgentGuestSchema)
      .transform((list) =>
        list.filter((g) => g.ref.length > 0 && g.name.length > 0).slice(0, AGENT_GUESTS_MAX),
      )
      .optional(),
    /**
     * When the host last booted (ISO-8601). ONE scalar, deliberately: it answers "did this box reboot
     * after the patch window?", which is an INVENTORY question. It is NOT uptime monitoring and must
     * never grow into a metric — ADR-0074 draws that line at inventory and this stays on the inventory
     * side of it (a single timestamp, overwritten each report, never a series).
     */
    bootedAt: z.iso.datetime().optional().catch(undefined),
    cpu: z
      .object({
        model: z.string().max(200),
        cores: z.number().int().nonnegative(),
      })
      .partial()
      .optional(),
    memoryBytes: z.number().int().nonnegative().optional(),
    disks: z
      .array(
        z.object({
          device: z.string().min(1).max(255),
          sizeBytes: z.number().int().nonnegative().optional(),
          mountpoint: z.string().max(1024).optional(),
        }),
      )
      .max(256)
      .optional(),
    nics: z
      .array(
        z.object({
          name: z.string().min(1).max(120),
          mac: z.string().max(64).optional(),
          ipv4: z.array(z.string().max(64)).max(64).optional(),
          /**
           * v1 carried IPv4 only while {@link IpAddressSchema} already accepted v6 — a v6-only host
           * therefore reported NO address at all. Closed here (#1138), with scope and the RFC 4941
           * flags carried so {@link primaryIpv6} can promote a STABLE address rather than whichever
           * one happens to be listed first. A bare string is still accepted and read as the address.
           */
          ipv6: z
            .array(AgentNicIpv6Schema)
            .transform((list) => {
              const kept = list.filter((a) => a.address.length > 0).slice(0, 64);
              return kept.length ? kept : undefined;
            })
            .optional(),
          /** True for veth/bridge/bond/tun interfaces — lets a consumer ignore container plumbing. */
          isVirtual: z.boolean().optional(),
        }),
      )
      .max(64)
      .optional(),
    // dmidecode (root-only) — manufacturer/model/serial; absent on unprivileged installs.
    hardware: z
      .object({
        manufacturer: z.string().max(200),
        model: z.string().max(200),
        serial: z.string().max(200),
      })
      .partial()
      .optional(),
  }),
  /**
   * Installed packages (dpkg/rpm/apk auto-detected). Capped — a sane upper bound, not a real limit.
   *
   * PRESENT means "here is the list" and always wins over {@link AgentSoftwareStateSchema}. ABSENT is
   * where the three-state contract lives: what it MEANS is decided by `softwareState`, and by nothing
   * else. A report carrying neither key is a pre-#1142 agent and keeps the pre-#1142 reading — the
   * list is cleared — because that is the only reading under which #1140's `LAZYIT_COLLECT_SOFTWARE=false`
   * still stops showing an inventory nobody collects.
   */
  software: z
    .array(
      z.object({
        name: z.string().min(1).max(255),
        version: z.string().max(120).optional(),
        /** Which manager listed it; degrades to ABSENT (not `other`) on an unknown value. */
        source: AgentSoftwareSourceSchema.optional().catch(undefined),
      }),
    )
    .max(5000)
    .optional(),
  /**
   * What the ABSENCE of `software` means (#1142). See {@link AgentSoftwareStateSchema} for the four
   * answers and why they are four.
   *
   * `.catch("unavailable")` and NOT `.catch(undefined)`, deliberately. Absent (a pre-#1142 agent) and
   * unrecognised (a post-#1142 agent this build predates) are different situations and must degrade
   * differently: absent keeps today's clearing semantics, while a value we cannot interpret lands on
   * the PRESERVING answer. Landing an unknown state on "absent" would let any future state name make
   * an older server wipe a host's package list — the exact failure this field exists to prevent. The
   * coercion is recorded by {@link agentReportSkewPaths}, so it is visible rather than silent.
   */
  softwareState: AgentSoftwareStateSchema.optional().catch("unavailable"),
  /**
   * A stable fingerprint of the software list the agent HAS (#1142) — sent alongside `reported` and
   * `unchanged` alike, computed by {@link softwareFingerprint}.
   *
   * It is corroboration, not authority, and it is read on exactly ONE branch: an omitted list, where
   * it is the claim being checked. A list that ARRIVES is fingerprinted by the server itself with this
   * same function, so what a node stores is always the server's own reading of what it stored — which
   * is what lets the server skip an unchanged write for a client that sends no fingerprint at all, an
   * attacker included. An omission the server cannot corroborate — the node holds no list, holds one
   * fingerprinted differently, or the `unchanged` claim arrived carrying NO fingerprint at all — is
   * never resolved by guessing: the stored list is kept (never wiped on a doubt) and the ack asks for a
   * full resend. That is what makes the delta self-healing across a discarded-and-rediscovered node, a
   * restore from backup, and a merge.
   *
   * The third case is the one worth stating: a claim the server CANNOT check is the least corroborated
   * of the three, so it is asked too. Keying the request on a fingerprint having arrived — which is
   * what this shipped as, until the review of #1163 — trusted an unverifiable claim more than a
   * verifiable one that failed, and on a brand-new node that meant a permanently empty inventory.
   */
  softwareHash: z
    .string()
    .trim()
    .min(1)
    .max(AGENT_SOFTWARE_HASH_MAX)
    .optional()
    .catch(undefined),
  /**
   * What the collector could NOT do (#1138). This is what lets a fleet view say "web-03: reporting
   * unprivileged, no serial/model" instead of leaving the operator staring at an empty row wondering
   * whether the host is broken or the agent is. `warnings` names each collector that timed out or was
   * skipped for lack of privilege (the #1133 timeout path), `privileged` says whether the run had
   * root, `durationMs` how long collection took.
   */
  diagnostics: z
    .object({
      warnings: z
        .array(
          z
            .string()
            .catch("")
            .transform((w) => w.trim().slice(0, AGENT_WARNING_LENGTH_MAX)),
        )
        .transform((list) => {
          const kept = list.filter((w) => w.length > 0).slice(0, AGENT_WARNINGS_MAX);
          return kept.length ? kept : undefined;
        })
        .optional(),
      privileged: z.boolean().optional().catch(undefined),
      durationMs: z.number().int().nonnegative().optional().catch(undefined),
    })
    .optional(),
  /**
   * The policy revision the agent last applied (#1140, server-driven policy). Reserved by contract v2
   * (#1138) and made REAL by the policy channel: the server now persists it on the node
   * (`policyRevision`, plus `policyAppliedAt` when it CHANGES) and the node drill-in compares it to the
   * instance revision to say *applied* vs *pending*. Absent from any pre-#1140 agent, which is why an
   * absent echo writes nothing rather than clearing the stored value.
   */
  policyRevision: z.number().int().nonnegative().optional().catch(undefined),
});
export type AgentReport = z.infer<typeof AgentReportSchema>;

/** One package as the wire carries it — the element type of a report's `software` list. */
export type AgentSoftwarePackage = NonNullable<AgentReport["software"]>[number];

// ── Software fingerprint (#1142) — the canonical form both sides agree on ─────────────────────────

/** Separates the fields of one package. A control character, so no package string can contain it. */
const SOFTWARE_FIELD_SEPARATOR = "\u001f";
/** Stands in for an ABSENT optional field, so it never collides with an empty-string one. */
const SOFTWARE_FIELD_ABSENT = "\u0000";
/** Separates packages from each other. Same reasoning. */
const SOFTWARE_ENTRY_SEPARATOR = "\u001e";

/**
 * The version of the canonical form below. It rides in the fingerprint, so changing how a list is
 * canonicalised makes every stored fingerprint compare UNEQUAL to a new one — which requests a full
 * resend rather than silently declaring an old list current. A format change is therefore a one-tick
 * cost, never a correctness event.
 */
const SOFTWARE_FINGERPRINT_VERSION = "1";

/**
 * One 32-bit avalanche hash of `text` from `seed` (FNV-1a over UTF-16 code units + a Murmur3-style
 * finalizer). Deliberately non-cryptographic and `Math.imul`-based: this runs over a few hundred KB
 * on a host that has 5,000 packages, on every collection.
 */
function softwareHash32(text: string, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A stable fingerprint of a reported software list (#1142) — the value an agent caches so it can omit
 * an unchanged list, and the value a server stores so it can tell a corroborated `unchanged` from a
 * claim about a list it does not hold.
 *
 * ORDER-INDEPENDENT, because package-manager output order is not a fact about the host: `dpkg-query`
 * and `rpm -qa` do not promise one, and a list that re-sorted itself would make every host resend its
 * whole inventory for nothing. The count is folded in separately so a re-ordering and an added
 * duplicate can never look alike.
 *
 * Non-cryptographic (three seeded 32-bit avalanche hashes over the canonical text, plus the package
 * count), and that is a deliberate and bounded choice. What it gates is "was this the same list?" —
 * never what gets STORED, which is always a list somebody actually sent. So the only failure it can
 * cause is a chance collision between two DIFFERENT package lists on the SAME host, and a party who
 * could construct one would only be lying about their own node's inventory. It is deliberately NOT
 * claimed to be collision-resistant against a determined adversary; nothing here relies on that.
 * Every other outcome — a mismatch, a missing fingerprint, an unparsed one — resolves by writing,
 * never by skipping.
 */
export function softwareFingerprint(software: readonly AgentSoftwarePackage[]): string {
  // An ABSENT optional field is encoded distinctly from an empty one. They are not the same claim,
  // and folding them together would make the fingerprint quietly weaker than the list it stands for.
  const field = (value: string | undefined): string => value ?? SOFTWARE_FIELD_ABSENT;
  const entries = software.map(
    (pkg) =>
      `${pkg.name}${SOFTWARE_FIELD_SEPARATOR}${field(pkg.version)}${SOFTWARE_FIELD_SEPARATOR}${field(pkg.source)}`,
  );
  // An explicit comparator, not the default: this value is compared across two processes and two
  // runtimes, so the ordering must be plain code-unit order and visibly so.
  entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const text = entries.join(SOFTWARE_ENTRY_SEPARATOR);
  const hex = (n: number): string => n.toString(16).padStart(8, "0");
  return [
    SOFTWARE_FINGERPRINT_VERSION,
    software.length.toString(36),
    `${hex(softwareHash32(text, 0x811c9dc5))}${hex(softwareHash32(text, 0x01000193))}${hex(softwareHash32(text, 0x9e3779b9))}`,
  ].join("-");
}

// ── Skew recording (#1138) — what the server did NOT understand about a report ─────────────────────

/** Cap on each recorded path list — the result is persisted and the body is attacker-controlled. */
export const AGENT_SKEW_PATHS_MAX = 25;

/** Cap on one recorded path — long enough to name a real field, short enough to be inert. */
const AGENT_SKEW_PATH_LENGTH_MAX = 120;

/** How deep the diff walks. Deeper than any shape this contract has, shallow enough to stay cheap. */
const AGENT_SKEW_MAX_DEPTH = 12;

/** Total nodes visited, so a pathological body cannot turn the diff into the expensive part. */
const AGENT_SKEW_MAX_VISITS = 200_000;

/** What a report carried that this build could not keep verbatim. */
export interface AgentReportSkewPaths {
  /** Wire paths whose data did not survive parsing at all (unknown keys, unusable values). */
  droppedPaths: string[];
  /** Wire paths whose value this build had to CHANGE to accept (enum `.catch()`, truncation, canonicalisation). */
  coercedPaths: string[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Diff a RAW report body against its own parse (#1138) — the record that keeps the loosened contract
 * honest.
 *
 * Diffing raw-against-parsed rather than raw-against-a-key-list is the whole point. A key-list diff
 * only sees the ROOT, and every realistic future skew is either a NESTED key (which a plain
 * `z.object` strips silently) or an unknown ENUM VALUE (which our own `.catch()` coerces silently) —
 * so a root-only recorder would answer "everything understood" for exactly the reports it exists to
 * flag. `os.family` is the sharpest case: the contract requires it precisely so no consumer
 * re-derives the platform, then `.catch("other")` swallows a malformed one; if that is not recorded
 * the requirement is self-defeating. Comparing against the parse also means this can never drift from
 * the schema — it IS the schema's own output.
 *
 * BOUNDED on every axis, because the result lands in a jsonb column and the report endpoint is
 * machine-facing: {@link AGENT_SKEW_PATHS_MAX} paths per list, each truncated, a depth cap, a visit
 * cap, and array indices collapsed to `[]` so one bad element in a 5000-package list records one
 * path rather than five thousand.
 */
export function agentReportSkewPaths(raw: unknown, parsed: unknown): AgentReportSkewPaths {
  const dropped = new Set<string>();
  const coerced = new Set<string>();
  let visits = 0;

  const record = (into: Set<string>, path: string): void => {
    if (into.size >= AGENT_SKEW_PATHS_MAX) return;
    into.add(path.slice(0, AGENT_SKEW_PATH_LENGTH_MAX) || "(root)");
  };

  const walk = (rawValue: unknown, parsedValue: unknown, path: string, depth: number): void => {
    if (depth > AGENT_SKEW_MAX_DEPTH || visits >= AGENT_SKEW_MAX_VISITS) return;
    if (dropped.size >= AGENT_SKEW_PATHS_MAX && coerced.size >= AGENT_SKEW_PATHS_MAX) return;
    visits += 1;

    if (Array.isArray(rawValue)) {
      if (!Array.isArray(parsedValue)) return record(coerced, path);
      // A shorter parse means the contract truncated — a degradation the operator should see.
      if (rawValue.length > parsedValue.length) record(coerced, `${path}[]`);
      const shared = Math.min(rawValue.length, parsedValue.length);
      for (let i = 0; i < shared; i += 1) walk(rawValue[i], parsedValue[i], `${path}[]`, depth + 1);
      return;
    }

    if (isPlainObject(rawValue)) {
      if (!isPlainObject(parsedValue)) return record(coerced, path);
      for (const key of Object.keys(rawValue)) {
        const child = path ? `${path}.${key}` : key;
        const childRaw = rawValue[key];
        if (childRaw === undefined) continue;
        const childParsed = parsedValue[key];
        // Absent from the parse ⇒ the key is unknown, or its value was unusable. Either way the wire
        // said something this build kept nothing of.
        if (childParsed === undefined) {
          record(dropped, child);
          continue;
        }
        walk(childRaw, childParsed, child, depth + 1);
      }
      return;
    }

    if (rawValue !== parsedValue) record(coerced, path);
  };

  walk(raw, parsed, "", 0);
  return { droppedPaths: [...dropped], coercedPaths: [...coerced] };
}

/** The `host` block of a report — the subset the fact-promotion mappers below read (issue #1081). */
export type AgentReportHost = AgentReport["host"];

// ── Fact-promotion mappers (ADR-0074 §3, issue #1081) — pure, framework-agnostic ──────────────────
//
// Promote a raw report's host facts into canonical fields: the primary IPv4 → the node's `ipAddress`
// (a display fact), and the hardware serial → the confirmed Asset's `serial`. Kept here beside
// `AgentReportSchema` so api (the writer) and any future consumer share one definition. Pure — no
// framework, no I/O — and unit-tested in `infra.test.ts`.

/** A NIC's first non-empty IPv4 (trimmed), or undefined when it advertises none. */
function firstNicIpv4(nic: NonNullable<AgentReportHost["nics"]>[number]): string | undefined {
  return nic.ipv4?.map((ip) => ip.trim()).find((ip) => ip.length > 0);
}

/** `fe80::/10` — link-local. Reachable only on the wire it sits on, never a node's display address. */
const IPV6_LINK_LOCAL = /^fe[89ab][0-9a-f]:/;

/** `fc00::/7` — unique-local. Routable inside the estate, so a usable last resort, never the winner. */
const IPV6_UNIQUE_LOCAL = /^f[cd][0-9a-f]{2}:/;

/**
 * Is this address one the node can be SHOWN as, indefinitely? (#1138)
 *
 * The three exclusions each answer a way the naive "first non-`fe80:` entry" rule goes wrong:
 * `temporary` is an RFC 4941 privacy address, regenerated on a timer — promoting one puts an address
 * on the map that stops resolving to the host within hours; `deprecated` is past its preferred
 * lifetime and on its way out; a non-`global` scope is by definition not reachable from where an
 * operator sits. The prefix checks stand in for scope when the collector could not report it.
 */
function isStableRoutableIpv6(address: AgentNicIpv6): boolean {
  const value = address.address.trim().toLowerCase();
  if (!value) return false;
  if (address.temporary === true || address.deprecated === true) return false;
  if (address.scope !== undefined && address.scope !== "global") return false;
  if (IPV6_LINK_LOCAL.test(value)) return false;
  return value !== "::1" && value !== "::";
}

/**
 * The host's most stable routable IPv6 (#1138), or `undefined` when it has none worth showing.
 * Global unicast wins over a unique-local address, and within a tier the first NIC in report order
 * wins; loopback is skipped (its only address is `::1`, which is excluded anyway). Exported because
 * it is the contract's promotion RULE, which #1141 and any future consumer must be able to reuse
 * rather than re-derive.
 */
export function primaryIpv6(host: AgentReportHost): string | undefined {
  let uniqueLocal: string | undefined;
  for (const nic of host.nics ?? []) {
    if (nic.name === "lo") continue;
    for (const address of nic.ipv6 ?? []) {
      if (!isStableRoutableIpv6(address)) continue;
      const value = address.address.trim();
      if (IPV6_UNIQUE_LOCAL.test(value.toLowerCase())) {
        uniqueLocal ??= value;
        continue;
      }
      return value;
    }
  }
  return uniqueLocal;
}

/** A MAC that is all zeroes carries no identity (unconfigured tun/tap, some hypervisor stubs). */
const ZERO_MAC = /^0{2}(:0{2})+$/;

/**
 * Is the MAC locally administered (bit 0x02 of the first octet)? Bridges, veth pairs and systemd's
 * generated interface MACs set it; a vendor-burned NIC address does not.
 */
function isLocallyAdministeredMac(mac: string): boolean {
  const firstOctet = Number.parseInt(mac.slice(0, 2), 16);
  return Number.isInteger(firstOctet) && (firstOctet & 0x02) !== 0;
}

/**
 * WHICH MAC becomes the host's `mac` identifier (#1138) — a property of the SET, not of the listing.
 *
 * The collector used to take "whichever physical NIC `ip -j addr` listed first", i.e. kernel ifindex
 * order, which changes on a driver load-order change, a udev rename or an added NIC. #1141 compares
 * this value ACROSS reports, so a rule that depends on enumeration order would manufacture identity
 * churn on hosts whose hardware never changed. The rule is therefore: canonicalise every candidate,
 * discard loopback and all-zero addresses, rank by how likely the address is to be burned-in
 * (physical beats unknown beats virtual; universally-administered beats locally-administered), and
 * break ties by taking the lexicographically smallest — total, and independent of report order.
 *
 * Locally-administered MACs are ranked DOWN but never excluded: EC2 hands out `02:…` addresses on
 * real ENIs, and excluding them would leave every cloud host with no MAC evidence at all.
 */
export function selectPrimaryMac(nics: AgentReportHost["nics"]): string | undefined {
  const candidates: Array<{ mac: string; rank: number }> = [];
  for (const nic of nics ?? []) {
    if (nic.name === "lo" || !nic.mac) continue;
    const mac = normalizeIdentifierValue("mac", nic.mac);
    if (!mac || ZERO_MAC.test(mac)) continue;
    const physicality = nic.isVirtual === false ? 0 : nic.isVirtual === true ? 4 : 2;
    candidates.push({ mac, rank: physicality + (isLocallyAdministeredMac(mac) ? 1 : 0) });
  }
  candidates.sort((a, b) => a.rank - b.rank || (a.mac < b.mac ? -1 : a.mac > b.mac ? 1 : 0));
  return candidates[0]?.mac;
}

/**
 * The OS family of a report's host (#1138), with the pre-v2 default applied. The schema defaults
 * `os.family` when an `os` block is present, but a partial report may omit `os` entirely — and every
 * agent that predates contract v2 is a LINUX-only collector, so `linux` is the honest answer rather
 * than an invented `other`. The one place the "server-side default" of ADR-0074 §2's amendment lives,
 * so no consumer has to re-derive it.
 */
export function osFamily(host: AgentReportHost): AgentOsFamily {
  return host.os?.family ?? "linux";
}

/**
 * The host's primary IPv4 (issue #1081): the first IPv4 of the first non-loopback NIC (name !== `lo`)
 * that advertises one; failing that, the first IPv4 found on ANY NIC (loopback included); `undefined`
 * when the report carries no IPv4 at all (an unprivileged/partial report — never fabricate one). This
 * is what a discovered node shows as its `ipAddress`, and what each report refreshes it to.
 *
 * Validate-or-drop (ADR-0090, #847): the chosen value is returned ONLY if it passes
 * {@link IpAddressSchema}, else `undefined`. A malformed NIC value can NEVER promote to the node's
 * `ipAddress` — per ADR-0074 §3 a bad fact is silently DROPPED, never a 400 on the whole report.
 */
export function primaryIpv4(host: AgentReportHost): string | undefined {
  const nics = host.nics ?? [];
  // The first IPv4 of the first non-loopback NIC that advertises one …
  const candidate =
    nics.filter((n) => n.name !== "lo").map(firstNicIpv4).find(Boolean) ??
    // … else the first IPv4 on ANY NIC (loopback included — reached only when no non-lo NIC had one).
    nics.map(firstNicIpv4).find(Boolean);
  // Format-validate the winner; garbage is dropped (returns the trimmed value on success).
  const parsed = IpAddressSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The host's primary IP address for display (#1138): {@link primaryIpv4} when the host has ANY IPv4,
 * else the most stable routable IPv6 {@link primaryIpv6} can find. IPv4 keeps winning wherever it
 * exists, so every dual-stack node's `ipAddress` is exactly what it was before — the fallback only
 * fires on a v6-ONLY host, which the v1 contract left with no address at all even though
 * {@link IpAddressSchema} has always accepted v6. Same validate-or-drop rule: a malformed value is
 * dropped, never a 400 on the whole report (ADR-0090 / ADR-0074 §3).
 */
export function primaryIp(host: AgentReportHost): string | undefined {
  const ipv4 = primaryIpv4(host);
  if (ipv4 !== undefined) return ipv4;
  const parsed = IpAddressSchema.safeParse(primaryIpv6(host));
  return parsed.success ? parsed.data : undefined;
}

/**
 * The host's hardware serial, sanitized (issue #1081): trimmed, with the well-known dmidecode junk
 * placeholders rejected (case-insensitive) and any all-same-character string (e.g. `000000`, `......`)
 * dropped. Returns `undefined` for an empty/absent/junk serial so the caller leaves the Asset serial
 * null (the raw value still survives verbatim in `specs.host.hardware.serial`). Never promote junk to
 * the unique canonical `Asset.serial`.
 *
 * The rule itself lives in {@link isJunkIdentityValue}, shared with {@link sanitizeIdentifierValue}
 * so identity evidence and `Asset.serial` can never disagree about what counts as junk (#1138).
 */
export function sanitizeSerial(host: AgentReportHost): string | undefined {
  const raw = host.hardware?.serial?.trim();
  if (!raw || isJunkIdentityValue(raw)) return undefined;
  return raw;
}

// ── Identity corroboration (#1141) — evidence beside the dedup key, never a second key ────────────
//
// `externalId` is the host's OS-install identity — `/etc/machine-id` on Linux,
// `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` on Windows — and `reportingSource` is derived
// from the same value, so the "composite" dedup key is that one identity twice. A VM template or
// golden image built with a BAKED one is the single most common Proxmox/VMware/Packer mistake — it is
// the documented reason `systemd-firstboot` and `sysprep /generalize` both exist — and against that
// key twelve cloned servers all match one node: the label keeps whoever reported first, the IP
// flip-flops every report, and `specs` is whichever host reported last. The CMDB shows 1 server; the
// estate has 12. A confidently wrong inventory is worse than an empty one.
//
// These helpers are the whole detection surface, and they are deliberately NOT an identification-rule
// engine: no priority table, no configurable entries, no reconciliation-precedence UI. ServiceNow's
// IRE needs that because 14 discovery sources fight over one CI; there is exactly ONE source here.

/**
 * The corroborating facts of one host, read out of a report's `host` block (or out of the same block
 * as it was stored in a node's `specs` jsonb — the two are the same shape, which is why this takes
 * `unknown` and reads defensively rather than trusting a Prisma `JsonValue` cast).
 *
 * Only `host.identifiers` is read. `hardware.serial` is NOT a second source: it lands in the
 * identifier set already, and two doors onto one comparison is exactly how the two sides come to
 * disagree about what counts as evidence.
 */
export interface HostIdentityEvidence {
  /** Sanitized, canonical `serial` identifiers — sorted + de-duplicated, so this is a SET. */
  serials: string[];
  /** Sanitized, canonical `mac` identifiers — sorted + de-duplicated. */
  macs: string[];
  /**
   * The reported short hostname, or `""` when the block carries none. NOT part of
   * {@link isClonedMachineId} — it is corroborating detail for the operator-facing message only.
   */
  hostname: string;
}

/** Sorted, de-duplicated — the comparison must be a property of the set, never of report order. */
function identityValuesOf(list: unknown[], kind: AgentIdentifierKind): string[] {
  const values = new Set<string>();
  for (const entry of list) {
    if (!isPlainObject(entry)) continue;
    if (entry.kind !== kind) continue;
    if (typeof entry.value !== "string") continue;
    // Re-sanitized on READ as well as on parse: the stored blob may predate the #1138 sanitize rule
    // or have been hand-edited, and an OEM placeholder must never corroborate two unrelated boards.
    const value = sanitizeIdentifierValue(kind, entry.value);
    if (value) values.add(value);
  }
  return [...values].sort();
}

/**
 * The corroborating evidence carried by a report's (or a stored node's) `host` block. Everything
 * degrades to an EMPTY set rather than throwing: this runs on the machine-facing report path, and a
 * malformed stored blob must not be able to fail an ingest.
 */
export function hostIdentityEvidence(host: unknown): HostIdentityEvidence {
  if (!isPlainObject(host)) return { serials: [], macs: [], hostname: "" };
  const identifiers = Array.isArray(host.identifiers) ? host.identifiers : [];
  return {
    serials: identityValuesOf(identifiers, "serial"),
    macs: identityValuesOf(identifiers, "mac"),
    hostname: typeof host.hostname === "string" ? host.hostname.trim() : "",
  };
}

/** Two sets share nothing — the "differ" half of the rule below. */
function isDisjoint(a: string[], b: string[]): boolean {
  const right = new Set(b);
  return !a.some((value) => right.has(value));
}

/**
 * Do these two reports, which agree on `externalId`, actually come from DIFFERENT physical hosts?
 *
 * True when the serial set AND the MAC set BOTH differ. Two facts, both burned into hardware — and
 * the **hostname is deliberately not one of them**.
 *
 * WHY HOSTNAME IS NOT A GATE. An earlier draft of this rule required the hostname to differ too, and
 * that excused the exact scenario the rule exists for: the archetypal golden-image clone has a baked
 * machine-id *and a baked hostname* — that is what "cloned from a template" means. Requiring a
 * hostname difference would have silently collapsed those hosts into one node, which is the failure
 * #1141 was opened about. The hostname survives as corroborating DETAIL in the notification (and two
 * hosts answering to one name is itself worth telling the operator), never as a condition.
 *
 * WHY BOTH, NOT EITHER. Hypervisors hand every guest its own SMBIOS serial and its own MACs, so two
 * clones differ on both while sharing machine-id and name. Requiring BOTH to differ tolerates exactly
 * one legitimate hardware change on a real box: a NIC swap moves the MACs alone, a board swap moves
 * the serial alone. Both moving at once under one machine-id is overwhelmingly two machines.
 *
 * THE ERROR ASYMMETRY JUSTIFIES BIASING TOWARD DETECTION. A false positive costs one spurious PENDING
 * node and one notification, which a human dismisses (and `merge-into` undoes). A false negative
 * silently merges two production servers into one inventory row — the worst failure class in this
 * product, because a confidently wrong CMDB is worse than an empty one.
 *
 * ABSENCE IS NOT A DIFFERENCE. Pre-v2 agents send no `identifiers[]` and every row stored before
 * contract v2 has none, so an empty set on EITHER side returns false and the caller merges exactly as
 * it did before. That is the load-bearing upgrade promise of #1141: the first v2 report backfills the
 * evidence, and only reports from then on can be corroborated. Warning on absence would have made
 * every legacy estate light up on the day it upgraded.
 */
export function isClonedMachineId(
  stored: HostIdentityEvidence,
  incoming: HostIdentityEvidence,
): boolean {
  if (!stored.serials.length || !incoming.serials.length) return false;
  if (!stored.macs.length || !incoming.macs.length) return false;
  return isDisjoint(stored.serials, incoming.serials) && isDisjoint(stored.macs, incoming.macs);
}

/**
 * ADOPTION CORROBORATION (ADR-0093 §3a) — may a confirm LINK this node's report to the live Asset that
 * already carries `serial`, instead of minting a second one for the same physical machine?
 *
 * `specs` is the node's whole stored blob (`{ host, reportedAt, identityConflict?, … }`); `serial` is
 * the value {@link sanitizeSerial} already produced from `specs.host` — passed in rather than
 * re-derived so the ADOPT probe and the MINT promotion can never disagree about which serial this
 * machine has.
 *
 * WHY NOT A BARE SERIAL MATCH. {@link sanitizeSerial} exists because vendors ship placeholder serials
 * by the rack, and {@link isClonedMachineId} exists because burned-in identity DOES collide in the
 * field. Matching on a value the codebase already distrusts would silently attach the wrong machine to
 * a row a human curated — and a mis-link is far worse than the duplicate it replaces, because a
 * duplicate is VISIBLE and a mis-link is not. All three conditions must hold:
 *
 *  1. the sanitized serial appears in the host's own identity evidence — the same value, canonicalised
 *     the one way {@link sanitizeIdentifierValue} canonicalises serials;
 *  2. the host offers at least one surviving MAC, i.e. {@link identityDiscriminator} is derivable. A
 *     report whose ONLY identity fact is a serial is one fact, not corroboration;
 *  3. the node is not under an active #1141 identity collision (`specs.identityConflict`). A machine-id
 *     under suspicion never adopts.
 *
 * FAILS CLOSED, and that is why the gate can afford to be strict: not corroborated means MINT, which
 * is the pre-ADR behaviour and is recoverable by hand. Adopting wrongly is not.
 *
 * Reads `unknown` defensively for the same reason {@link hostIdentityEvidence} does: this runs over a
 * Prisma `JsonValue` that may have been hand-edited or written by an older build, and a malformed blob
 * must degrade to "no corroboration", never throw.
 */
export function corroboratesAdoption(specs: unknown, serial: string): boolean {
  if (!isPlainObject(specs)) return false;
  // Fail closed on a flagged collision — `undefined` is "never flagged", `null` a cleared flag.
  if (specs.identityConflict !== undefined && specs.identityConflict !== null) return false;
  const evidence = hostIdentityEvidence(specs.host);
  if (evidence.macs.length === 0) return false;
  const canonical = sanitizeIdentifierValue("serial", serial);
  return canonical !== undefined && evidence.serials.includes(canonical);
}

/** Cap on the discriminator half of a disambiguated key — long enough for any real serial or MAC. */
export const IDENTITY_DISCRIMINATOR_MAX = 64;

/**
 * The strongest identity value a host offers, used to give a colliding clone its OWN stable dedup key.
 * The serial wins because it is burned into the board; the lowest MAC is the fallback (the set is
 * sorted, so "lowest" is total and independent of report order). `undefined` when there is no
 * evidence — which by construction cannot happen on the path {@link isClonedMachineId} opens.
 */
export function identityDiscriminator(evidence: HostIdentityEvidence): string | undefined {
  return evidence.serials[0] ?? evidence.macs[0];
}

/**
 * The dedup key a colliding host gets instead of the one it claims: `<externalId>#<discriminator>`.
 *
 * The clone keeps reporting the same baked machine-id forever, so it needs a key that is DETERMINISTIC
 * (the same clone must land on the same node every 15 minutes) and DISTINCT (the partial-unique
 * `(reportingSource, externalId)` index over live rows physically forbids two live nodes sharing one).
 * Deriving it from the burned-in serial gives both. It is intentionally human-readable rather than
 * hashed: an operator staring at two rows in the tray should be able to see WHY they are two.
 */
export function disambiguateExternalId(externalId: string, discriminator: string): string {
  return `${externalId.slice(0, AGENT_EXTERNAL_ID_MAX)}#${discriminator.slice(0, IDENTITY_DISCRIMINATOR_MAX)}`;
}

// ── Topology promotion (ADR-0074 §3 amendment, issue #1139) — kind + container child nodes ────────

/** The virtualization types that make the host a CONTAINER rather than a VM. */
const CONTAINER_VIRTUALIZATION = new Set<AgentVirtualizationType>(["docker", "lxc", "wsl"]);

/** Chassis values that answer the kind question on their own, for a collector that has no virt probe. */
const CHASSIS_KIND: Partial<Record<AgentChassis, InfraNodeKind>> = {
  vm: "VM",
  container: "CONTAINER",
  server: "PHYSICAL_HOST",
  desktop: "PHYSICAL_HOST",
  laptop: "PHYSICAL_HOST",
};

/**
 * The node `kind` a report PROPOSES for a newly-discovered host (#1139), or `undefined` when the
 * report carries no evidence and the caller must keep its existing default.
 *
 * Until this existed, every agent-reported host landed as `PHYSICAL_HOST`: install the agent on a
 * hypervisor and its eight guests and the operator got nine identical boxes to re-classify by hand
 * before the blast-radius feature the graph was built for meant anything. Contract v2 already carries
 * both facts this needs, so the inference is a mapping, not a heuristic.
 *
 * `virtualization` WINS over `chassis`, because a guest inherits its hypervisor's synthetic board and
 * DMI happily calls a KVM guest a desktop; the Linux collector already resolves that precedence when
 * it fills `chassis`, and re-stating it here is what makes the rule correct for a collector that
 * reports the two independently. `chassis` is the fallback for exactly that case (a Windows/macOS
 * collector with no `systemd-detect-virt` equivalent).
 *
 * NO EVIDENCE PROPOSES NOTHING. `chassis: 'unknown'` means the probe did not run — a different fact
 * from "bare metal", which the contract spells `{ type: 'none' }` — so this returns `undefined` and
 * the caller falls back to the pre-#1139 `PHYSICAL_HOST` default rather than dressing a guess up as a
 * finding. That is also what keeps a legacy pre-v2 agent's report landing exactly where it always did.
 *
 * A PROPOSAL, never a verdict: this is read on the CREATE branch only. A node a human has already
 * confirmed and classified is never re-kinded by a report — the agent owns facts, the human owns
 * curation (ADR-0074 §3).
 */
export function inferNodeKind(host: AgentReportHost): InfraNodeKind | undefined {
  const virtualization = host.virtualization?.type;
  if (virtualization !== undefined) {
    if (virtualization === "none") return "PHYSICAL_HOST";
    return CONTAINER_VIRTUALIZATION.has(virtualization) ? "CONTAINER" : "VM";
  }
  return host.chassis !== undefined ? CHASSIS_KIND[host.chassis] : undefined;
}

/** The separator that scopes a container's name to its host. A machine-id/GUID/UUID never contains it. */
const CONTAINER_ID_SEPARATOR = "/container/";

/**
 * The dedup `externalId` of a container child node (#1139) — the host's own `externalId`, the
 * separator, and the container's name.
 *
 * This is as permanent as the host key ADR-0074 §3 froze, so the two choices in it are stated rather
 * than left to be re-derived. It is keyed on the container's NAME because a runtime container id is
 * regenerated by every recreate — an id-keyed node would mint a duplicate PENDING proposal on every
 * `docker compose up` and orphan the old one. And it is SCOPED to the host because container names
 * are only unique within one runtime: two hosts both running `redis` are two containers, and a
 * host-less key would silently fuse them into one node whose `RUNS_ON` edge flapped between hosts.
 *
 * The separator cannot appear in a host `externalId` (a machine-id is hex, a Windows MachineGuid and
 * a macOS platform UUID are hex-and-dashes), so a container key can never collide with a host key in
 * the same `(reportingSource, externalId)` unique index the host path already uses — which is why
 * this needs no column and no migration.
 */
export function containerExternalId(hostExternalId: string, containerName: string): string {
  return `${hostExternalId}${CONTAINER_ID_SEPARATOR}${containerName}`;
}

/** Does this `externalId` belong to a container child of the given host? (the retire-sweep filter) */
export function containerExternalIdPrefix(hostExternalId: string): string {
  return `${hostExternalId}${CONTAINER_ID_SEPARATOR}`;
}

/**
 * Is this node a reported CONTAINER CHILD rather than a reporting host? (#1139)
 *
 * The key's own rule, exported so a consumer never re-derives it from the separator string. It exists
 * because "the newest agent proposal" stopped meaning "the host that just checked in": children are
 * created immediately after their host inside the same request, and the node list is newest-first, so
 * a host reporting any container would otherwise have the create-agent wizard announce a container as
 * the server the operator just installed the agent on.
 */
export function isContainerChildExternalId(externalId: string | null | undefined): boolean {
  return externalId !== null && externalId !== undefined && externalId.includes(CONTAINER_ID_SEPARATOR);
}

/**
 * The HOST key a container child was scoped to (#1145), or `undefined` when this is not a child key.
 *
 * The inverse of {@link containerExternalId}, exported for the same reason its siblings are: the
 * review tray groups children under the host that reported them, and re-deriving the separator at the
 * call site is how the two halves of one key rule drift apart.
 *
 * It splits on the FIRST separator, never the last. A container may legally be named `container` (or
 * anything else containing the separator), and taking the last occurrence would let a container NAME
 * decide which host key it resolves to — i.e. let a reported string re-parent a child onto a host it
 * does not run on. The host half of the key is written first and is the half that is trustworthy.
 */
export function hostExternalIdOfContainerChild(
  externalId: string | null | undefined,
): string | undefined {
  if (externalId === null || externalId === undefined) return undefined;
  const at = externalId.indexOf(CONTAINER_ID_SEPARATOR);
  return at > 0 ? externalId.slice(0, at) : undefined;
}

/**
 * A container's runtime state → the child node's `status` (#1139). A LIVENESS FACT the agent owns,
 * exactly like the host node's `status=ONLINE` on check-in — never curation.
 *
 * Only `running` is ONLINE. `paused`/`created`/`restarting` are deliberately grouped with `exited`:
 * the question the map answers is "is this thing serving?", and none of them are. An unreported or
 * unrecognised state is `UNKNOWN` rather than a guess in either direction — the same posture the
 * contract takes everywhere else it lacks evidence.
 */
export function containerNodeStatus(state: AgentContainerState | undefined): InfraNodeStatus {
  if (state === "running") return "ONLINE";
  return state === undefined || state === "unknown" ? "UNKNOWN" : "OFFLINE";
}

// ── Hypervisor guest child nodes (ADR-0095, #1217) — the /guest/ namespace beside /container/ ─────

/**
 * The separator that scopes a guest's ref to its hypervisor host (ADR-0095). A distinct namespace
 * from {@link CONTAINER_ID_SEPARATOR} on purpose: a Proxmox host runs BOTH kinds of children, and
 * one namespace would let a Docker container named `101` and LXC guest 101 collide on one key. Like
 * the container separator, it cannot appear in a host `externalId` (a machine-id is hex, a Windows
 * MachineGuid and a macOS platform UUID are hex-and-dashes).
 */
const GUEST_ID_SEPARATOR = "/guest/";

/**
 * The dedup `externalId` of a guest child node (ADR-0095) — the host's own `externalId`, the
 * separator, and the guest's platform ref, mirroring {@link containerExternalId} clause for clause.
 *
 * Keyed on the platform's stable REF (VMID/GUID/domain UUID) because a guest's runtime instance id
 * is regenerated per boot on some platforms and its NAME is freely renamed — either would mint a
 * fresh PENDING proposal for a guest the operator already confirmed. And SCOPED to the host because
 * refs are only unique per hypervisor: two Proxmox nodes both running VMID 101 are two guests, and
 * a host-less key would silently fuse them into one node whose `RUNS_ON` edge flapped. The host
 * half is bounded by the report schema's own `.max(AGENT_EXTERNAL_ID_MAX)` and the ref by the guest
 * schema's cap, exactly as the container key is bounded — never re-truncated here.
 */
export function guestExternalId(hostExternalId: string, ref: string): string {
  return `${hostExternalId}${GUEST_ID_SEPARATOR}${ref}`;
}

/** Does this `externalId` belong to a guest child of the given host? (the retire-sweep filter) */
export function guestExternalIdPrefix(hostExternalId: string): string {
  return `${hostExternalId}${GUEST_ID_SEPARATOR}`;
}

/**
 * Is this node a reported GUEST CHILD rather than a reporting host? (ADR-0095)
 *
 * The key's own rule, exported so a consumer never re-derives it from the separator string — the
 * same reason {@link isContainerChildExternalId} exists. Deliberately false for a container child:
 * the two child namespaces never bleed into each other.
 */
export function isGuestChildExternalId(externalId: string | null | undefined): boolean {
  return externalId !== null && externalId !== undefined && externalId.includes(GUEST_ID_SEPARATOR);
}

/**
 * The HOST key a guest child was scoped to (ADR-0095), or `undefined` when this is not a guest key.
 *
 * Splits on the FIRST separator, never the last, for the same reason
 * {@link hostExternalIdOfContainerChild} does: a reported ref containing the separator must never
 * decide which host key it resolves to — the host half is written first and is the trustworthy one.
 */
export function hostExternalIdOfGuestChild(
  externalId: string | null | undefined,
): string | undefined {
  if (externalId === null || externalId === undefined) return undefined;
  const at = externalId.indexOf(GUEST_ID_SEPARATOR);
  return at > 0 ? externalId.slice(0, at) : undefined;
}

/**
 * A guest's reported kind → the child node's `kind` (ADR-0095). An LXC guest is a CONTAINER —
 * the same thing the host-side probe already calls it ({@link inferNodeKind} maps `lxc`
 * virtualization to CONTAINER, so a guest that later runs the agent itself lands on the same
 * answer); everything else, `other` included, is a VM — the honest default for a machine a
 * hypervisor runs.
 */
export function guestNodeKind(kind: AgentGuestKind): InfraNodeKind {
  return kind === "lxc" ? "CONTAINER" : "VM";
}

/**
 * A guest's reported state → the child node's `status` (ADR-0095) — {@link containerNodeStatus}
 * one level up, same semantics: a LIVENESS FACT the agent owns, never curation. Only `running` is
 * ONLINE (`paused`/`suspended` are deliberately grouped with `stopped`: the map asks "is this thing
 * serving?", and none of them are). An unreported or unrecognised state is UNKNOWN rather than a
 * guess in either direction.
 */
export function guestNodeStatus(state: AgentGuestState | undefined): InfraNodeStatus {
  if (state === "running") return "ONLINE";
  return state === undefined || state === "other" ? "UNKNOWN" : "OFFLINE";
}

/**
 * The ack the report endpoint returns (ADR-0074 §3). It confirms the node id, its lifecycle `state`
 * (PENDING for a freshly-discovered host, CONFIRMED once a human has approved it) and that the report
 * was accepted.
 *
 * IT IS ALSO THE POLICY CHANNEL (#1140). `policy` carries the server-resolved configuration for this
 * exact agent, and it rides HERE rather than on a `GET /agent/policy` of its own because this round
 * trip is already authenticated, already per-agent and already happening: adding an endpoint would
 * have bought a second auth surface, a second throttle and a bootstrap ordering problem, in exchange
 * for nothing. The agent caches what it receives and applies it on its NEXT run, so the one-tick
 * propagation delay means a bad policy can never brick a fleet mid-collection.
 *
 * Nothing else leaks back to the machine caller: the policy is a closed set of booleans, integers and
 * globs ({@link AgentPolicySchema}) — never a command, a script, a path or a regex.
 */
export const AgentReportAckSchema = z.object({
  nodeId: z.cuid(),
  state: InfraNodeStateSchema,
  accepted: z.literal(true),
  /**
   * OPTIONAL in both directions, which is what makes the rollout safe without a version handshake.
   * A pre-#1140 SERVER omits it and a #1140 agent falls back to {@link AGENT_POLICY_DEFAULT}, i.e.
   * exactly today's behaviour; a pre-#1140 AGENT parses the ack loosely (it reads two fields off the
   * JSON and never validates it) so an ack carrying this key is simply ignored.
   */
  policy: AgentPolicySchema.optional(),
  /**
   * "Send me the whole software list next time" (#1142) — the half of the delta that keeps it honest.
   *
   * The server sets it when a report claimed `softwareState: 'unchanged'` and it could NOT corroborate
   * the claim: the node holds no list, holds one whose stored fingerprint is not the one claimed, or
   * the claim arrived with no `softwareHash` at all — a claim the server cannot check is the least
   * corroborated of the three, not the most trusted. All three happen for real: a node discarded and
   * rediscovered starts empty while the agent's cache still says "unchanged", a restore from backup
   * rewinds the stored list, a merge moves it, and a fingerprint that outgrows
   * {@link AGENT_SOFTWARE_HASH_MAX} is stripped by the agent's OWN parse while the state survives.
   * Without this the host's inventory would stay wrong until its packages happened to change, which on
   * a stable server is months. The server NEVER resolves the doubt by wiping: it keeps what it has and
   * asks. The agent answers by dropping its cached fingerprint, so the next report carries everything.
   *
   * NOT set for `unavailable`. It preserves the stored list identically, but it never claimed to HAVE
   * one — asking it to resend would ask a collector that could not enumerate, forever, for something it
   * does not have. A fingerprint that arrives beside it is still checked.
   *
   * OPTIONAL in both directions, like `policy`: a pre-#1142 server omits it, and a pre-#1142 agent
   * reads the ack loosely — a handful of named keys, never a schema — so one it does not know is
   * simply ignored.
   */
  softwareResend: z.boolean().optional(),
  /**
   * "I understand `softwareState`" (#1142) — the capability handshake the delta is GATED on, and the
   * reason the delta cannot silently destroy an inventory.
   *
   * {@link AgentReportSchema}'s root is a LOOSE `z.object()`, which is the #1138 decision that stops a
   * newer agent from 400-ing itself off the map against an older instance. Its cost is that an older
   * instance does not reject what it does not know — it silently STRIPS it. So a #1142 agent that
   * omitted its package list against a server built before this field would have its `softwareState`
   * and `softwareHash` dropped on the way in; that server would see no `software` key, read it the only
   * way it knows how, and CLEAR the stored list. And because the agent believes the list is unchanged,
   * it would never send it again: the host's inventory would be gone permanently, with no error
   * anywhere. `agentReportSkewPaths` would RECORD the strip on the node — recording is not preventing.
   *
   * So the agent may not omit anything until it has positive evidence, and this is that evidence. It
   * is a statement about the BUILD, not about the report, so every ack carries it; the agent caches it
   * beside its fingerprint and acts on it from the NEXT run, exactly as it does with `policy`. Until it
   * sees this the agent sends the whole list every time — degrading to the pre-#1142 bandwidth, never
   * to data loss.
   *
   * It is also self-healing DOWNWARDS: an instance rolled back to a pre-#1142 build stops sending the
   * key, the agent drops the cached evidence on that ack, and its next report carries the full list
   * again. That leaves exactly one report's worth of exposure to the old clearing behaviour — one
   * reporting interval of an empty panel, self-repaired — against permanent, silent loss without it.
   *
   * OPTIONAL in both directions, like `policy` and `softwareResend`: a pre-#1142 server omits it, and
   * a pre-#1142 agent reads the ack loosely — a handful of named keys, never a schema — so one it does
   * not know is simply ignored.
   */
  softwareDelta: z.boolean().optional(),
});
export type AgentReportAck = z.infer<typeof AgentReportAckSchema>;

// ── Confirm a PENDING node (ADR-0074 §3) — the review-tray approval ────────────────────────────────

/**
 * The optional overrides a human applies when CONFIRMING a PENDING agent-reported node from the review
 * tray (`POST /infra/nodes/:id/confirm`, ADR-0074 §3). Everything is optional — a bare `{}` confirms
 * the node as-is. `trackAsAsset` (default true) mints the backing Asset (the agent's host facts carried
 * over) so the auto-discovered host becomes a first-class, owned, assignable Asset — only on human
 * approval; `false` leaves it graph-only. `kind`/`label` let the operator re-classify/rename at the
 * confirm step (the agent lands every host as `PHYSICAL_HOST` with the hostname as its label).
 */
export const ConfirmInfraNodeSchema = z.strictObject({
  trackAsAsset: z.boolean().optional(),
  kind: InfraNodeKindSchema.optional(),
  label: z.string().trim().min(1).max(200).optional(),
});
export type ConfirmInfraNode = z.infer<typeof ConfirmInfraNodeSchema>;

// ── Re-key / merge-into (#1141) — the HUMAN half of identity reconciliation ────────────────────────

/**
 * `POST /infra/nodes/:id/merge-into` body: which EXISTING node the addressed one is really the same
 * host as. The addressed node is the duplicate; its agent identity (`reportingSource`/`externalId`)
 * is transplanted onto `targetNodeId` and the duplicate is soft-deleted.
 *
 * One field, and STRICT. The merge is the only place a node's dedup key can change after creation, so
 * it must not become a side door through which curation fields (label, kind, state) ride along — those
 * have their own PATCH, with its own permission and its own semantics.
 */
export const MergeInfraNodeSchema = z.strictObject({
  targetNodeId: z.cuid(),
});
export type MergeInfraNode = z.infer<typeof MergeInfraNodeSchema>;

/**
 * One re-image adoption hint (`GET /infra/nodes/:id/identity-matches`): another live node whose stored
 * corroborating evidence shares a burned-in fact with this one. It is what lets the tray say *"this
 * looks like `srv-app-04` re-imaged — adopt?"* instead of leaving the operator to notice that a host
 * they already own quietly went dark the same week a new proposal appeared.
 *
 * `matchedOn` is restricted to the two BURNED-IN facts. A hostname match is not evidence — hostnames
 * are recycled deliberately (that is the entire point of a naming convention), so offering one as an
 * adoption candidate would train the operator to click through a prompt that is usually wrong.
 */
export const InfraIdentityMatchSchema = z.object({
  id: z.cuid(),
  label: z.string(),
  kind: InfraNodeKindSchema,
  status: InfraNodeStatusSchema,
  state: InfraNodeStateSchema,
  matchedOn: z.enum(["serial", "mac"]),
  /** The shared value itself, so the UI can show WHY these two rows are being paired. */
  value: z.string(),
});
export type InfraIdentityMatch = z.infer<typeof InfraIdentityMatchSchema>;

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

export type IpAddress = z.infer<typeof IpAddressSchema>;
export type InfraNodeStatus = z.infer<typeof InfraNodeStatusSchema>;
export type InfraNodeSource = z.infer<typeof InfraNodeSourceSchema>;
export type InfraNodeIpSource = z.infer<typeof InfraNodeIpSourceSchema>;
export type InfraNodeState = z.infer<typeof InfraNodeStateSchema>;
export type InfraShortcut = z.infer<typeof InfraShortcutSchema>;
export type InfraNode = z.infer<typeof InfraNodeSchema>;
export type InfraNodeListItem = z.infer<typeof InfraNodeListItemSchema>;
export type CreateInfraNode = z.infer<typeof CreateInfraNodeSchema>;
export type UpdateInfraNode = z.infer<typeof UpdateInfraNodeSchema>;
export type InfraEdge = z.infer<typeof InfraEdgeSchema>;
export type CreateInfraEdge = z.infer<typeof CreateInfraEdgeSchema>;
export type InfraImpactNode = z.infer<typeof InfraImpactNodeSchema>;
export type InfraImpactResponse = z.infer<typeof InfraImpactResponseSchema>;
export type InfraNodeOwner = z.infer<typeof InfraNodeOwnerSchema>;
export type InfraNodeChild = z.infer<typeof InfraNodeChildSchema>;
export type InfraSecretRef = z.infer<typeof InfraSecretRefSchema>;
export type AttachInfraSecret = z.infer<typeof AttachInfraSecretSchema>;
export type InfraNodeDetail = z.infer<typeof InfraNodeDetailSchema>;
export type InfraAssetCandidate = z.infer<typeof InfraAssetCandidateSchema>;
// Agent report contract v2 (#1138).
export type AgentOsFamily = z.infer<typeof AgentOsFamilySchema>;
export type AgentChassis = z.infer<typeof AgentChassisSchema>;
export type AgentVirtualizationType = z.infer<typeof AgentVirtualizationTypeSchema>;
export type AgentIdentifierKind = z.infer<typeof AgentIdentifierKindSchema>;
export type AgentSoftwareSource = z.infer<typeof AgentSoftwareSourceSchema>;
export type AgentIpv6Scope = z.infer<typeof AgentIpv6ScopeSchema>;
// Auto-kind + container child nodes (#1139).
export type AgentContainerState = z.infer<typeof AgentContainerStateSchema>;
// Hypervisor guest inventory (ADR-0095, #1217).
export type AgentHypervisorPlatform = z.infer<typeof AgentHypervisorPlatformSchema>;
export type AgentGuestKind = z.infer<typeof AgentGuestKindSchema>;
export type AgentGuestState = z.infer<typeof AgentGuestStateSchema>;
export type AgentContainerPortProtocol = z.infer<typeof AgentContainerPortProtocolSchema>;
