---
title: "ADR-0057: Retry-after-fix vs pinned-version replay — how «fix the flow, then retry» should work"
tags: [adr, workflow-engine, run, retry, replay, versioning, idempotency]
status: proposed
created: 2026-06-11
deciders: [Joaquín Minatel]
---

# ADR-0057: Retry-after-fix vs pinned-version replay — how «fix the flow, then retry» should work

## Status

**proposed** — a Phase-2 follow-up to [[0054-applications-workflow-engine]] (epic #248), raised by the
bug in **#340** (user report #4). **This ADR does not authorize code** — it frames the root cause and
the option space so the CEO can pick the behaviour. It builds on the **already-shipped** run
orchestrator (`apps/api/src/workflow-engine/run/workflow-run.orchestrator.ts`), the manual-retry
endpoint (#308, `apps/api/src/workflow-engine/runs/workflow-runs.controller.ts`), the append-only
run/step ledger (ADR-0054 §4 / §8) and the redaction invariant **INV-6** ([[0031-logging-strategy]]).
It touches no data model in its recommended form; the alternatives that would are called out as such.

> **Scope of this ADR.** ONE question: when an operator **edits a workflow to fix a broken mapping**
> (e.g. adds a missing `lastName` field) and then hits **Retry** on a `FAILED` run, the edit is silently
> ignored and the run fails the same way again. This ADR explains *why* (intentional version pinning),
> lays out the three options the issue lists, and **recommends** one — without implementing behaviour.
> It does **not** revisit deterministic replay for the engine's own automatic per-attempt retry.

## Context

### The repro (#340, user report #4)

A REST connector creates a user from `[email, firstName, lastName, legajo]`. A workflow step maps only
`[email, firstName, legajo]`, so the target returns **422**, and the run finalizes `FAILED`. The
operator edits the workflow to add the `lastName` mapping, then hits **Retry** on the failed action —
but the request is sent **exactly as before, without `lastName`**, and 422s again. The run is, in
practice, un-retryable: the only escape today is to recreate the grant so a *fresh* run fires against
the new definition.

### Root cause — precisely

A `WorkflowRun` executes against a **pinned `workflowVersionId`**: the `WorkflowVersion` that was the
*latest* one at the moment the run fired. This is wired in two places:

- **Pinned at fire time.** `workflow-trigger.service.ts` resolves the workflow's latest version
  (`versions: { orderBy: { version: 'desc' }, take: 1 }`) and stamps `WorkflowRun.workflowVersionId`
  with it (`buildRunData`, ~L80–110). `WorkflowVersion.steps` jsonb is **immutable / append-only**
  (ADR-0054 §4) — the "replayable snapshot". Editing the workflow does **not** mutate that row; it
  appends a **new** `WorkflowVersion` with a higher `version`.
- **Replayed from the pin.** The walk loads `run.workflowVersion.steps` and walks *that* snapshot
  (`workflow-run.orchestrator.ts` `walk`, L250–257). `retryRun` (L186–228) is **resume-from-failed-step
  against the same pinned version**: it resolves the failed step *from the pinned `steps`*
  (`resolveFailedStepKey`), does a guarded `FAILED → RUNNING` CAS, and re-enqueues `retryStep` for the
  same step key — it **re-pins nothing**. The `RetryNotResolvableError` note (L763–774) is explicit
  that a failed-step marker "outside the pinned version" is unusable: the retry's whole frame of
  reference *is* the pinned version.

The mapping — *which* fields a step sends — lives in the **step definition** inside that pinned
`steps` jsonb. The grantee's live data is rebuilt fresh on every walk (`run-context.ts` `build`
re-reads the grant/grantee/application and freezes a context), so the *values* are current — but the
**field set** that the mapping projects from that context is frozen in the old version. The added
`lastName` mapping lives only in the **new** version the failed run never sees. So the old payload is
re-rendered and 422s again.

**This pinning is intentional and correct** (ADR-0054 §2 / §8: deterministic, auditable replay — a run
is a faithful record of *what actually executed*, not a moving target). The bug is not the pin; it is
that the product offers **no first-class path** for the overwhelmingly common operator loop *«the flow
was wrong, I fixed it, now make this stuck run go through»*. Today that loop dead-ends.

### Constraints any option must respect

- **Idempotency / no double-provision.** `(trigger, accessGrantId)` yields at most one run (ADR-0054
  §3); retries live *inside* a run as `WorkflowStepRun.attempt` rows, and resume-from-failed-step never
  re-executes an already-`SUCCEEDED` step. A non-idempotent create is retried **only** when the handler
  marks it idempotent (the `idempotent: true` / `retryable` gate, ADR-0054 §8b). **Any new retry path
  must not re-run a SUCCEEDED create.**
- **INV-6 (redaction).** No secret / PII / request-body / full-URL-with-query value is ever persisted
  or logged ([[0031-logging-strategy]]). The ledger stores field **names**, status codes, durations and
  bounded error classes — never values. An option that exposes a payload-override UI must keep operator
  input **transient**, never a stored run-metadata value.
- **Append-only run/step ledger.** `WorkflowRun` / `WorkflowStepRun` are append-only (ADR-0006 / §4).
  History is never rewritten: a retry adds new attempt rows; it does not edit old ones. An option that
  "moves" a run to a new version must respect that the existing rows are a permanent record of the old
  version's execution.
- **Permission gating.** Editing a definition (creating the new version) is `workflow:manage`; manually
  retrying/re-driving a run is `workflow:run` (`permission.ts` L70–73; the retry route is gated
  `workflow:run`, controller L83). The two are deliberately separated — ops can re-drive without seeing
  or editing definitions. **An option that lets a retry "adopt" a newer definition blurs that line and
  must say which permission it requires.**
- **Automatic vs manual retry paths must stay distinct.** The engine's **automatic** per-attempt retry
  (`retryStep`, transient backoff, CCOR-3) **must keep replaying the pinned version** — determinism
  there is non-negotiable (a transient 503 mid-run must re-send the *same* payload, not silently adopt a
  concurrent edit). Only the **manual, operator-initiated** retry (#308 `retryRun`) is in scope for any
  new "use the fixed flow" behaviour.

## Considered options

The three options from #340. They are **not mutually exclusive** — but v1 should ship the smallest one
that closes the loop, and the recommendation reflects that.

### Option 1 — Retry against the LATEST version (re-pin or spawn a successor run)

Offer a distinct **"Retry with the latest workflow version"** action. It either re-pins the existing
run to the current `WorkflowVersion` (rewriting `WorkflowRun.workflowVersionId`) and resumes from the
equivalent failed step, **or** spawns a **successor run** on the latest version (a new `WorkflowRun`
linked back to the original) and resumes there.

- **Pros.** Directly serves the loop: fix the mapping → retry-on-latest → the run picks up `lastName`.
  Matches operators' mental model ("retry with my fix").
- **Cons / hazards.**
  - **Re-pinning in place breaks the append-only / deterministic-replay invariant.** Mutating
    `workflowVersionId` makes the run's existing `WorkflowStepRun` rows (written against the *old* steps,
    with the old `stepIndex`/`stepKey`) reference a *different* definition — the ledger would no longer
    be a faithful record of what executed. This violates ADR-0006 / §4 and is **rejected on its own**.
  - **The successor-run variant is the only invariant-safe form** of Option 1, but it needs new model
    surface (a `supersedesRunId` / lineage link, plus a decision on the `(trigger, accessGrantId)`
    idempotency key — a second run for the same grant event **violates the unique key as written**, so
    the successor must either relax the key, carry an attempt suffix, or be modeled as a *re-trigger*).
    That is a real data-model change and a real idempotency decision (ADR-0054 §3) — **heavier than the
    bug warrants for v1.**
  - **"Resume from the equivalent failed step" is ill-defined across versions.** The new version may have
    renamed/removed/reordered steps; the failed step key may not exist, or may now sit behind new steps.
    There is no safe general mapping — at best it degrades to "re-run from the entry node", which **can
    re-execute an already-SUCCEEDED non-idempotent create** (double-provision) unless every prior step is
    idempotent. This is exactly the hazard `resolveFailedStepKey` was written to avoid.
  - **Permission blur.** Adopting a newer definition on retry arguably needs `workflow:manage` (you are
    asserting the new definition is correct), not just `workflow:run`.

### Option 2 — Edit-payload / mapped-fields override on retry (one-off, transient)

Let the operator **inspect the failed step's resolved mapped-field *names* and supply a one-off
override** for *this* retry — e.g. "also send `lastName` = <grantee.lastName>" — applied to the next
attempt only, then discarded. The override is **operator-supplied transient input**, never stored run
metadata.

- **Pros.** Unblocks the *exact* stuck run without touching the definition or spawning a run; the
  pinned version stays the deterministic record. Conceptually close to how a `ManualTask`'s typed input
  already feeds later steps (`ctx.steps[<key>]`, run-context.ts) — there is precedent for transient,
  operator-supplied input flowing into a mapping context.
- **Cons / hazards.**
  - **INV-6 is the hard part.** A payload-override UI is, by definition, *operator-typed values* — the
    very thing the ledger must never persist. It is only INV-6-safe if the override is **request-scoped
    and discarded after the attempt**: passed through the retry call, merged into the frozen context for
    one render, **never written to `WorkflowStepRun.metadata` / `WorkflowRun`** (only the field *names*
    may be recorded, as today). That is implementable but is a **sharp, easily-violated boundary** — one
    careless `metadata: { ...override }` and a PII value lands in the ledger.
  - **It fixes the instance, not the class.** The definition is still broken; the *next* grant fires a
    new run that 422s again until someone actually edits the flow. It is a band-aid, not a cure — useful
    as a break-glass, wrong as the primary answer.
  - **New contract + new transient input channel** through the retry endpoint (a body the retry route
    does not have today), plus a builder/inspector UI — non-trivial, and it widens the attack surface of
    a `workflow:run`-gated endpoint with free-form operator input.

### Option 3 — Clone-to-new-run from the latest version

Abandon the stuck run (leave it `FAILED`, immutable) and **start a fresh run on the current version**
from the same trigger + grant — a clean re-fire, not a resume.

- **Pros.**
  - **Invariant-clean by construction.** No re-pin, no ledger rewrite; the old run stays a faithful
    `FAILED` record, the new run is a normal first-class run on the latest version that picks up the
    `lastName` fix. It reuses the *existing* fire path — the cheapest option to reason about.
  - **No "resume from equivalent step" puzzle** — the new run starts at the entry node `steps[0]` of the
    *new* version, which is well-defined.
  - **Permission story is clean.** "Re-fire this workflow for this grant" is a `workflow:run` action; it
    asserts nothing about the definition's correctness.
  - It is essentially the *supported workaround today* ("recreate the grant"), made **first-class and
    safe** — without forcing the operator to revoke/re-grant and disturb the access audit trail.
- **Cons / hazards.**
  - **Double-provision risk if the new run re-creates from scratch.** A clean re-fire from `steps[0]`
    re-runs the *first* step. If the original run had **already SUCCEEDED** that create step before
    failing later, the clone re-creates the external account — a double-provision — **unless** the create
    is idempotent (the `idempotent: true` guard, ADR-0054 §8b). So a safe clone-to-new-run **must require
    the workflow's provisioning steps to be idempotent**, or scope the feature to runs that failed *on or
    before* the first non-idempotent create. This is the central correctness constraint of this option.
  - **Idempotency key collision.** `(trigger, accessGrantId)` is unique; a second run for the same grant
    event collides exactly like Option 1's successor-run variant. The clone must therefore be modeled as
    a **deliberate re-trigger** that either relaxes/extends the key (e.g. an attempt/sequence component)
    or supersedes the old run's key — a real ADR-0054 §3 decision, but a **localized** one (no per-step
    override channel, no re-pin).
  - **Loses in-run progress.** Any SUCCEEDED manual-task input or partial progress on the old run is not
    carried forward; the new run starts clean. For v1's REST-create flows this is acceptable; for
    long manual-heavy flows it is a real cost.

