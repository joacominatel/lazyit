---
title: "ADR-0088: License / seat tracking on Application (seats + cost + renewal; seatsUsed derived)"
tags: [adr, application, access, license, money]
status: accepted
created: 2026-07-18
updated: 2026-07-18
deciders: [Joaquín Minatel]
---

# ADR-0088: License / seat tracking on Application (seats + cost + renewal; seatsUsed derived)

## Status

**accepted** — 2026-07-18. Issue #949 (CEO-greenlit: "license must tie to Applications"). Built
same-day: three nullable columns on `applications`, threaded through the shared contract, the service
(a derived `seatsUsed`), and the web list / detail / form. A broader "contracts" concept is deferred.

## Context

Operators want to know, per application, **how many license seats they pay for, what each costs, when
the license renews, and how many seats are actually in use** — the license-management side of the
Access pillar. The CEO decided this must live **on the Application**, not a separate licensing entity
([[MEMORY]] — "#949 license must tie to Applications").

Two facts shape the design:

- **Money is already solved.** Asset purchase cost (#954, [[0036-int4-bounded-integers]]) stores money
  in **integer minor units** (cents) of the org's single currency — no float drift, bounded to `int4`. License
  cost must reuse that exact representation, not invent a second money convention.
- **Grants are deliberately multi-grant.** An [[access-grant]] has **no** uniqueness constraint: a
  user may hold several active grants on one application at different `accessLevel`s
  ([[0023-access-management-design]]). So a raw `COUNT(*)` of active grants **over-reports** the
  license — three grants for one person is still **one** seat consumed.

## Decision

**Track license seats, cost and renewal as three optional columns ON `Application`. Compute seats-in-use
as a DERIVED, distinct-user count — never a stored column.**

- **New nullable columns** (additive migration, all `null` = "untracked"):
  - `seatsPurchased Int?` — paid seats (`null` = unlimited / not tracked).
  - `costPerSeat Int?` — price **per seat** in **integer minor units** (cents), mirroring
    `Asset.purchaseCost` (#954). No float; bounded to `int4` via the shared `int4({ min: 0 })` primitive.
  - `renewalDate DateTime?` — when the license next renews. Informational for now.
- **`seatsUsed` is DERIVED, never stored:** `COUNT(DISTINCT userId)` over `AccessGrant WHERE revokedAt
  IS NULL` for the application. DISTINCT user is the correct license math (multi-grant would otherwise
  over-count). Computed per-request in `ApplicationsService` for both `findOne` and `findPage` via a
  **single** `accessGrant.findMany({ distinct: ['applicationId','userId'], select: {applicationId,
  userId} })` over the whole page, folded in memory — no per-row N+1. It is **read-only**: the
  create/update zod schemas are `strictObject`s that do **not** list `seatsUsed`, so a request body
  carrying it is rejected (400).
- **Over-allocation is a client-derived warning, not a hard rule.** When `seatsPurchased != null &&
  seatsUsed > seatsPurchased`, the web flags it (list + detail). lazyit never blocks a grant on seat
  count — the number is advisory, and the estate is small.
- **Web surfaces:** the Access list shows a `used / purchased` cell (+ over-alloc warning + next
  renewal); the application detail adds a "License & seats" panel (`used / purchased` + warning, cost
  per seat, renewal date); the form adds the three inputs — cost entered in **major** units and
  converted to minor via the existing `majorToMinor` (#954), never re-coerced server-side.

## Consequences

- **Zero blast radius on authz/audit:** one additive nullable migration, no permission added, no read
  re-scoped. License fields ride the application's soft-delete; no new entity, table or CRUD.
- **`seatsUsed` costs one extra indexed query** per application read (`access_grants(applicationId)`
  index; distinct on `(applicationId, userId)`). `findPage` pays it **once** for the whole page.
- **No currency symbol** (single-org, out of scope, same as asset cost) — `formatMoney` emits a bare
  locale-aware number.
- **Renewal is data-only here.** Wiring the proactive-expiry sweeper (#1070) to nudge on an upcoming
  `renewalDate` is a deliberate follow-up, out of scope for this change.

## Rejected alternatives

- **A separate `License` / `Contract` entity** — rejected for now (CEO: tie it to the Application). A
  richer "contracts" concept (multiple licenses per app, per-seat tiers, PO numbers, vendor SKUs) is a
  future entity if the need appears; the three columns cover the stated ask with the least surface.
- **Storing `seatsUsed`** — rejected: it would drift on every grant/revoke and duplicate the grant
  ledger. Deriving it keeps a single source of truth ([[asset-centric]] / auditability posture).
- **A raw active-grant count as "seats used"** — rejected: multi-grant over-reports the license
  ([[0023-access-management-design]]); DISTINCT user is the only correct count.

## Related

[[application]] · [[access-grant]] · [[0023-access-management-design]] ·
[[0036-int4-bounded-integers]] · [[0006-soft-delete-and-auditing]] · #949 · #954 · #1070
