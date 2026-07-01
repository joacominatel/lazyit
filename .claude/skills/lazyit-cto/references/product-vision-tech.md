# Product Vision (Technical Interpretation)

> This document interprets **what lazyit is and what it is becoming** from a technical and architectural perspective. It exists so the CTO has a strategic anchor when making decisions: when scope expands, when trade-offs appear, when subagents ask "should I build it this way or that way," this file is the reference for "what serves the product."
>
> **Owner**: CTO. Updated whenever a meaningful strategic decision is taken — product positioning, target audience shift, deployment model change, etc.
>
> **Not redundant with `docs/00-overview/`**: that folder describes the product to humans (vision, problem space, competitors). This file describes it to the CTO from a systems perspective — how the technical choices serve (or fail to serve) that vision.

---

## What lazyit is

lazyit is **an internal IT management application** for IT teams, designed to replace the fragmented tooling those teams typically use (spreadsheets, ticketing tools bolted onto incident managers, wiki sprawl, shared inboxes for access requests).

It targets the **5-to-200-person company** — too small for ServiceNow, too large for "Excel and Slack." The IT team running it is between 2 and 20 people.

It is the product version of the question: *"what would IT management look like if it were designed by IT people, in 2026, with modern web tech, and self-hostable by default?"*

---

## The three pillars

The product is built around three operational pillars an IT team handles daily:

1. **Inventory** — assets, models, locations, owners, history, consumables. The "what we have, where it is, who's using it" layer.
2. **Access** — applications, permissions, who has access to what, who requested access, audit trail. The "who can do what" layer.
3. **Knowledge** — articles, runbooks, internal documentation, on-call playbooks. The "how we do things" layer.

These three are first-class in the data model and the UI. Everything else (tickets, notifications, integrations, webhooks) builds **on top of these three**, not parallel to them. When proposing new features, the CTO must check: *does this strengthen one of the three pillars, or is it scope creep?*

> **Update (2026-07-01):** the three pillars still anchor the product, but capability has grown well beyond them and two adjacent surfaces are now first-class in their own right: a **zero-knowledge Secret Manager** (vaults beside the KB; the server can never decrypt — INV-10, ADR-0061) and an **Infra-topology CMDB** (a generic visual map of the server estate — InfraNode/InfraEdge, ADR-0070), fed by a **self-installing Linux reporting agent** (inventory-only, review-tray-gated — ADR-0074). Auditability is now *surfaced*, not just stored (an in-app audit read + CSV export, ADR-0081; reveal/offboard auditing). Read these as **deepenings of Inventory + Access + Knowledge under the auditable-by-default philosophy**, not a fourth pillar — but the "three pillars" framing below is no longer the whole map.

---

## Distribution model

This is the most consequential technical decision shaping every other one.

### Self-hosted is primary

lazyit is designed to be **self-hosted** by the customer. This is non-negotiable for the target audience: IT teams at small-to-mid companies tend to distrust SaaS for their own internal tooling, and many operate in regulated environments where data residency matters.

**Technical consequences**:
- Docker Compose is the deployment unit
- Stateful services (Postgres, search, identity) live alongside the app
- The customer's IT team — not us — is the operator
- Zero outbound dependencies on us at runtime
- Backups, migrations, and disaster recovery are the customer's responsibility (we provide runbooks)
- Updates happen via Docker image versions, not auto-update servers
- No telemetry, no analytics, no "phone home"

### SaaS is a future possibility, not today

A multi-tenant SaaS offering is a long-term option for customers who don't want the operational burden. But **it is not the primary mode**. Every technical decision that would compromise self-hosted to make SaaS easier is the wrong call.

**Specifically**:
- The identity provider must support both modes
- The database must be self-contained per deployment by default
- Authentication must work without our infrastructure being reachable
- Multi-tenancy support, when added, is additive — not a refactor of the single-tenant codebase

### Bring-your-own-identity is supported

We ship with a default IdP (Zitadel in Docker), but customers with existing identity infrastructure (Active Directory, their own Keycloak, Okta) must be able to swap our default for theirs by changing configuration — without code changes, without us being involved.

**Technical consequence**: the backend speaks **standard OIDC**. It does not assume Zitadel specifically. The bundled Zitadel is a default convenience, not an architectural dependency.

---

## Target operator profile

The person who installs and runs lazyit is an **IT generalist**, not a platform engineer.

They know Docker, but barely. They can edit a `.env` file. They can run `docker compose up -d`. They can read a runbook.

They cannot:
- Operate Kubernetes
- Debug a Postgres internals issue
- Hand-craft an OIDC provider configuration from scratch
- Maintain a microservices architecture

**Technical consequences**:
- One `docker compose up` brings everything online
- Configuration is in `.env` files, not in YAML templates
- Errors are loud, actionable, and explained in plain language
- Defaults are safe and sensible
- The system is observable from the outside (health endpoints, structured logs) without specialized tools
- Documentation is operator-first: runbooks before architecture docs