## Recommendation

**Ship Option 3 (clone-to-new-run from the latest version) as the v1 answer, guarded by idempotency**,
and treat Option 2 as a **deferred break-glass** for the rare case where editing the definition is not
enough. Reject Option 1's in-place re-pin outright (it breaks the append-only / deterministic-replay
invariant); its successor-run variant collapses into Option 3 anyway.

Rationale:

- **It respects every invariant with the least new surface.** No re-pin, no ledger rewrite, no
  transient-PII channel through a `workflow:run` endpoint. The old `FAILED` run stays an immutable,
  honest record; the new run is an ordinary run on the latest version.
- **It actually cures the loop, not just the instance.** Because the fix lives in the *definition*, the
  clone — and every future grant — provisions correctly. Option 2 alone would leave the next grant
  broken.
- **It keeps the automatic and manual paths cleanly separated.** The engine's per-attempt automatic
  retry (`retryStep`) is untouched and keeps replaying the pinned version (determinism preserved). Only
  the operator-initiated clone adopts the new version — and it does so by *starting a new run*, the one
  place where "use the latest version" is already the normal, well-defined behaviour (it is exactly what
  `planForTrigger` does on a real grant event).

The two decisions Option 3 forces the CEO to make:

1. **Idempotency-key resolution (ADR-0054 §3).** A clone is a second run for the same
   `(trigger, accessGrantId)`. Pick one: (a) extend the key with a sequence/attempt component
   (`<trigger>:<grantId>:<n>`); (b) supersede — soft-retire the old run's key and let the clone take
   `(trigger, accessGrantId)`; or (c) model a distinct `MANUAL_REPLAY` trigger so the key naturally
   differs. This is the only schema-touching decision and should be settled before any build.
