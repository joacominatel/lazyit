---
title: "ADR-0055: On-prem / internal-target connectors — a per-connection audited allowlist"
tags: [adr, workflow-engine, security, egress, connectors, on-prem]
status: proposed
created: 2026-06-09
deciders: [Joaquín Minatel]
---

# ADR-0055: On-prem / internal-target connectors — a per-connection audited allowlist

## Status

**proposed** — a Phase-2 follow-up to [[0054-applications-workflow-engine]] (epic #248). **The CEO is
holding the build**; this ADR exists for later ratification, not to authorize code. It picks up the
explicit roadmap promise in ADR-0054 §6(b) ("on-prem / internal-target connectors via an explicit,
audited, per-connector internal-target allowlist … a **real priority** — the LATAM market lazyit
targets barely uses cloud") and the egress design's open question (`docs/workflow-engine/security.md`
§3.3 / §3.4 / §10-Q1). It builds on the **already-shipped** egress guard
(`apps/api/src/common/egress/**`) — specifically its `isInternalTargetAllowed` seam and the IP
classifier — which were designed to receive exactly this allowlist with **no rework**. It extends the
frozen permission catalog ([[0046-roles-permissions-v2]]) and reuses the append-only, redacted
config-audit discipline ([[0006-soft-delete-and-auditing]] / [[0031-logging-strategy]]). The
[[0048-service-accounts]] fail-closed posture applies unchanged.

> **Scope of this ADR.** A **per-`WorkflowConnection` explicit internal-target allowlist** that turns an
> implicit SSRF vector into an explicit, audited, ADMIN-only configuration decision, wired to the seam
> the egress guard already exposes. It enables an **internal HTTP/REST target** (e.g.
> `https://vpn.corp.local:8443`, an on-prem self-hosted app), **not** a native LDAP/AD connector — that
> is a separate, protocol-first decision (see the boundary note below). No new infrastructure lands in
> v1 of this feature; the dedicated egress-isolated worker is layered defense-in-depth, later.

## Context

ADR-0054 shipped the workflow engine with a **public-only** egress posture (decision §6b): connector
base URLs must validate as `https://` public destinations (`packages/shared/src/schemas/workflow.ts`
`publicHttpsUrl`), and the runtime egress guard **denies every resolved private / loopback /
link-local / metadata / reserved address by default**. That was the correct, safe v1 default — but it
**breaks the product's own stated use case**:

- **lazyit deliberately targets on-prem-heavy markets.** ADR-0054 §6(b) names this a *real priority*:
  the LATAM IT shops lazyit serves barely use cloud, so provisioning into an on-prem self-hosted app, a
  box behind `vpn.corp.local`, or an internal REST gateway is a **first-class** future integration, not
  an edge case. `docs/workflow-engine/security.md` §3.2 makes the same point: ADR-0023 already lets
  `vpn.corp.local` be an `Application.url`, and the feature brief lists "a self-hosted target" as a
  first-class integration type. A blanket private-IP block contradicts the product.
- **But the engine is an admin-operated SSRF cannon** (ADR-0054 Context). Naively relaxing the guard to
  "allow private" would leave the **whole LAN reachable** from a templated outbound request — the
  classic SSRF blast radius. The relaxation must be **narrow, explicit, audited, and impossible to
  point at the engine's own co-located secrets** (Valkey, Postgres, Zitadel) or the cloud metadata
  service.
- **The seam already exists, by design.** The egress guard was built Phase-0 with this exact extension
  point: `EgressGuardOptions.isInternalTargetAllowed` (`apps/api/src/common/egress/types.ts`) is
  consulted **only** for `private` (RFC1918) and `uniqueLocal` (IPv6 ULA) categories
  (`apps/api/src/common/egress/ip-rules.ts` `isAllowlistableCategory`). `localhost` / `127.0.0.0/8` /
  `::1` / IMDS (`169.254.169.254`, `fd00:ec2::254`) / link-local / CGNAT / multicast / broadcast /
  reserved are classified into categories that **never reach the seam** and so are **un-allowlistable by
  construction**, not by a config flag a typo could flip. This ADR is the decision to **wire a real,
  stored, audited allowlist into that seam** — the guard does not change.

The forces, restated as constraints this decision must satisfy:

- **Un-allowlistable ranges stay un-allowlistable, structurally** — never a settable flag.
- **The relaxation is per-connection and opt-in** — a public connection keeps the clean https-only
  400; nothing about the public path changes.
- **Every add / remove / re-point is an audited, redacted, append-only event**, ADMIN-gated.
- **`http://` to a private host is permitted ONLY when coupled to a non-empty allowlist** — never a
  blanket cleartext downgrade.
- **No new infrastructure for v1 of this feature** — it is a shared-contract change + an allowlist
  store + the wiring, not a new container.

## Considered options

### Egress relaxation model (the crux — `docs/workflow-engine/security.md` §3.4)

- **(A) Deny-private by default + a per-connection explicit internal-target allowlist (chosen).** Most
  secure: the operator pays a one-time, consequential "add your internal host `vpn.corp.local:8443`"
  step per internal connector, acknowledging "this target is on your internal network." Converts an
  *implicit* SSRF vector into an *explicit, audited* configuration decision. Fits "errors are loud,
  defaults are safe." `localhost` / IMDS remain un-allowlistable regardless.
- **(B) Allow any non-loopback / non-metadata, block only the engine's own services — rejected.** Lower
  friction, but materially weaker: the **entire LAN stays reachable** from any connector, so a single
  misconfigured or compromised template re-opens the full SSRF blast radius. "Block only our own
  services" is also a fragile denylist — the exact `parse-and-allowlist`, never-blocklist lesson the
  guard was built on (SEC-008 / SEC-051). Rejected.
- **Deployment-level egress policy alone — rejected as the sole control, kept as the future OUTER
  bound.** A single instance-wide "these CIDRs are reachable" list is **too coarse** to be the primary
  control: it can't express "connection X may reach `vpn.corp.local`, connection Y may not," and it
  pushes the SSRF decision away from the person configuring the connector. It is, however, the *right
  outer bound* later — a deployment ceiling the per-connection allowlist must stay within once
  `workflow:manage` is delegated (Open-fork (c)).
- **An outbound relay / agent installed inside the customer network — rejected for v1 (strongest, but
  too heavy).** A lazyit-shipped agent the engine pushes work to (the customer's box dials *out* to
  lazyit, never lazyit *in*) is the strongest isolation and the eventual answer for deep on-prem (AD,
  LDAP, no inbound). But it is a whole new deployable, protocol and lifecycle — a violation of the
  single-host, IT-generalist constraint for *this* step. Deferred to its own ADR.

### Allowlist breadth

- **A list of specific `host[:port]` entries (chosen).** The narrowest unit that still serves the use
  case: an admin allowlists `vpn.corp.local:8443`, not "all of `10.0.0.0/8`." Matched against the
  *resolved* target inside the seam.
- **CIDR ranges / "allow all private" — rejected.** A CIDR re-creates the (B) blast radius by the back
  door; "allow all private" is exactly the posture the guard exists to prevent. Never offered.

### Coupling `http://` relaxation to the allowlist (shared contract)

- **Relax `publicHttpsUrl` so `http://` + a private host validates ONLY when the connection declares a
  non-empty `internalTargetAllowlist` — chosen.** A `zod` `superRefine` **couples** the two fields on
  the `WorkflowConnection` config object: a connection with a non-empty allowlist may use an `http://`
  base URL pointing at a private host; a connection without one still gets the clean **https-only 400**.
  Cleartext is never an implicit, free downgrade.
- **A separate `allowHttp` boolean independent of the allowlist — rejected.** Decouples the two
  decisions, so a connection could enable cleartext without declaring a target — exactly the implicit
  downgrade ADR-0054's `publicHttpsUrl` comment (SEC-A4: secure-by-default) forbids.

## Decision

Adopt **option (A): a per-`WorkflowConnection` explicit, audited, ADMIN-gated internal-target
allowlist**, wired to the **already-built** `isInternalTargetAllowed` seam. The IP classifier is the
hard floor; the stored allowlist is the only soft surface, and it can only ever widen reach into
RFC1918 / ULA — never into loopback, IMDS, link-local or reserved space.

### 1. The classifier is the hard floor — un-allowlistable by construction

This ADR **does not touch** `apps/api/src/common/egress/ip-rules.ts`. The guard consults the seam
**only** for the `private` and `uniqueLocal` categories (`isAllowlistableCategory`). `localhost` /
`127.0.0.0/8` / `::1` / IMDS (`169.254.169.254`, `fd00:ec2::254`) / `fe80::/10` link-local / CGNAT /
multicast / broadcast / reserved / unspecified are classified into categories that **never reach the
seam**. No allowlist entry, however written, can make them reachable — they are denied *before* the
allowlist is consulted. This protects the engine's own co-located secrets (Valkey, Postgres, Zitadel)
and the cloud IMDS unconditionally. The allowlist is therefore strictly a way to widen reach **within**
the two already-allowlistable categories, never beyond them.

### 2. A stored, per-connection `internalTargetAllowlist`

A `WorkflowConnection` gains an optional **`internalTargetAllowlist`**: a list of specific
`host[:port]` entries (a host, optionally pinned to a port). It is **never** a CIDR and **never**
"allow all private" (Open-fork (a)). At execute / test / dry-run time the engine constructs the seam
function for *this* connection so that `isInternalTargetAllowed(ctx)` returns `true` **iff** the
resolved target (`ctx.hostname` / `ctx.port`) matches an entry in this connection's list — and the
classifier has already guaranteed `ctx.category ∈ {private, uniqueLocal}` before the function is even
called. An empty / absent allowlist ⇒ the seam denies (the ADR-0054 public-only default, unchanged).

### 3. The shared contract couples `http` to the allowlist

`packages/shared/src/schemas/workflow.ts` is extended (Phase-2 of this feature) so that:

- The connection base URL (`RestConnectionConfigSchema.baseUrl` / `WebhookOutConnectionConfigSchema.url`)
  may be `http://` **only** on a connection that also declares a **non-empty** `internalTargetAllowlist`,
  enforced by a **`superRefine` on the connection object** (the two fields are validated together, not
  in isolation). A connection with no allowlist keeps the existing `publicHttpsUrl` behavior — a non-https
  value is a clean **400** at the edge.
- This is the **only** way `http://` becomes valid. There is no standalone `allowHttp` flag; cleartext
  is coupled to a declared internal target by construction.

### 4. Execute / test-time guard parameters

When the engine dials a connection that has a non-empty allowlist, it passes the egress guard:

- `isInternalTargetAllowed` = the per-connection matcher from §2 (entry-list membership over the
  *resolved* target), and
- `allowedProtocols` extended to include `'http:'` **only for that connection** (every public connection
  keeps `['https:']`).

The guard then **re-runs full policy on every redirect**: the DNS-rebind IP pin and the socket pin
survive, the classifier re-classifies each hop, and the seam re-checks each private/ULA hop against the
same per-connection list. A redirect cannot escape the connection's allowlist, and cannot be tricked
into a loopback/IMDS hop (the classifier floor, §1).

### 5. RBAC — gate writing the allowlist behind a NEW `workflow:egress` permission

Writing (add / remove / re-point) an `internalTargetAllowlist` is gated behind a **new
`workflow:egress` permission** (recommended — Open-fork (b)), seeded **ADMIN-only** by default, like the
other coarse `workflow:*` verbs. The rationale: **LAN-reach is a distinct duty from token-holding** —
"who can point a connector at the internal network" should be separable from "who holds the Jira token"
(`workflow:secrets`) and from "who authors the automation logic" (`workflow:manage`), the same
separation-of-duties instinct ADR-0046 §4.1 / ADR-0054 §5 already encode. At **minimum**, if the CEO
declines a new permission, this is gated by the existing `workflow:secrets`; it must **never** be a mere
`workflow:manage` capability (authoring logic ≠ widening the SSRF surface). Adding `workflow:egress` is a
catalog-as-code `@lazyit/shared` change + a golden-test update; **a shared-catalog change must be
re-typechecked against the web's exhaustive permission maps** (project memory:
`shared-changes-need-web-typecheck`).