When a subagent proposes adding a component (a queue, a worker, a cache, a search service), the CTO must verify: **does this preserve the "one-command setup" experience for the operator?** If yes, proceed. If not, the proposal needs justification proportional to the operational cost it adds.

---

## Stack philosophy

The stack is conservative-modern: well-known foundations, modern application frameworks, no exotic dependencies.

### What we use and why

- **TypeScript everywhere** — single language across frontend, backend, shared package. Operator and developer cognitive load is lower.
- **Monorepo (Bun workspaces + Turborepo)** — one repo, one build system, shared code is genuinely shared.
- **NestJS (backend)** — opinionated structure, mature, good for a domain-heavy app.
- **Prisma (ORM)** — schema-first, migrations are first-class, type-safe.
- **PostgreSQL** — boring, reliable, scales further than we'll need.
- **Next.js App Router (frontend)** — server components where they help, client where they must.
- **Tailwind v4 + shadcn/ui** — design tokens, no CSS-in-JS overhead.
- **Meilisearch** — fast, self-hostable, simple search.
- **Pino** — structured logs, fast, the standard.
- **Zod** — runtime validation that doubles as TypeScript inference.

### What we deliberately avoid

- **Microservices** — premature for this scale; a well-organized modular monolith serves better
- **GraphQL** — adds complexity, REST + Zod schemas are sufficient
- **NoSQL primary store** — the domain is relational
- **Custom auth** — OIDC via external IdP, no homemade JWT
- **Heavy build tooling** — Bun + Turborepo, nothing else
- **CSS-in-JS runtime** — Tailwind compiles, no runtime cost
- **Realtime by default** — most features don't need it; introduce when justified

### When to deviate

If a subagent proposes a stack deviation, the CTO must verify:
1. Is there an ADR proposing this deviation?
2. Does the deviation serve the product vision (self-hosted, operator-friendly, three pillars)?
3. Does it pay back operational cost within a foreseeable timeframe?

If any answer is "no," the CTO either rejects the proposal or escalates to the CEO with a recommendation.

---

## Domain philosophy

### Asset-centric, not user-centric

ServiceNow and most ITSM tools are organized around the **user** as the central entity (incidents are filed by users, against users, resolved by users). lazyit is organized around the **asset**.

Why: in small IT teams, the operational reality is "the laptop in slot B-3 needs a new SSD" or "the office printer is misbehaving." The asset is what the team operates on; the user is metadata.

This shows up technically:
- `Asset` is the most-linked entity in the schema
- Owners are timestamped many-to-many via `AssetAssignment` (an asset can have multiple owners over time)
- `AssetHistory` exists for assets, not for users
- The dashboard, when it materializes, is asset-oriented (with user context layered in)

When a feature proposal feels like it shifts focus to the user as the operational center, the CTO must flag it and escalate if necessary. The asset-centric stance is **a load-bearing decision**.

### Soft-delete everywhere; append-only where it matters

All domain entities have `deletedAt` for soft delete. This was made automatic via a Prisma middleware so services do not have to remember to filter.

Append-only tables (`AssetAssignment`, `AccessGrant`, `AssetHistory`, `ConsumableMovement`) do **not** soft-delete. They accumulate history. The CTO must enforce this distinction when proposing schema changes.

### Sensible numeric and ID types

- Primary IDs: `cuid()` for domain entities, `uuid` for User (per ADR-0005)
- Counts and quantities: `int` with explicit bounds (a recent bug surfaced where defaults of `Number.MAX_SAFE_INTEGER` overflowed `int4`)
- Money is not yet in the domain; when it arrives, decimal/money types only, never floats

---

## Auth and identity

> **Update (2026-07-01): DONE.** Auth is no longer pending — it was delivered and validated live end-to-end on 2026-06-01. The section below is retained for history; the shim it describes now survives only as `AUTH_MODE=shim` (dev/tests, prod-guarded).

**Current reality:**
- **AuthN**: generic OIDC (bundled **Zitadel** default, BYOI by env), `JwtAuthGuard` validates a Bearer JWT via JWKS (RS256-pinned); JIT provisioning + email account-linking on first login (ADR-0037/0038/0039/0043).
- **AuthZ**: **RBAC v2** — 3 FIXED roles (ADMIN/MEMBER/VIEWER) with **fully-configurable per-role permissions** (a catalog-as-code + `RolePermission` matrix + `@RequirePermission`); **DB-first, a token claim is never an authZ source** (INV-1); ADMIN immutable/full (INV-8). Read-authz is CLOSED (ADR-0046).
- **Non-human principals**: **Service Accounts** with native hashed `lzit_sa_…` tokens + direct catalog grants (ADR-0048), extended to hold a keypair for headless secret retrieval (ADR-0080).
- **Zitadel is the source of truth** with app→IdP write-back via the Management API; BYOI degrades gracefully (ADR-0043).

