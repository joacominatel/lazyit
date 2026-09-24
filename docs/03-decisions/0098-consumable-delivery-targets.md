---
title: "ADR-0098: Consumable deliveries — an optional target on an OUT movement, returnable items and returns"
tags: [adr, consumables, data-model, audit]
status: accepted
created: 2026-09-24
updated: 2026-09-24
deciders: [Joaquín Minatel]
---

# ADR-0098: Consumable deliveries — an optional target on an OUT movement, returnable items and returns

## Status

**accepted**. The CEO settled the product decisions on 2026-09-24 (issue #1364). This ADR **extends**
[[0034-consumables-design]]: the cached stock and the append-only ledger stay exactly as they are. It adds
a destination to a movement and a way to give units back. It does **not** reopen
[[0008-consumables-vs-assets]]: a consumable is still a counted quantity, never a tracked individual.

## Context

Today an `OUT` movement records that units left the shelf but not where they went. Operators asked for
three things:

- **Who got it.** "Two HDMI adapters to Ana", "a toner fitted to the 3rd-floor printer", "a fire
  extinguisher left on floor 2". They want to answer that from the person, the asset or the place.
- **Loaners.** Some supplies come back: a loaner headset, a projector remote, a spare laptop charger.
  The team needs to see what is still out, and with whom, before someone leaves.
- **Offboarding.** The offboarding sheet and the Return Act should list what the leaver received,
  so the team can ask for it back.

Constraints from the existing design: movements are append-only and are the only thing that moves
stock ([[0034-consumables-design]]). History is never hard-deleted ([[0006-soft-delete-and-auditing]]).
Every actor column is human XOR service account ([[0048-service-accounts]]). Offboarding is a soft
delete that must not rewrite the past. Live instances upgrade in place over populated tables.

## Considered options

**(1) Where a delivery lives.**

- **A. An optional target on the `OUT` movement (chosen).** A delivery is the stock-leaving event
  itself, so the ledger row carries its destination. There is one source of truth, the stock math is
  unchanged, and the history comes for free.
- **B. A `ConsumableAssignment` join, like [[asset-assignment]].** Rejected. An assignment models
  ownership of an *individual* over time, and consumables are counted, not individual
  ([[0008-consumables-vs-assets]]). A join would need its own quantity column, which then duplicates the
  ledger. It would also blur the rule of thumb that separates assets from consumables.
- **C. Per-location stock (a quantity per place).** Rejected. That is multi-warehouse inventory, and
  it would change `currentStock` from one number into a matrix. A location target means only "the units
  were left there". It is a destination, not a second shelf.

**(2) The returnable flag: live or snapshot.**

- **A. A snapshot on the delivery (chosen).** `Consumable.returnable` is copied onto each targeted
  `OUT` when it is written, so toggling the flag later never changes whether an old delivery is "owed
  back".
- **B. Read the consumable's current flag.** Rejected, because one PATCH would silently rewrite the
  meaning of every past delivery.

**(3) How a return is recorded.**

- **A. An `IN` linked to the delivery via `returnOfId` (chosen).** The stock goes back through the
  normal `IN` path. Outstanding is `delivery.quantity − SUM(returns)`, and partial returns are natural.
- **B. Mutating the delivery (a `returnedAt` or `returnedQuantity` column).** Rejected. The ledger is
  append-only.

**(4) One target or several.** Exactly **one** optional target: a user, an asset or a location. It is
enforced in the shared schema, in the service and by a DB CHECK. Several targets on one row would make
"where did it go" ambiguous. A split delivery is two movements.

## Decision

1. **Data model** (migration `20260924000000_consumable_deliveries`, additive only):
   - `Consumable.returnable Boolean @default(false)`.
   - `ConsumableMovement.targetUserId uuid?` → [[user]], `targetAssetId?` → [[asset]],
     `targetLocationId?` → [[location]], all `onDelete: Restrict` and named relations
     (`ConsumableDeliveryTargetUser` / `…Asset` / `…Location`). Restrict matches [[0019-asset-assignment-integrity]]:
     a delivery is history-bearing, so a hard delete of the recipient is refused. Soft deletes are
     UPDATEs, so offboarding, retiring and archiving are unaffected.
   - `ConsumableMovement.returnable Boolean @default(false)`, the snapshot.
   - `ConsumableMovement.returnOfId Int?`, a self-FK to the delivery, `onDelete: Restrict`.
   - Indexes on the three targets and on `returnOfId`.
   - Four raw-SQL **CHECKs** (runbook [[prisma-migrations]] §3):
     - at most one target (`num_nonnulls(...) <= 1`);
     - targets only on `OUT`;
     - `returnOfId` only on `IN`;
     - `returnable` only on a targeted `OUT`.
2. **Write path** (`POST /consumables/:id/movements`, same endpoint, same permission
   `consumable:write`):
   - **Delivery:** an `OUT` with one target.
     - The target must be a **live** row. A missing or soft-deleted user, asset or location → **400**
       (the [[asset-assignment]] live-row guard).
     - The guarded decrement runs first. The consumable's `returnable` is then read inside the same
       transaction, while this transaction already holds the row lock, and stamped onto the movement.
   - **Return:** an `IN` with `returnOfId`.
     - The delivery row is locked first with `SELECT … FOR UPDATE` on `consumable_movements`, so two
       concurrent returns of the same delivery serialize. The second one sums a return set that already
       includes the first, so it can never over-return.
     - **400** when the delivery is missing, belongs to another consumable (one message for both), is
       not a targeted `OUT`, or was not returnable when made. These are shape errors that can never
       succeed.
     - **409** when the quantity exceeds what is outstanding. This is a state error.
     - Then the normal `IN` path runs, including the int4 ceiling (409).
   - A return of an offboarded user's delivery is allowed, because that is the offboarding use case. A
     *new* delivery to them is not.
   - The quick −1/+1 sends no target and behaves exactly as before. The low-stock nudge and the search
     re-index are unchanged.
3. **Asset timeline.** A delivery to an asset appends `CONSUMABLE_DELIVERED` to its [[asset-history]].
   A return of an asset delivery appends `CONSUMABLE_RETURNED`.
   - Both are written in the **same transaction** as the movement, through `AssetHistoryService.record`,
     so the actor is the principal (human XOR service account) and `aiInvocationId` is stamped when an
     AI tool made the call.
   - Payload: `{ consumableId, consumableName, movementId, quantity, unit }`, plus `returnOfId` on a
     return.
   - User and location targets write no history event. Their record is the deliveries read.
4. **Read path.**
   - `GET /consumables/:id/movements` rows carry the raw target columns, `returnable`, `returnOfId`
     and a resolved **`target` descriptor**:
     - `{type:"user", id, displayName, isOffboarded}`
     - `{type:"asset", id, label, isDeleted}`, where `label` = assetTag ?? name ?? serial
     - `{type:"location", id, name, isDeleted}`
     - `null` for an untargeted movement.

     Targets are resolved through the `includeSoftDeleted` escape hatch
     ([[0032-soft-delete-middleware]]), so a gone target is flagged, never dangling.
   - `GET /consumables/deliveries?targetUserId=|targetAssetId=|targetLocationId=` requires exactly one
     target and accepts `outstandingOnly`, `from`, `to` and the [[0030-list-pagination-contract]] window.
     - Newest first.
     - Each item carries the consumable (`{id,name,sku,unit,deletedAt}`), `returnedQuantity` and
       `outstandingQuantity` (always 0 for a non-returnable delivery).
     - Deliveries of a **soft-deleted consumable stay listed**, flagged by its `deletedAt`, so history
       never vanishes.
     - A soft-deleted *target* is never a 404, because this is the read the offboarding sheet uses
       after the fact.
     - `outstandingOnly` is filtered in SQL (a correlated `SUM`), so the page and its `total` stay
       authoritative.
5. **Authorization.** This mirrors [[0046-roles-permissions-v2]] P3.
   - The deliveries route is gated on `consumable:read`. The service **also** requires the target
     domain's read permission: `user:read` to list a person's deliveries, `asset:read`, and
     `location:read`. Otherwise it returns **403**. A VIEWER lacks `user:read`, so it cannot enumerate
     what a named person received, the same rule as `GET /users/:id/assignments`.
   - In both reads, a target whose domain the caller cannot read keeps its id, but its display fields
     and lifecycle flag are **`null`** (redacted, and not even queried).
   - Service accounts resolve from their direct grants. No principal holds nothing, so the check fails
     closed.
6. **Offboarding shows, never moves.** `UsersService.remove()` is unchanged. Offboarding moves no stock
   and closes no delivery. The web lists the leaver's deliveries (outstanding first) through the
   deliveries read, in the offboarding sheet and the Return Act, and the team records returns as they
   happen.

## Consequences

- **Positive:**
  - "Where did it go" is answered from the ledger itself, with no second source of truth.
  - Loaners are tracked without turning consumables into assets.
  - The asset timeline shows what was fitted to or left in a machine.
  - Every rule is enforced three times: the shared schema, the service and a DB CHECK.
- **Cost, the Restrict FKs:** a user, asset or location that ever received a delivery can no longer be
  **hard**-deleted. That is intended (history), and every normal path is a soft delete. Two hard-delete
  paths remain: the compensation rollbacks in `UsersService` and the first-run setup. Both delete a row
  created moments earlier in the same request, which cannot have deliveries.
- **Cost, the extra query per read:** each ledger or deliveries read with targets adds one permission
  resolution (cached per role) and at most one lookup per target kind. There is no N+1.
- **Cost, redaction:** a VIEWER sees that a unit went "to a user" but not to whom. This is deliberate,
  and consistent with how the rest of the app hides names from a caller without `user:read`.
- **Returns cannot be undone by editing.** A mistaken return is corrected with another movement (an
  `OUT`), like any ledger correction. A mistaken return cannot be "un-returned" onto the same delivery.
- **Location ≠ stock.** A location target is informational. "How many are on floor 2" is not a supported
  question, and supporting it would need a different decision.

## Upgrade path over existing data

The migration is purely additive and applies with `prisma migrate deploy` over a populated database.

- **Existing consumables** read `returnable = false`, so nothing becomes outstanding retroactively.
- **Existing movements** read no target, `returnable = false` and `returnOfId = NULL`, which is exactly
  their current meaning.
  - All four CHECKs hold for such rows, so adding them validates the populated table without a failure.
  - **Nothing is backfilled.** There is no way to infer a past destination, and guessing would forge
    history.
- **Stock** (`currentStock`) is untouched.
- **The two new enum values** are appended with `ADD VALUE` (O(1), the `ACKNOWLEDGED` / `AGENT_LINKED`
  precedent). Older rows are unaffected.
  - The `recent_activity` view lowercases asset events generically, so `consumable_delivered` and
    `consumable_returned` join `RECENT_ACTIVITY_ACTIONS`. A verb missing from that list would be
    rejected as an `action` filter.
- **Read schemas** add every new field as `.nullish()`, so a client built against the older shape keeps
  working. The write schema only adds optional keys, so the existing payloads, including the quick
  −1/+1, are unchanged.

## Follow-ups (deferred)

- **The AI consumables tools.** `consumable_record_movement`, `consumable_update` and `consumable_get`
  keep their current surface. `returnable` is filtered out of `consumable_update`, and
  `GET /consumables/deliveries` is registered as **unexposed**. Extending the AI tools with delivery
  targets, returns and the deliveries list is a separate change.
- **The recent-activity summary.** The `recent_activity` view still summarizes a movement as
  `stock_out` / `stock_in` without its target. Carrying the destination into the feed means rewriting
  the view, which is deliberately not done here.
- **The web** shipped in the frontend half of #1364, with the Manual pages:
  - the consumable's **Remove…** dialog gains an optional *Deliver to* (none / person / asset /
    location, one live-only picker); the quick −1/+1 stays untargeted;
  - a returnable switch on the consumable form, and the ledger shows each delivery's destination and
    return state and each return's delivery;
  - one deliveries panel on the user, asset and location detail pages (deliver, return, outstanding and
    date filters). A 403 from the read hides it;
  - the offboarding sheet and the Return Act list the outstanding returnables (read with
    `outstandingOnly`, so an old loaner is never lost behind newer deliveries) and the non-returnable
    deliveries. The operator can drop the section (an app-level toggle, like the other act sections) or
    single rows. The per-row exclusions reach the act in its **URL** (`?excludeDeliveries=`), because
    the act opens in a `noopener` tab, which starts with an empty `sessionStorage`. A consumables read
    failure still blocks the act (#601); only a 403 degrades to an omitted section.

Related: [[consumable]] · [[consumable-movement]] · [[asset-history]] · [[user]] · [[asset]] ·
[[location]] · [[0034-consumables-design]] · [[0008-consumables-vs-assets]] ·
[[0019-asset-assignment-integrity]] · [[0033-asset-history-event-model]] ·
[[0030-list-pagination-contract]] · [[0032-soft-delete-middleware]] · [[0046-roles-permissions-v2]] ·
[[0048-service-accounts]] · [[0006-soft-delete-and-auditing]] · [[prisma-migrations]]