### 6. Audit — append-only, redacted, the CSEC-1 pattern

Every allowlist **add / remove / re-point** is an **append-only, attributed, redacted** config-audit
event (Open-fork (d)) — reuse the workflow-scoped config-audit shape ADR-0054 §5.1.6 /
`docs/workflow-engine/security.md` §5.1.6 already defines (the same shape used for create/edit/delete a
workflow, set/rotate a secret, enable/disable a connector). The event records *who*, *when*, *which
connection*, and *which host[:port] entry* changed — never a secret, never a body (INV-6). Pointing a
connector at the internal network is a consequential, traceable act.

### 7. `tlsVerify` defaults true; a downgrade is a loud, audited choice

`tlsVerify` defaults **true** for every connection, internal targets included
(`docs/workflow-engine/integrations-connectors.md` §4.1). A self-signed internal box may set it `false`
**only** as a deliberate, audited downgrade surfaced with a loud UI warning — the same posture as the
`http`-relaxation: an internal target never *silently* weakens transport security.

### 8. No new infrastructure for v1 of this feature

This feature ships as a **shared-contract change + an allowlist store + the seam wiring + the RBAC entry
+ the audit events** — no new container, queue or service. The **dedicated egress-isolated worker**
(a network-namespaced processor that can *only* reach allowlisted targets) is **defense-in-depth layered
later** (ADR-0054 follow-ups), not a prerequisite. The allowlist + the classifier floor are the v1
control surface.