2. **The double-provision guard.** The clone must **refuse (or warn hard) when the run had already
   SUCCEEDED a non-idempotent create step**, because re-firing from `steps[0]` would re-provision. The
   safe default: allow clone-to-new-run **only** when every provisioning step up to (and including) the
   failed step is `idempotent: true`, OR when the run failed at/before its first non-idempotent create.
   Otherwise the operator must re-grant (the existing answer for `COMPENSATED` runs).

Permission: the clone action is gated by **`workflow:run`** (re-driving a workflow for a grant — the
same gate as the #308 retry), **not** `workflow:manage` (the operator is not editing the definition,
they already did that under `workflow:manage`). The existing `POST /workflow-runs/:id/retry` stays the
**resume-from-failed-step-on-the-pinned-version** action (unchanged, deterministic); the clone is a
**new, distinct action** (e.g. `POST /workflow-runs/:id/replay-latest`) so the two behaviours are never
conflated in the UI or the audit trail.

## Open question for the CEO

> **Which behaviour ships for «fix the flow, then retry», and under which idempotency model?**
>
> 1. **Confirm Option 3 (clone-to-new-run from latest)** as the v1 answer — or prefer Option 2
>    (transient payload-override) or a combination? (The build team recommends Option 3; Option 2 is a
>    sharp INV-6 boundary and only fixes the instance, not the broken definition.)
> 2. **Idempotency-key resolution** for the second run on the same grant event (ADR-0054 §3): sequence
>    suffix · supersede-the-old-key · a distinct `MANUAL_REPLAY` trigger?
> 3. **Double-provision policy:** restrict clone-to-new-run to runs whose provisioning steps are
>    idempotent (refuse otherwise), or surface a hard warning and let the operator proceed? (The build
>    team recommends *refuse* — fail-closed, the §1 / §3 posture.)
> 4. Should a **transient payload-override (Option 2)** be built **at all** as a documented break-glass,
>    or deferred until a concrete need appears?
>
> No behaviour is implemented until this ADR moves to **accepted** with these answered. Until then the
> existing `/retry` (pinned-version resume) and the «recreate the grant» workaround remain the only
> paths.

