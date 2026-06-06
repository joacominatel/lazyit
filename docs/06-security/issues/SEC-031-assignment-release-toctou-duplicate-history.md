---
id: SEC-031
title: Assignment release has no DB backstop (TOCTOU → duplicate RELEASED history + actor overwrite)
severity: low
status: open
cwe: CWE-367
discovered: 2026-06-06
module: asset-assignments
tags: [toctou, race, audit-integrity, actor-attribution]
---

# SEC-031 — Assignment release has no DB backstop (TOCTOU → duplicate RELEASED history + actor overwrite)

## Summary

`PATCH /asset-assignments/:id/release` guards "already released" only with a `findFirst` pre-check;
the `update` itself filters on `{ id }` alone, so two concurrent (or double-clicked) releases both
pass the check and both commit — appending two `RELEASED` rows to the append-only history and letting
the second actor overwrite the first's `releasedById`/`releasedAt`.

## Description

`AssetAssignmentsService.release` reads the row, throws 409 if `releasedAt !== null`, then updates
(`asset-assignments.service.ts:120-154`):

```ts
const assignment = await this.findOne(id);
if (assignment.releasedAt !== null) throw new ConflictException(...); // time-of-check
...
const released = await tx.assetAssignment.update({
  where: { id },                  // time-of-use — no `releasedAt: null` predicate
  data: { releasedAt: new Date(), ...actor, ... },
});
await this.history.record(tx, { assetId, eventType: 'RELEASED', payload: { userId }, actor });
```

The check and the write are not atomic and there is **no DB-level backstop** for release. This is the
mirror image of the create path, which the project deliberately backstopped: the partial unique index
`WHERE releasedAt IS NULL` (`migrations/20260526120000_.../migration.sql:29-31`) makes a duplicate
*active* assignment a P2002→409 regardless of the pre-check (deferred.md "Assignment create race is
backstopped"). Release has no analogue, because removing an active row never violates that uniqueness
constraint — so two releases of the same id race freely:

1. Two `PATCH .../release` arrive close together (genuine concurrency, or a UI double-click/retry).
2. Both `findOne` read `releasedAt === null` → both pass the 409 gate.
3. Both `update` succeed (`where: { id }` matches in both); the later write wins on
   `releasedAt`/`releasedById`/`releasedBySaId`.
4. `history.record` runs once per request → **two `RELEASED` events** for one logical release, on an
   append-only, immutable log (ADR-0006/0033).

`releaseAllForUser` (the offboarding path, `:168-200`) has the same shape but is naturally serialized
inside the offboard `$transaction`, so it is lower risk; the per-id `release` endpoint is the exposed
one.

## Impact

Audit-integrity, not access: the append-only AssetHistory — a load-bearing invariant of the product
("auditability by default", immutable history) — can hold a duplicate/contradictory `RELEASED` entry,
and under two racing human/SA actors the recorded "who released it" can be the loser of the race.
No data loss, no authZ bypass. Trivially reachable (a double-click is enough to double-emit), which is
why it is worth fixing, but the concrete damage is a noisy/incorrect audit row, so Low. (Arguably
Medium on the "easily triggered + violates a core invariant" axis; kept Low because impact is bounded
to audit noise and the attribution is always a *valid* actor, never a forged one.)

## Proof of concept

Reasoned from code, **not executed**.

```sh
# fire two releases of the same active assignment at once
id=<activeAssignmentId>
curl -s -X PATCH -H "X-User-Id: <userA>" :3001/asset-assignments/$id/release &
curl -s -X PATCH -H "X-User-Id: <userB>" :3001/asset-assignments/$id/release &
wait
# both can return 200; GET /assets/<assetId>/history then shows TWO RELEASED events for one release,
# and releasedById reflects whichever update committed last.
```

The 409 only fires when the *checking* read already sees `releasedAt` set — which is not guaranteed
between two in-flight requests.

## Affected

- `apps/api/src/asset-assignments/asset-assignments.service.ts:120-154` — `release`: pre-check + non-atomic update, `where: { id }` only.
- `apps/api/src/asset-assignments/asset-assignments.service.ts:168-200` — `releaseAllForUser`: same shape (mitigated by the offboard transaction).
- (Backstop that exists for the *create* race, for contrast) `apps/api/prisma/migrations/20260526120000_add_asset_assignment_model/migration.sql:29-31`.

## Recommendation

Make the release conditional at the DB so only one wins, then treat "lost the race" as the already-
released case:

```ts
const { count } = await tx.assetAssignment.updateMany({
  where: { id, releasedAt: null },          // atomic check-and-set
  data: { releasedAt: new Date(), ...actor, ...notes },
});
if (count === 0) throw new ConflictException(`AssetAssignment ${id} is already released`);
```

Only the winning transaction has `count === 1`, so it alone records the single `RELEASED` history
event; the loser 409s and writes nothing. (A partial unique index can't express "at most one release",
so the conditional `updateMany` is the right backstop here.)

## Prevention

Adopt the conditional-write (`updateMany … where:{ <state-predicate> }` + `count` check) as the house
pattern for every "close a lifecycle row once" transition, the same way the create race uses a unique
index. A concurrency test (two parallel releases → exactly one 200, one 409, one history row) locks it.

## References

- CWE-367: Time-of-check Time-of-use (TOCTOU) Race Condition.
- ADR-0019 (asset-assignment integrity), ADR-0024 (actor shim), ADR-0033 (asset-history), ADR-0006 (append-only/auditing).
- `docs/06-security/deferred.md` — "Assignment create race is backstopped" (the create-side pattern this release path lacks).