### Boundary — this is an internal HTTP/REST target, NOT a native LDAP/AD connector

This decision enables the egress guard to **dial an internal HTTP/REST endpoint**. It does **not**
introduce LDAP, AD, Kerberos or any non-HTTP protocol — those need their own client, auth model and
threat surface and are a **separate, protocol-first ADR** (and likely ride the deferred
outbound-relay/agent model above for deep on-prem). Keeping this boundary bright preserves the ADR-0054
scope discipline (§6c): this is provisioning into an internal *HTTP* app, not an identity/directory
integration.

## Open forks (CEO decisions — why this ADR is `proposed`)

These are the live decisions the CEO is holding the build on. The recommendation is stated; ratifying
this ADR means choosing.

- **(a) Allowlist breadth — `host[:port]` vs CIDR.** *Rec: `host[:port]` entries, never CIDR, never
  allow-all-private.* A CIDR re-opens the LAN blast radius by the back door.
- **(b) Gating permission — `workflow:secrets` vs a NEW `workflow:egress`.** *Rec: a new
  `workflow:egress`*, to separate LAN-reach from token-holding (SoD). Minimum acceptable fallback:
  `workflow:secrets`. Never plain `workflow:manage`.
- **(c) Allowlist scope — per-connection vs deployment-level vs both.** *Rec: per-connection now*, with a
  deployment-level **outer bound** added later (the ceiling a per-connection list must stay within) once
  `workflow:manage` is delegated beyond ADMIN.