## Consequences (of the recommended Option 3, once accepted)

- **Positive.** The common operator loop closes without violating any invariant; the pinned-version
  replay and the automatic per-attempt retry are untouched; the audit trail gains an honest
  old-`FAILED` + new-run lineage rather than a rewritten run.
- **Negative / trade-offs.** A localized ADR-0054 §3 idempotency-key change; a new `workflow:run`
  endpoint + a `supersedesRunId` (or equivalent) lineage link; a double-provision guard that may refuse
  to clone non-idempotent flows (the operator falls back to re-granting); and in-run manual-task
  progress is not carried into the clone. All accepted as the price of an invariant-clean cure.
- **Out of scope.** Editing the **automatic** retry's pinned-version replay (determinism stays); a
  general cross-version "resume from the equivalent step" mapping (rejected — no safe general form); and
  any role/team/manager identity mapping (a separate model-first ADR, ADR-0054 §6c).

Related: #340 · #308 · [[0054-applications-workflow-engine]] (§2 / §3 / §4 / §8) · [[0056-in-app-notification-bell]] ·
[[0031-logging-strategy]] (INV-6) · [[0006-soft-delete-and-auditing]] · [[0005-id-strategy]] ·
`apps/api/src/workflow-engine/run/workflow-run.orchestrator.ts` · `apps/api/src/workflow-engine/run/run-context.ts` ·
`apps/api/src/workflow-engine/run/workflow-trigger.service.ts` · `apps/api/src/workflow-engine/runs/workflow-runs.controller.ts`
