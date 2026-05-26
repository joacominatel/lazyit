# Decision History

> This document is a **CTO-friendly index of major decisions** taken across the project — ADRs and broader strategic calls. It exists to let the CTO quickly check "is this already decided?" without reading thirty ADR files.
>
> **Owner**: CTO. Updated when a new ADR is accepted, or when a non-ADR strategic decision lands in a session.
>
> **Not redundant with `docs/03-decisions/_MOC.md`**: that is the formal MOC of ADRs. This file is the **CTO's working summary**, with operational notes ("how this affects dispatch") layered on top.

---

## How to use this file

When designing a plan or considering an escalation, the CTO scans this file for:
- Decisions that constrain the task (must follow X)
- Decisions that have been superseded (don't follow Y; we changed our mind)
- Decisions deferred (don't try to settle Z; it's parked deliberately)

For full reasoning, the CTO opens the linked ADR.

---

## Index of major decisions

> Format per entry:
>
> **ADR-NNNN** — *Decision title*
> **Status**: accepted / superseded / deferred
> **One-liner**: what was decided
> **CTO note**: operational implication for dispatch and coordination

This file is populated by the CTO during its first investigation session, working from `docs/03-decisions/` and `docs/03-decisions/_MOC.md`. The format below is a template; the CTO fills it in.

---

### Architecture

> Pending population during investigation.
>
> Expected entries include (subject to CTO verification):
> - ADR-0001 (initial stack)
> - ADR-0002 (monorepo with Bun + Turborepo)
> - ADR-0009 (runtime: Bun tooling, Node runtime)
> - ADR-0014 (shared package: CJS + d.ts)
> - ADR-0020 (frontend data layer pattern)
> - ADR-0025 to ADR-0028 (containerization, reverse proxy, CI, secrets)

---

### Domain

> Pending population.
>
> Expected entries include:
> - ADR-0004 (asset-centric design)
> - ADR-0005 (ID strategy: cuid for entities, uuid for User)
> - ADR-0006 (soft delete strategy)
> - ADR-0007 (specs in jsonb)
> - ADR-0012 (testing strategy: core thorough, no coverage gate)

---

### Identity & access

> Pending population.
>
> Expected entries:
> - ADR-0016 (auth strategy deferred to IdP)
> - ADR-0022 (X-User-Id shim, temporary)
> - ADR-0024 (ActorService extraction)

---

### Cross-cutting concerns

> Pending population.
>
> Expected entries:
> - ADR-0031 (logging strategy with Pino)
> - ADR-0032 (soft-delete middleware)
> - ADR-0033 (AssetHistory event model)
> - ADR-0034 (consumables model)
> - ADR-0035 (search architecture)

---

### Security policy

> Pending population.
>
> Expected entries:
> - ADR-0029 (sanitize-on-render policy for markdown)
> - ADR-0030 (pagination contract, deferred implementation)

---

### Workflow & coordination

> Pending population.
>
> Expected entries:
> - Git workflow runbook formalization
> - Concurrency tiers (this skill's contribution)

---

## Decisions made outside ADRs

> Some strategic decisions are taken in CEO/CTO conversations without rising to an ADR. The CTO records them here so they're not lost.
>
> Format: date — decision — context — implication.

Pending population.

Examples to be captured:
- Choice of Zitadel as bundled IdP (when finalized)
- Choice to defer Settings backend
- Choice of strict-serial as default concurrency
- Choice not to use Paperclip or external orchestrators

---

## Superseded decisions

> When an ADR is superseded, list both the original and the superseder. The CTO must know which ADRs no longer apply.

Pending population.

Examples (subject to verification):
- ADR-0022 (X-User-Id shim) — will be superseded by the auth implementation ADR
- ADR-0024 (ActorService extraction) — may be partially superseded when @CurrentUser() arrives

---

## Open questions (not yet decided)

> Surfaces decisions the CTO knows are coming but haven't been made. The CTO escalates these proactively when their absence blocks dispatch.

Pending population.

Examples:
- IdP database: shared Postgres vs dedicated
- Job queue: introduce or defer
- Pagination implementation: when does the deferral become pain
- Settings backend: when does it become necessary

---

## Update protocol

The CTO updates this file when:
- A new ADR is accepted → add entry under the right category
- An ADR is superseded → move to the superseded section, link both
- A non-ADR strategic decision is taken in a CEO/CTO conversation → add to "Decisions made outside ADRs"
- An open question is resolved → move from "open" to its category

Updates are append-and-revise. Never delete decisions; mark them superseded.

The decision history is the institutional memory of strategic choices. Stale or missing entries here cause the CTO (or future CTOs) to re-litigate decisions that were already settled.