- **(d) Audit depth.** *Rec: reuse the existing append-only, redacted config-audit* (ADR-0054 §5.1.6) —
  no bespoke audit subsystem.
- **(e) `http`-relax safety.** *Rec: `http://` validates only when a non-empty allowlist is present* (the
  `superRefine` coupling) — never a standalone cleartext flag.

## Consequences

- **Positive:**
  - The product's first-class on-prem use case becomes reachable **without weakening the public path** —
    public connections keep the https-only 400 and deny-private-by-default posture verbatim.
  - The dangerous ranges (loopback, IMDS, link-local, reserved) stay **un-allowlistable by
    construction** — a config typo can never reach the engine's own co-located secrets or the cloud
    metadata service. The soft surface only ever widens into RFC1918 / ULA.
  - The seam was **built for exactly this** (Phase-0): wiring a stored allowlist requires **no rework**
    of the guard or the classifier — the IP floor and the redirect re-validation come for free.
  - Pointing a connector at the LAN is an **explicit, ADMIN-gated, audited** act — an *implicit* SSRF
    vector becomes an *explicit, traceable* configuration decision.
- **Negative / trade-offs (accepted):**
  - **`http://` cleartext to a private host becomes possible** (coupled to an allowlist). Accepted: many
    on-prem boxes have no TLS; the coupling + `tlsVerify` posture keep it loud and audited, never silent.
  - **A new `workflow:egress` permission** (if (b) is taken) is one more catalog literal and a forced web
    re-typecheck of the exhaustive permission maps. Accepted for separation of duties.
  - **A per-connection allowlist is one more thing to back up and review.** Accepted — it is small,
    audited, and ADMIN-scoped.
  - **Deep on-prem (LDAP/AD, no-inbound networks)** is *not* solved here — only an internal HTTP/REST
    target is. The relay/agent and a native directory connector remain deferred.
- **Follow-ups (when the CEO greenlights the build):** the `internalTargetAllowlist` column/contract on
  `WorkflowConnection`; the `superRefine` coupling in `@lazyit/shared` `workflow.ts`; the per-connection
  seam constructor + `allowedProtocols` extension at execute/test time; the `workflow:egress` catalog
  literal + seed + golden test + web exhaustive-map re-typecheck; the config-audit events; and — later,
  as defense-in-depth — the deployment-level outer bound and the egress-isolated worker container. A
  native LDAP/AD connector and the outbound relay/agent are **separate ADRs**.

Related: #248 · [[0054-applications-workflow-engine]] · [[0053-async-workers-bullmq-valkey]] ·
[[0048-service-accounts]] · [[0046-roles-permissions-v2]] · [[0031-logging-strategy]] ·
[[0023-access-management-design]] · [[0007-flexible-asset-specs-jsonb]] ·
[[0006-soft-delete-and-auditing]] · `apps/api/src/common/egress/` (the egress guard + the
`isInternalTargetAllowed` seam + the IP classifier) · `docs/workflow-engine/security.md` (§3) ·
`docs/workflow-engine/integrations-connectors.md`
