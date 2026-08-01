import { z } from "zod";
import { requireAtLeastOneKey } from "./primitives";
import { ArticleListItemSchema } from "./article-list";

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
      assetId: z.cuid().nullable(), // null detaches the asset link
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
 * `GET /infra/nodes/:id` — the enriched drill-in (ADR-0070 §6). The whole reason to build this over a
 * Draw.io diagram: the node PLUS its asset-backed payoff (owner, KB links, secret handles, shortcuts,
 * IP) and its children (active inverse RUNS_ON). `label` is the canvas display name and always wins;
 * `assetName` is the secondary "inventory name" from the linked Asset (null when graph-only). The KB
 * links reuse the lean `ArticleListItem` shape (PUBLISHED only, folder-scoped to the caller).
 */
export const InfraNodeDetailSchema = InfraNodeSchema.extend({
  /** The linked Asset's `name` (the secondary "inventory name"); null when the node is graph-only. */
  assetName: z.string().nullable(),
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

/**
 * What the host physically IS — the hint `kind` inference (#1139) will read to stop landing every
 * reported host as `PHYSICAL_HOST`. `vm`/`container` come from the virtualization probe, the rest
 * from SMBIOS chassis type (or its per-OS equivalent).
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

/** Cap on `host.identifiers` — a corroborating SET, not a log; a sane upper bound, not a real limit. */
export const AGENT_IDENTIFIERS_MAX = 16;

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
 * The signal is MOVED, not lost: the handler diffs the raw body's root keys against
 * {@link AGENT_REPORT_ROOT_KEYS} via {@link unknownAgentReportKeys} and records what it dropped, so a
 * typo'd root key is still diagnosable — which matters most next to #1142, where an ABSENT `software`
 * key will come to mean "unchanged".
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
  externalId: z.string().min(1).max(200),
  /** When the agent gathered this report (ISO-8601). */
  reportedAt: z.iso.datetime(),
  host: z.object({
    /** The only REQUIRED host fact — used as the new node's label. */
    hostname: z.string().min(1).max(255),
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
    /** Corroborating identity evidence for #1141 — never a dedup key on its own. */
    identifiers: z
      .array(
        z.object({
          kind: AgentIdentifierKindSchema.catch("other"),
          value: z.string().min(1).max(200),
        }),
      )
      .max(AGENT_IDENTIFIERS_MAX)
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
          /** v1 carried IPv4 only while {@link IpAddressSchema} already accepted v6 — a v6-only host
           * therefore reported NO address at all. Closed here (#1138). */
          ipv6: z.array(z.string().max(64)).max(64).optional(),
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
  /** Installed packages (dpkg/rpm/apk auto-detected). Capped — a sane upper bound, not a real limit. */
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
   * What the collector could NOT do (#1138). This is what lets a fleet view say "web-03: reporting
   * unprivileged, no serial/model" instead of leaving the operator staring at an empty row wondering
   * whether the host is broken or the agent is. `warnings` names each collector that timed out or was
   * skipped for lack of privilege (the #1133 timeout path), `privileged` says whether the run had
   * root, `durationMs` how long collection took.
   */
  diagnostics: z
    .object({
      warnings: z.array(z.string().max(300)).max(50).optional(),
      privileged: z.boolean().optional(),
      durationMs: z.number().int().nonnegative().optional(),
    })
    .optional(),
  /**
   * The policy revision the agent last applied (#1140, server-driven policy). RESERVED: defined here
   * so the field never has to be added under time pressure once the policy channel exists. Nothing
   * reads it today — the server accepts and stores it, and that is all.
   */
  policyRevision: z.number().int().nonnegative().optional(),
});
export type AgentReport = z.infer<typeof AgentReportSchema>;

/**
 * The root keys this server understands — the known set the handler diffs a raw body against. Derived
 * from the schema itself so it can never drift from what is actually parsed.
 */
export const AGENT_REPORT_ROOT_KEYS: readonly string[] = Object.freeze(
  Object.keys(AgentReportSchema.shape),
);

/** Cap on the recorded unknown-key list (see {@link unknownAgentReportKeys}). */
export const AGENT_REPORT_UNKNOWN_KEYS_MAX = 10;

/** Cap on each recorded key NAME — long enough to identify a real field, short enough to be inert. */
const AGENT_REPORT_UNKNOWN_KEY_MAX_LENGTH = 64;

/**
 * The root keys of a raw report body this server does NOT understand — what the loosened root
 * silently dropped (#1138). Pure, so the API can record it and any future consumer can reuse it.
 *
 * BOUNDED on purpose: the result is persisted, and the body is attacker-controlled (the report
 * endpoint is machine-facing), so an unbounded diff would let a hostile caller write megabytes of
 * junk key names into a jsonb column through a field designed to be a diagnostic. At most
 * {@link AGENT_REPORT_UNKNOWN_KEYS_MAX} keys, each truncated — enough to say "this agent sent
 * `deltaSince` and we ignored it", never enough to be a payload. Non-object bodies yield `[]` (the
 * caller runs this before anything else has validated the body).
 */
export function unknownAgentReportKeys(body: unknown): string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
  const known = new Set(AGENT_REPORT_ROOT_KEYS);
  return Object.keys(body)
    .filter((key) => !known.has(key))
    .slice(0, AGENT_REPORT_UNKNOWN_KEYS_MAX)
    .map((key) => key.slice(0, AGENT_REPORT_UNKNOWN_KEY_MAX_LENGTH));
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

/**
 * A NIC's first non-empty, non-LINK-LOCAL IPv6 (trimmed). `fe80::/10` is filtered because a
 * link-local address is not one the host is reachable at — promoting it to the node's `ipAddress`
 * would put a value on the map that no operator can ever connect to.
 */
function firstNicIpv6(nic: NonNullable<AgentReportHost["nics"]>[number]): string | undefined {
  return nic.ipv6
    ?.map((ip) => ip.trim())
    .find((ip) => ip.length > 0 && !ip.toLowerCase().startsWith("fe80:"));
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
 * else the first routable IPv6 (link-local skipped) on a non-loopback NIC, else any NIC's. IPv4 keeps
 * winning wherever it exists, so every dual-stack node's `ipAddress` is exactly what it was before —
 * the fallback only fires on a v6-ONLY host, which the v1 contract left with no address at all even
 * though {@link IpAddressSchema} has always accepted v6. Same validate-or-drop rule: a malformed value
 * is dropped, never a 400 on the whole report (ADR-0090 / ADR-0074 §3).
 */
export function primaryIp(host: AgentReportHost): string | undefined {
  const ipv4 = primaryIpv4(host);
  if (ipv4 !== undefined) return ipv4;
  const nics = host.nics ?? [];
  const candidate =
    nics.filter((n) => n.name !== "lo").map(firstNicIpv6).find(Boolean) ??
    nics.map(firstNicIpv6).find(Boolean);
  const parsed = IpAddressSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
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
 * The host's hardware serial, sanitized (issue #1081): trimmed, with the well-known dmidecode junk
 * placeholders rejected (case-insensitive) and any all-same-character string (e.g. `000000`, `......`)
 * dropped. Returns `undefined` for an empty/absent/junk serial so the caller leaves the Asset serial
 * null (the raw value still survives verbatim in `specs.host.hardware.serial`). Never promote junk to
 * the unique canonical `Asset.serial`.
 */
export function sanitizeSerial(host: AgentReportHost): string | undefined {
  const raw = host.hardware?.serial?.trim();
  if (!raw) return undefined;
  if (SERIAL_JUNK_PLACEHOLDERS.has(raw.toLowerCase())) return undefined;
  // A single character repeated (length ≥ 1) is a placeholder, not a real serial.
  if (/^(.)\1*$/.test(raw)) return undefined;
  return raw;
}

/**
 * The minimal ack the report endpoint returns (ADR-0074 §3). Fire-and-forget by design: it confirms
 * the node id, its lifecycle `state` (PENDING for a freshly-discovered host, CONFIRMED once a human
 * has approved it) and that the report was accepted. Nothing more leaks back to the machine caller.
 */
export const AgentReportAckSchema = z.object({
  nodeId: z.cuid(),
  state: InfraNodeStateSchema,
  accepted: z.literal(true),
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
// Agent report contract v2 (#1138).
export type AgentOsFamily = z.infer<typeof AgentOsFamilySchema>;
export type AgentChassis = z.infer<typeof AgentChassisSchema>;
export type AgentVirtualizationType = z.infer<typeof AgentVirtualizationTypeSchema>;
export type AgentIdentifierKind = z.infer<typeof AgentIdentifierKindSchema>;
export type AgentSoftwareSource = z.infer<typeof AgentSoftwareSourceSchema>;