**Historical (pre-2026-06-01):** Auth was the single largest pending decision. A shim header `X-User-Id` simulated the caller (ADR-0022); `User.externalId` was reserved for the OIDC `sub`. The auth epic (devops IdP setup + backend OIDC + frontend Auth.js login) delivered all of it; ADR-0016/0022/0024 are superseded.

---

## What lazyit is **not**

Saying what the product is not is as important as saying what it is. The CTO uses this list to push back when scope creeps.

- **Not a ticketing system.** Tickets are a future option. They are not a pillar.
- **Not a monitoring tool.** lazyit does not poll devices, does not collect metrics, does not page on-call. Other tools do that. lazyit references those tools. *(2026-07-01: the self-installing Linux reporting agent (ADR-0074) deliberately stays on the right side of this line — it reports **inventory only** (host identity/hardware/installed software) for **itself**, review-tray-gated; explicitly no health snapshots, no time-series metrics, no alerting.)*
- **Not an HR system.** Users exist for access and ownership. Onboarding workflows, payroll, etc. are outside scope.
- **Not a CRM.** No customer-facing entities. The user base is the IT team and the company employees they support, period.
- **Not enterprise.** The target is mid-market. If a feature only makes sense at 10,000+ employees, it is not for us.

When a feature proposal makes lazyit resemble any of the above, the CTO escalates with a clear "this drifts from positioning" framing.

---

## Strategic horizons

> **Update (2026-07-01):** most of the near/medium-term items below have shipped. Auth is done; the Workflow Engine (ADR-0054) delivers provisioning-on-grant; UserHistory (ADR-0050) extended history to users; per-concern settings stores exist (ADR-0063/0079). The lists below are retained for context; the live roadmap is now CEO-driven per session.

### Near term (next 1-3 epics)

- ~~**Auth**: end the shim.~~ **DONE** (ADR-0043, live 2026-06-01).
- **Frontend completion / design**: the **«Ledger» refactor** (ADR-0077, oxblood) is the current large frontend arc.
- **Operational polish**: error UX, search UX, history UX, i18n (en/es shipped, ADR-0051).

### Medium term (next 3-6 epics, contingent on validation)

- **Access requests / provisioning workflow**: partly delivered as the **Applications Workflow Engine** (ADR-0054/0057) — provisioning fires after a grant commits.
- **History extension**: **UserHistory** shipped (ADR-0050); consumables/apps history still asset-only.
- ~~**Settings backend**~~: **partially delivered** as purpose-built stores (`AssetTagScheme` ADR-0063, `SmtpSettings` ADR-0079) — no single general store yet.
- **Webhooks / outbound integration**: still open; **instance SMTP + email** (ADR-0079, *proposed*) is the first outbound channel.

### Longer term (beyond MVP)

- **SaaS multi-tenant offering** (if validation shows demand)
- **Mobile app** or **PWA** for on-the-floor use (technicians moving through a building)
- **Integrations**: AD/LDAP sync, MDM tools, monitoring tools
- **Reporting and analytics**: dashboards beyond the operational view

---

## Decisions that are NOT on the horizon

The CTO must also know what we are **not** going to do, so that suggestions in those directions are quickly rejected.

- **Rewriting in a different language**. The stack is TypeScript-first and stays so.
- **Splitting into microservices**. Monolith with modules.
- **Building our own IdP**. We integrate; we don't compete with Zitadel/Keycloak.
- **Adding paid tiers in self-hosted mode**. If a feature ships, it ships for everyone.
- **Closed-source components**. The project is open-source by default; closed-source extensions, if they ever exist, are out-of-tree.

---

## Anti-goals

A product is defined as much by what it refuses to do as by what it does.

- **No surveillance of employees.** We track assets and accesses for IT operations; we do not log user behavior for HR oversight.
- **No vendor lock-in for the customer.** Everything they put in, they can export.
- **No "growth hacks" in the product.** No misleading nudges, no dark patterns, no notification spam.
- **No mandatory cloud connection.** The product must be fully functional disconnected from the internet (with the exception of the IdP if the customer bundles ours; even then, no inbound call to our infrastructure).

---

## How to use this document

The CTO consults this file when:

- A subagent proposes a feature whose scope is ambiguous → check the three pillars and the anti-goals
- A stack deviation is proposed → check the stack philosophy
- A new component is suggested for the Docker stack → check the operator profile
- A schema change risks the asset-centric stance → check the domain philosophy
- The CEO asks "should we do X" → ground the answer in this document, then escalate options if real trade-offs exist

This document is **not** a marketing brief. It is the engineering interpretation of the product. Keep it accurate to what the codebase reflects, not to aspirational positioning.

When this document and the codebase disagree, the CTO surfaces the contradiction to the CEO. Either the document needs updating, or the codebase has drifted from the intended direction.