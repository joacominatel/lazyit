---
title: "ADR-0089: Bulk receiving + check-out acknowledgement"
tags: [adr, assets, receiving, asset-assignment, notifications, data-model]
status: proposed
created: 2026-07-18
updated: 2026-07-18
deciders: [Joaquín Minatel]
---

# ADR-0089: Bulk receiving + check-out acknowledgement

## Status

**proposed** — 2026-07-18 (issue #1029). Two related receiving/hand-off ergonomics the migration
persona ranked as the top inventory gap: **(A)** minting N assets from one [[asset-model]] in a single
action ("we just received 20 identical ThinkPads"), and **(B)** recording that the person a device was
**checked out to** actually **acknowledged** they hold it. This ADR is **design-only** — it writes no
application code. Part A is lower-risk and ship-first (it reuses the existing single-asset create path
verbatim, no schema change). Part B is additive metadata on [[asset-assignment]] but needs the
**CEO sign-off** below **plus a migration**, so it is sequenced second.

> **Scope.** Part A: a new `POST /assets/batch/receive` that loops the EXISTING `AssetsService.create()`
> N times (each its own transaction + independent tag-counter commit), returning a partial-success
> envelope. Part B: an additive `acknowledgedAt` (+ optional actor/note) on `AssetAssignment`, a
> set-once self-service transition, and — pending sign-off — a new `AssetHistory` `ACKNOWLEDGED` event
> and a new **targeted** `NotificationType`. NOT a purchase-order / receiving-document entity, NOT a
> goods-receipt ledger, NOT a signature/e-sign capture, NOT per-asset check-out *agreements* (a device
> policy the user signs). Those remain non-goals ([[vision]]: no ticketing/procurement).

## Context

### Part A — bulk receiving

Receiving identical hardware one row at a time is the persona's loudest complaint. The naïve
implementation — one big `$transaction` that inserts N `Asset` rows — is **wrong here**, and the reason
is load-bearing:

- The **`AssetTagScheme` running counter increments in its OWN commit, deliberately OUTSIDE the
  asset-create `$transaction`** (`schema.prisma` ~L584-593 model doc; `asset-tag-scheme.service.ts`
  ~L238-243 `allocateTag`). That independent commit is what makes the ADR-0063 invariant hold: **gaps
  are accepted** and a tag collision **advances** the counter rather than spinning. Folding the
  increment into the create tx would let a rolled-back insert un-consume the number, so a retry
  re-renders the same colliding tag forever.
- Therefore a bulk receive that wrapped N inserts in one transaction would either (a) share one
  counter allocation across the batch (broken) or (b) fight the independent-commit design. The
  **import module already proves the correct pattern**: `import-commit.service.ts` (~L695) calls
  `this.assets.create(parsed.data, principal, …)` **once per row** — each row is its own transaction
  with its own independent counter commit, and a bad row FAILs alone without poisoning its neighbours
  (ADR-0069 §7 "a doomed row never burns a counter number" — it re-validates BEFORE `create()`).

**Consequence, stated plainly and accepted:** bulk receive is a **loop over `AssetsService.create()`**,
so **partial success is the CORRECT outcome**. If row 7 of 20 fails a spec-validation, the response is
**18 created + 2 failed with reasons**, and the tag counter has advanced past the gaps. This is not a
degraded mode — it is the same "gaps accepted / collision advances" invariant surfaced at batch scale.
Reusing `create()` also means every minted unit gets the full single-asset write path for free: model
spec-defaults ([[0078-asset-category-specs-dictionary]]), the `CREATED` `AssetHistory` event with actor
attribution (ADR-0033), search upsert, and money coercion to minor units (#954).

### Part B — check-out acknowledgement

An `AssetAssignment` is the timestamped ownership join ([[0019-asset-assignment-integrity]]) — asset X
is checked out to person Y from `assignedAt` until `releasedAt`. Today nothing records that Y **agreed**
they received it; an operator has assigned-on-paper but no accountability signal.

The key correctness question is whether adding an acknowledgement **violates append-only / auditability**
([[0006-soft-delete-and-auditing]]). **It does not**, and the framing matters: `AssetAssignment` is
**already a mutable lifecycle row** — `release()` sets `releasedAt`, `updateNotes` rewrites `notes`, and
the model carries `updatedAt` (`schema.prisma` L789+; "No deletedAt: this is a lifecycle join, not a
soft-deletable entity"). It is explicitly NOT an append-only ledger. Adding `acknowledgedAt DateTime?`
(+ an optional `acknowledgedById` actor and `acknowledgeNote`) is **additive lifecycle metadata**, the
same class of field as `releasedAt` — not an edit to an immutable record. The immutable audit trail of
the acknowledgement lives where audit trails belong: a new **append-only** `AssetHistory` event.

The forces on Part B:

- **Accountability means the actor is the assignee.** An acknowledgement that any admin can stamp on
  anyone's behalf is a weaker signal than "the person holding the device confirmed it themselves". The
  lazy-correct default is **self-service, scoped to the caller's OWN active assignment**.
- **Set-once, race-safe.** Acknowledgement is a one-way PENDING→ACKNOWLEDGED transition. It must use the
  same conditional-write backstop `release()` uses — `updateMany({ where: { id, acknowledgedAt: null }})`
  — so a double-click / concurrent call flips the row at most once and emits exactly one history event.
- **A new notification type is a catalog-as-code tax.** A targeted per-user nudge already has a
  precedent: the targeted-notification mechanism (`recipientUserId`, ADR-0056 amendment) shipped as
  `secret.vault_setup`, and #1071 added the **targeted decision nudge** `access_request.decided`
  (shared enum + api emitter + web `TYPE_META` + email-preference label, en+es + Manual). **Any new
  `NotificationType` MUST be mirrored in the web `notification-bell.tsx` `TYPE_META` exhaustive map or
  the bell fails to typecheck/render** — this is the standing gotcha, not optional polish.

## Considered options

### Part A

**A1 — one big transaction vs. loop the existing create (the counter constraint):**
- Single `$transaction` inserting N assets — ❌ collides head-on with the independent tag-counter commit
  (ADR-0063); either shares one number across the batch or fights the design. All-or-nothing rollback
  also throws away 19 good assets because the 20th had a bad serial.
- **Loop `AssetsService.create()` N times (chosen)** — each unit is its own tx + its own independent
  counter commit, exactly as `import-commit.service.ts` (~L695) does per row. Partial success is the
  correct, invariant-preserving outcome. Zero new write path; zero schema change.

**A2 — response shape on partial failure:**
- Fail the whole request on the first bad unit — ❌ hostile and wasteful (gaps already consumed).
- **Return `{ created: Asset[], failed: { index, error }[] }` (chosen)** — the caller sees the 18 that
  landed and precisely which indices failed and why (mirrors the import row-level FAILED reporting).
  HTTP `201` when ≥1 created; the `failed` array is the honest partial signal.

**A3 — serials:**
- Require serials always — ❌ most bulk receipts are anonymous identical units.
- **Optional `serials?: string[]`, empty OR `length === quantity` (chosen)** — validated in the shared
  schema. When present, `serials[i]` is applied to unit `i`; when absent, units are serial-less. A
  length mismatch is a 400 up front (never a partial write).

**A4 — the minted unit's required `name`:**
- Force the caller to supply N names — ❌ defeats the point of bulk.
- **Default `"<ModelName> #<seq>"` (chosen)** — `Asset.name` is required; `<seq>` is the 1-based index
  within the batch (a friendly label, NOT the asset tag — the tag comes from the scheme). A caller who
  wants better names renames later or imports via the migrator.

### Part B

**B1 — who records the ack (the primary decision):**
- Admin-on-behalf only — ❌ weakest accountability; "someone said Y has it" ≠ "Y confirmed it".
- Both self-service AND admin-on-behalf — a fuller model, but doubles the surface (a second route, an
  actor-source discriminator) for a v1 that mainly needs the self-service signal.
- **Self-service scoped to the caller's own active assignment (chosen/recommended)** — a NEW non-admin
  mutation (`POST /asset-assignments/:id/acknowledge`) that the service scopes to `where: { id, userId:
  caller, releasedAt: null, acknowledgedAt: null }`. No new coarse permission — the authorization is
  "it's your own active assignment", the self-scope carve-out pattern (mirrors `/access-requests/mine`,
  ADR-0085 §4). Admin-on-behalf can be an additive follow-up if a real need appears (YAGNI).

**B2 — must `acknowledgedById === assignee`:**
- Allow any actor in the column — ❌ then the field means "someone stamped it", not accountability.
- **`acknowledgedById` MUST equal `AssetAssignment.userId` (chosen/recommended)** — enforced by the
  self-scoped `where`; the column is redundant-but-explicit provenance (like `releasedById`). If B1 ever
  admits admin-on-behalf, this loosens to "actor may differ" and the distinction becomes meaningful.

**B3 — emit new audit + notification, or field-only:**
- Field-only (no history event, no nudge) — ❌ the acknowledgement is exactly the kind of discrete state
  change `AssetHistory` exists to record; and the operator who assigned the device is the audience that
  wants to know it was confirmed.
- **New `AssetHistory.ACKNOWLEDGED` event + a new targeted `NotificationType` (chosen/recommended)** —
  the event is an enum-value migration on `AssetHistoryEventType` (append-only, ADR-0033), payload
  `{ userId }` (mirrors ASSIGNED/RELEASED). The notification is a new **targeted** type delivered to the
  operator/assigner (`recipientUserId`), **email opt-out-able**, wired end-to-end exactly like #1071:
  shared `NOTIFICATION_TYPES` + doc comment, api emitter, **web `TYPE_META` entry** (mandatory or the
  bell breaks), email-preference label (en+es), Manual. `targetUserId` = the assignee the ack is about.

**B4 — ack only while active, or also after release:**
- Allow acknowledging a released assignment — ❌ acknowledging a device you no longer hold is
  meaningless and muddies the timeline.
- **Only while active (`releasedAt IS NULL`) (chosen/recommended)** — the self-scoped `where` already
  includes `releasedAt: null`; a released or already-acknowledged assignment returns 409 (the
  set-once + still-active backstop, mirroring `release()`'s conditional write).

## Decision (recommended shape — pending the sign-off below)

### Part A — bulk receiving (ship-first, no migration)

- **Shared contract** (`@lazyit/shared`): a new `ReceiveAssetsSchema` — `{ modelId, quantity (int
  1..CAP), status, locationId?, company?, purchaseDate?, purchaseCost?, notes?, serials?: string[] }`
  with the `serials` refinement (empty OR `length === quantity`). `purchaseCost` flows through the
  **existing #954 minor-unit coercion — never re-coerced here**. A `ReceiveAssetsResultSchema`
  = `{ created: AssetSchema[], failed: z.array({ index, error }) }` (any NEW read field on the wire is
  `.nullish()` per the shared-package rule).
- **Endpoint**: `POST /assets/batch/receive`, `@RequirePermission('asset:write')` (creating assets is
  already this verb — no new permission), the same guard posture as single create. Loops
  `AssetsService.create(unitPayload, principal)` `quantity` times; each unit derives its payload from
  the shared batch fields + `name: "<ModelName> #<seq>"` + `serials[i]` when present; per-unit failures
  are caught and pushed to `failed` (never abort the batch). `CAP` (recommend **200**) bounds the loop.
- **No schema change.** Reuses the create path verbatim (model spec-defaults, `CREATED` history, search
  upsert, money coercion). Partial success is the documented, correct outcome.

### Part B — check-out acknowledgement (needs the sign-off + a migration)

- **Migration (additive)**: on `AssetAssignment`, `acknowledgedAt DateTime?`, `acknowledgedById String?
  @db.Uuid` (FK `User`, `onDelete: SetNull` — losing the actor never blocks their deletion, the row
  survives), `acknowledgeNote String?`. Plus the `ACKNOWLEDGED` value on `AssetHistoryEventType`.
  Additive metadata on an already-mutable lifecycle row — NOT an append-only violation.
- **Shared + notification**: an `AcknowledgeAssignmentSchema` (optional `note`); a new targeted
  `NotificationType` added to `NOTIFICATION_TYPES` with its doc comment, and its **web `TYPE_META`**
  entry + email-preference label (en+es) + Manual — the full catalog-as-code tax, #1071 as the template.
- **Endpoint**: `POST /asset-assignments/:id/acknowledge`, any authenticated human, **self-scoped** to
  the caller's own active assignment. The transition is the set-once conditional write
  `updateMany({ where: { id, userId: caller, releasedAt: null, acknowledgedAt: null }, data: {
  acknowledgedAt: now, acknowledgedById: caller, acknowledgeNote } })`; `count === 0` → 409 (already
  acknowledged / released / not yours). On success, in the same transaction, record the `ACKNOWLEDGED`
  `AssetHistory` event, then POST-COMMIT emit the targeted nudge to the assigner.

## Decisions needed from CEO

Part A is a clean technical decision (the counter constraint forces the loop shape) and needs no product
call beyond the cap. **Part B needs sign-off before any code**, because it touches the assignment model,
adds a notification type, and defines an accountability semantic:

1. **Who may record the acknowledgement?** (self-service / admin-on-behalf / both)
   — **Recommended: self-service only, scoped to the caller's own active assignment.** Laziest correct
   accountability; admin-on-behalf is an additive follow-up if a real need appears.
2. **Must `acknowledgedById` equal the assignee?**
   — **Recommended: yes.** Enforced by the self-scoped `where`; "the holder confirmed it" is the whole
   point. (Loosens automatically if decision #1 ever admits admin-on-behalf.)
3. **Emit a new `AssetHistory.ACKNOWLEDGED` event AND a new targeted `NotificationType`, or field-only?**
   — **Recommended: yes to both** — append-only audit event + a targeted, email-opt-out nudge to the
   assigner, wired api → web `TYPE_META` → email-pref label (en+es) exactly like #1071. **Cost:** an
   enum migration + the mandatory web `TYPE_META` mirror (omitting it breaks the bell).
4. **Is acknowledgement allowed only while active, or also after release?**
   — **Recommended: only while active (`releasedAt IS NULL`).** Acknowledging a device you no longer
   hold is meaningless; the self-scoped `where` already enforces it, 409 otherwise.

## Consequences

- **Positive:** Part A ships the persona's top inventory gap with **zero schema change and zero new write
  path** — it is a thin controller over the proven per-row create loop, and its partial-success behaviour
  is the ADR-0063 "gaps accepted" invariant honestly surfaced at batch scale. Part B adds a real
  accountability signal as **additive lifecycle metadata** (correctly framed as NOT breaking append-only),
  set-once and race-safe by the same `updateMany`-conditional backstop `release()` uses, with the audit
  trail in append-only `AssetHistory` and the nudge on the existing targeted-notification rails.
- **Negative / trade-offs (accepted):**
  - Part A can return a partial batch (18/20) with consumed tag gaps — **by design**, not a bug; the UI
    must present `failed[]` clearly (per-index reason), and the operator retries only the failures.
  - Part B is a migration + a new `NotificationType` — the standard catalog-as-code cost: the shared
    enum + api emitter + **web `TYPE_META` exhaustive-map entry** (mandatory) + email-pref label (en+es)
    + Manual, plus the `AssetHistoryEventType` enum migration and its history-write spec.
  - Self-service-only ack (recommended) means an operator can't record an ack on a colleague's behalf in
    v1 — acceptable; admin-on-behalf is a clean additive follow-up.
- **Follow-ups:** the receiving UI (a quantity + model "Receive stock" action surfacing `failed[]`); the
  assignment-detail "Acknowledge receipt" self-service action + an admin "awaiting acknowledgement"
  indicator; the **public Manual** pages (bulk receiving under Inventory; the acknowledgement flow under
  Assets/assignments, en+es) — user-facing, so updated **in the code change that ships each part**, not
  here (this ADR is design-only); optionally admin-on-behalf ack if decision #1 is revisited.

Related: #1029 · [[0019-asset-assignment-integrity]] · [[0063-configurable-asset-tag-scheme]] ·
[[0069-migrator-import]] · [[0033-asset-history-event-model]] · [[0006-soft-delete-and-auditing]] ·
[[0056-in-app-notification-bell]] · [[0085-access-request-flow]] · [[0078-asset-category-specs-dictionary]] ·
[[asset]] · [[asset-model]] · [[asset-assignment]] · [[asset-history]] · [[prisma-migrations]]
