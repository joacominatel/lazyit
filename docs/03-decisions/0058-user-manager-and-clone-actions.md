---
title: "ADR-0058: User identity graph (legajo / username / manager) + clone-with-chosen-actions"
tags: [adr, users, identity, access, workflow-engine, data-model]
status: accepted
created: 2026-06-11
updated: 2026-07-01
deciders: [Joaquín Minatel]
---

# ADR-0058: User identity graph (legajo / username / manager) + clone-with-chosen-actions

## Status

**accepted** — ratified by the CEO on 2026-06-11 (the answers are recorded in **§ Decision (ratified)**
below; they confirm every proposed default). This is the **identity-graph ADR that
[[0054-applications-workflow-engine]] §6c deliberately deferred** ("the future role/team/manager/AD
identity layer is a **separate, model-first ADR — NOT this engine**"). It is the model-first decision
the engine's mapper UI was kept forward-compatible for (`docs/workflow-engine/frontend.md` §5b,
"Open question Q4"). Issue #303, epic #248 (the manager linkage); also a standalone Users-domain
decision. Implementation is now authorized; it lands in follow-up PRs (the Prisma migration, the
`@lazyit/shared` deltas, the `POST /users/:id/clone` service/controller, the mapper `grantee.manager`
token, and the web clone wizard + manager picker).

> [!warning] Proposal only — do not build
> The contracts, fields and semantics below are a **recommendation** for the CEO to ratify, amend or
> reject. Two of the choices (manager soft-delete behaviour; whether a cloned grant fires the workflow
> engine) are **critical** (data-model + irreversible-effect territory) and are surfaced in
> **Open questions for the CEO**. Do not cut a migration or a feature branch until this ADR is
> `accepted`.

## Context

Two related user-area asks from the CEO (#303):

**(a) Clone a user with chosen actions.** When onboarding someone who mirrors an existing
colleague ("a new dev, same access as Ana"), an admin wants to **clone** a user and pick, in a
dialog, *which* of the source's footprint carries over: which [[asset]]s (via [[asset-assignment]]),
which application [[access-grant]]s, and **whether cloned grants trigger the
[[0054-applications-workflow-engine|workflow engine]]** (actually provision the new hire in Jira et
al.) or are recorded as bookkeeping-only.

**(b) Three new `User` fields** — `legajo` (the employee/file number used across LATAM payroll/HR),
`username`, and `manager`. The `manager` ask is the load-bearing one: it is a **choice of an existing
lazyit [[user]]** (a self-referential `managerId`) **with a custom-string fallback** for when the
manager is not a lazyit user (a frequent reality — the manager is in HR's system, not IT's tool).

### Why this is "model-first / ADR territory" and not a quick PATCH

The current [[user]] model is intentionally flat: name, email, role, `externalId`, lifecycle
timestamps. ADR-0054 §6c and `docs/workflow-engine/frontend.md` §5b drew a **bright line** around it —
the workflow mapper offers only `grantee.{email,firstName,lastName,id}` precisely so the engine could
not "pressure us to grow the User model into an HR/Identity-Governance graph — the explicit anti-goal".
A `manager` relation crosses that line on purpose, so it must be decided **before** anyone reads from
it. The forces:

- **Self-reference is a graph, not a column.** A `managerId` FK from `User → User` introduces cycles
  (A manages B manages A), orphaning on soft-delete (what happens to a manager's direct reports when
  the manager is offboarded?), and a query surface (org chart, "who reports to me") none of which the
  current flat model has.
- **The custom-string fallback is a discriminated either/or**, not two independent columns. "Manager
  is lazyit user X" **xor** "manager is the free-text string `'Ana Pérez (HR)'`" — the same
  human-XOR-other shape the codebase already encodes for actors (the at-most-one-actor CHECK in
  [[0048-service-accounts]] / [[asset-assignment]] / [[access-grant]]). Two nullable columns with a
  DB CHECK, not a polymorphic mess.
- **Cloning composes append-only joins.** [[asset-assignment]] and [[access-grant]] are **append-only
  lifecycle joins** ([[0006-soft-delete-and-auditing]]) — a clone does **not** copy rows, it **opens
  new** assignments/grants for the new user, with their own `assignedAt`/`grantedAt` = now and the
  cloning admin as actor. That is the only auditable way; copying a row with the source's timestamps
  would forge history.
- **A cloned grant is an `ACCESS_GRANTED` event.** Opening a grant for the clone is, by ADR-0054 §1,
  exactly the domain event the engine fires on — **after the grant transaction commits, never inside
  it**. So "do cloned grants trigger the engine?" is not a new mechanism; it is **whether the clone
  uses the normal grant path (fires) or a suppressed path (silent)**. This must be an explicit,
  audited choice, not an accident of which code path the clone happens to call.
- **`legajo` / `username` raise the same uniqueness + soft-delete-reuse question email already
  answered** ([[0041-soft-delete-reuse-and-restore]]): unique among **live** rows only, via a partial
  unique index, so offboarding frees the value for reuse/restore.

### What already exists to build on

- [[user]] conventions: `uuid()` id, `citext` email, **partial unique index `WHERE "deletedAt" IS
  NULL`** (not `@unique`) so soft-deleted values free up ([[0041-soft-delete-reuse-and-restore]]),
  `UserHistory` append-only audit ([[0050-user-history-and-activity-user-entity]]).
- The append-only join semantics of [[asset-assignment]] (one active row per `(asset, user)`, the
  live-row guard on create) and [[access-grant]] (multi-grant, no uniqueness, the live-row guard).
- The workflow engine's decoupling invariant, `(trigger, accessGrantId)` idempotency, the
  `ACCESS_GRANTED` trigger and the `LAST_ACTIVE_GRANT` deprovision default ([[0054-applications-workflow-engine]]).
- The existing **clone-is-a-create** precedent in the web (`cloneCategoryDefaults`,
  `cloneAssetModelDefaults` — a clone pre-fills a *create* form; the server sees a plain create gated
  on the create permission). The user clone is the heavier, server-orchestrated sibling of that idea.
- The mapper context kept additive on purpose: adding a `grantee.manager` / `grantee.legajo` token
  group later is a **new token group, no migration** (`docs/workflow-engine/frontend.md` §5b).

## Considered options

### (b1) The `manager` relation — link + fallback shape

- **A. Two columns + DB CHECK (chosen):** `managerId uuid?` (self-FK → `User`, `onDelete: SetNull`)
  **xor** `managerName text?` (the free-text fallback), with a DB CHECK `at-most-one` (both null is
  allowed — "no manager recorded"). Mirrors the human-XOR-SA actor pattern already in the schema, so
  the invariant is enforced in the database, not just the service. The wire shape is a discriminated
  union in `@lazyit/shared`.
- **B. A single nullable `managerId` only, no fallback.** Rejected: the CEO explicitly asked for the
  custom-string fallback because the manager is *often not a lazyit user*; forcing every manager to be
  provisioned in lazyit first is the HR-system creep we are avoiding.
- **C. A single `manager text` free-text column, no relation.** Rejected: loses the org-chart /
  "who reports to me" query and the referential integrity (renames, offboarding) that a real FK gives
  when the manager *is* a lazyit user — which is the common in-IT-team case. We want both, hence A.
- **D. A separate `Reporting` join table** (append-only, like assignments). Rejected for v1: a user
  has **one** current manager (not a many-over-time concurrency like asset ownership); a join table is
  over-modeling. If "manager history over time" is ever wanted, `UserHistory` already records the
  change (a `MANAGER_CHANGED` event, below), and a join table can be a later, additive ADR.

### (b2) Manager soft-delete behaviour — what happens to direct reports

- **A. `SetNull` on `managerId` (chosen for the FK), reports keep working.** When a manager is
  **soft-deleted** (offboarded), the FK's `onDelete` is irrelevant (soft delete is an `UPDATE
  deletedAt`, it never fires `onDelete` — the same nuance as [[asset-assignment]]'s `Restrict`). So
  the **product** rule is the real decision: a report's `managerId` still points at a soft-deleted
  row. Reads must **not** dangle — `GET /users/:id` resolves the manager through the soft-delete read
  filter ([[0032-soft-delete-middleware]]) and surfaces a soft-deleted manager as **"former manager
  (offboarded)"** rather than 404-ing or leaking a deleted user's name silently. A future
  **re-manager** prompt on offboard (decision §6 below) is the clean UX. `SetNull` is still chosen as
  the *hard*-delete FK behaviour so a genuine row delete never blocks and never dangles.
- **B. `Restrict` (a manager with reports can't be deleted).** Rejected: blocks offboarding the
  manager until every report is re-pointed — the wrong default for a 5–20-person team where the
  manager often leaves first.
- **C. `Cascade` (deleting a manager deletes the reports).** **Rejected outright** — catastrophic and
  against the no-hard-delete philosophy; reports are people, not owned children.

### (a) Clone scope — how much carries over, and does the engine fire

- **A. A clone wizard with explicit per-category selection (chosen).** The dialog presents the
  source's **current** footprint (active assignments, active grants) as **opt-in checklists**, plus
  one **engine toggle** governing whether cloned grants fire the workflow engine. The server clones
  only what was checked, as **new** append-only rows owned by the new user, in one transaction for the
  local rows; the engine fires (or not) **after** commit per the toggle.
- **B. Clone everything automatically.** Rejected: over-provisions the new hire (you rarely want
  *identical* access), and silently firing N provisioning workflows on a clone is exactly the
  un-auditable surprise ADR-0054 §1 guards against.
- **C. Clone nothing — just copy the profile fields.** Rejected: that is just "create a user with
  pre-filled name", which the existing create form already does; it ignores the actual ask (carry
  over the *access footprint*).

## Decision (proposed)

Adopt **A** in all three axes. Concretely:

### 1. New `User` fields (proposed schema delta — NOT applied)

ID / lifecycle types follow [[0005-id-strategy]] / [[0006-soft-delete-and-auditing]] exactly; the
`User` id strategy (`uuid()`, sensitive/exposed) is **unchanged**.

| Field | Type | Notes |
| --- | --- | --- |
| `legajo` | `string?` | Employee/file number. **Optional** (not every org uses one; imports may lack it). **Unique among LIVE rows only** — a **partial unique index `WHERE "deletedAt" IS NULL`** (raw SQL, no `@unique`), so a soft-deleted user frees its `legajo` for reuse/restore, exactly like `email` ([[0041-soft-delete-reuse-and-restore]]). Normalized on write (trim). Stored verbatim otherwise — lazyit never parses it. |
| `username` | `string?` | A human-facing handle distinct from `email`/`externalId`. **Optional.** Same **live-only partial unique index**. Normalized (trim + lowercase, like email) so `Ana` and `ana` collide. **`username` is NOT an auth credential** — authentication remains the IdP's job ([[0016-auth-strategy-deferred]], [[0043-zitadel-source-of-truth]]); `username` is a directory/display field only and is **never** an account-linking key (the linking key stays `email`/`externalId`, INV-2). |
| `managerId` | `uuid?` | Self-FK → `User`, `@db.Uuid`, **`onDelete: SetNull`**. The manager when they ARE a lazyit user. Mutually exclusive with `managerName`. |
| `managerName` | `string?` | Free-text fallback when the manager is **not** a lazyit user. Normalized (trim). Mutually exclusive with `managerId`. |

Plus a **DB CHECK `manager_at_most_one`**: `NOT (managerId IS NOT NULL AND managerName IS NOT NULL)`
(both-null is legal = "no manager recorded"). Prisma can't express the CHECK in PSL, so it is appended
as raw SQL in the migration, mirroring the at-most-one-actor CHECKs already in the schema
([[0048-service-accounts]]). A user **may not be their own manager** (`managerId <> id`) and the
service must reject a cycle on write (DFS up the chain — the same three-colour discipline ADR-0054 §8
uses for the step graph; cycles are short here so the cost is negligible).

The self-relation needs the two Prisma back-relations on `User` (the established named-relation
pattern in the schema): `manager User? @relation("UserManager", fields: [managerId], references: [id])`
and `reports User[] @relation("UserManager")`.

### 2. Shared contract delta (`@lazyit/shared`, `packages/shared/src/schemas/user.ts`)

- `UserSchema` (read) gains `legajo: z.string().nullable()`, `username: z.string().nullable()`, and a
  **discriminated `manager`** projection: `manager: { type: "user"; id; firstName; lastName;
  isOffboarded } | { type: "external"; name } | null`. The read shape resolves the FK to a thin,
  **redaction-safe** manager descriptor (no email/PII of the manager beyond display name) and flags a
  soft-deleted manager via `isOffboarded` (decision (b2)A).
- `CreateUserSchema` / `UpdateUserSchema` gain optional `legajo`, `username`, and a
  **`manager` input union** — either `{ managerId: uuid }` **or** `{ managerName: string }` **or**
  `null` (clear) — validated by a zod cross-field refine so the client can never send both (the
  contract mirrors the DB CHECK; same belt-and-suspenders posture as the existing
  `expiresAt >= grantedAt` refine on grants). `username` / `legajo` are normalized in the schema
  (trim / lowercase) like `EmailSchema`.
- A **new `clone-user.ts` schema** (`CloneUserSchema`) for part (a) — see §4.
- `UserHistoryEventTypeSchema` ([[0050-user-history-and-activity-user-entity]]) gains a
  **`MANAGER_CHANGED`** verb (payload `{ from, to }`, where each side is the user-id or the
  external-name string or null), so a manager change is auditable and shows in the recent-activity
  feed exactly like `ROLE_CHANGED`. (Additive to the enum; the feed allowlist gets `manager_changed`.)

### 3. What cloning + the engine read from `manager`

- **The workflow mapper context gains an additive `grantee.manager` token group** (and
  `grantee.legajo` / `grantee.username`), per the forward-compatible design
  (`docs/workflow-engine/frontend.md` §5b — "a new token group is additive"). It exposes the manager's
  **display name and, when the manager is a lazyit user, their email** (so a connector can CC the
  manager / set an `approver` field). **No new migration** — the engine reads it from the already-loaded
  grantee `User` at mapping time. The token resolves to:
  - the linked manager's `firstName lastName` / `email` when `managerId` is set and the manager is live;
  - the `managerName` string when the fallback is used;
  - **empty** (and the builder warns the token may be blank) when no manager is recorded **or** the
    linked manager is soft-deleted — never a dangling/secret leak (INV-6).
- This **retires the v1 "which manager? = a manual task" workaround** for apps that bind the token,
  but the manual-task path stays as the fallback when no manager is recorded — it is *complementary*,
  not removed (ADR-0054 §6c's manual path is unchanged for un-modeled questions like "which team?",
  which this ADR does **not** model — see Open questions Q3).
- The engine's **`LAST_ACTIVE_GRANT`** deprovision logic is **unaffected** — it keys on
  `(user, application)` active-grant counting, not on manager. Manager is a *mapping input*, never a
  trigger or a gate.

### 4. Clone-with-chosen-actions — the contract (part (a))

**Endpoint (proposed):** `POST /users/:id/clone`, gated `@RequirePermission('user:manage')` (the same
coarse capability that already governs create/edit/clone per the web comment in
`apps/web/app/(app)/users/page.tsx`). `:id` is the **source** user (must be live).

**Request body** (`CloneUserSchema`):

```jsonc
{
  // The new user's own identity — a normal CreateUser payload (email/firstName/lastName/role,
  // optional legajo/username/manager). The clone NEVER copies the source's email/legajo/username
  // (those are unique) or externalId (SEC-006 — never client-settable).
  "profile": { "email": "...", "firstName": "...", "lastName": "...", "role": "VIEWER" },

  // Opt-in selection of the SOURCE's CURRENT footprint. Empty/omitted ⇒ carry nothing.
  "cloneAssetAssignments": ["<assignmentId>", ...],   // which ACTIVE assignments to mirror
  "cloneAccessGrants":     ["<grantId>", ...],        // which ACTIVE grants to mirror

  // The engine toggle (decision below). Default FALSE = record grants WITHOUT firing the engine.
  "fireWorkflowsOnClonedGrants": false
}
```

**Server semantics (proposed):**

1. **The new user is a normal create** — same validation, same `CREATED` `UserHistory` row, same
   IdP/JIT considerations as `POST /users`. A clone is a create with extras, not a privileged bypass.
2. **Assets carry over as NEW [[asset-assignment]] rows** for the new user (`assignedAt = now`, actor
   = the cloning admin), honouring the **one-active-per-`(asset,user)`** partial unique index and the
   **live-row guard** (a soft-deleted asset in the source's list is skipped, reported in the result).
   The clone **never** releases or touches the source's own assignments — assets can have multiple
   active owners ([[asset-assignment]]), so cloning is purely additive. (Whether a physical laptop
   should really have two owners is a judgement the admin makes by checking the box; the model
   allows it.)
3. **Accesses carry over as NEW [[access-grant]] rows** for the new user (`grantedAt = now`, actor =
   the cloning admin), copying `accessLevel` (free-form, verbatim) and **not** `expiresAt` unless the
   source grant had one (carry it as-is; an already-past expiry is the admin's signal). Multi-grant
   means no uniqueness conflict.
4. **The engine toggle is the explicit, audited fire/suppress switch** (decision below): when **true**,
   each cloned grant takes the **normal grant path**, so the standard after-commit hook enqueues an
   `ACCESS_GRANTED` run with its `(ACCESS_GRANTED, accessGrantId)` idempotency key — provisioning the
   new hire externally, exactly as a hand-created grant would. When **false** (default), the grant is
   written but the after-commit trigger is **suppressed** for these clone-originated grants, so they
   are recorded bookkeeping-only. **Either way the grant row is identical and auditable**; only the
   downstream effect differs. The choice is recorded (a `clonedFrom` / `fireWorkflows` note in the
   clone's `UserHistory` `CREATED` payload) so the decision is never silent. The toggle governs **only**
   the workflow engine: the **notification bell** ([[0056-in-app-notification-bell]] §3 —
   `admin_granted` / `critical_app_access`) fires post-commit for every cloned grant **regardless** of
   the toggle (issue #359). The two are separate concerns — the bell is admin **visibility**, the engine
   is external **provisioning** — so a clone is never silent on the bell even when the engine is
   suppressed; the clone reuses the same `AccessGrantsService` emitter a hand-created grant uses.
5. **The clone is best-effort-additive and reports per item.** Local rows (the user + assignments +
   grants) commit in **one transaction**; the engine fires (or not) **after** commit (decoupling
   invariant §1 — a failing provisioning never rolls back the clone). The response is a **per-item
   result** (`{ created, skipped: [{ id, entityId?, reason }] }`, the
   [[0030-list-pagination-contract|batch]] shape already used for per-id batch ops) so a skipped
   soft-deleted asset or a failed enqueue is visible, not swallowed. Each `skipped` entry carries `id`
   (the requested assignment/grant id) and, when known, `entityId` (the underlying asset/application id
   the web resolves a friendly label from; absent for `not_found`, which never matched a source row).
   The reasons the API emits are a closed set: `not_found`, `asset_deleted`, `already_in_state`.

**Web:** a **Clone** row action on `/users` opens a wizard pre-loaded with the source's active
assignments + grants as checklists and the engine toggle (with a clear warning when on: "this will
attempt to provision N applications for the new user"). This is the heavier sibling of the existing
`cloneAssetModelDefaults` / `cloneCategoryDefaults` pattern (a clone is still, fundamentally, a create).

### The engine-toggle decision, stated plainly

**Default = DO NOT fire the workflow engine on a clone (`fireWorkflowsOnClonedGrants: false`).**
Rationale: a clone can mint many grants at once; silently firing a provisioning cannon for each is the
opposite of the opt-in, no-surprise posture of ADR-0054. The admin must **deliberately** opt in to
"actually provision the new hire everywhere", and that opt-in is audited. **This is a CEO call**
(Open question Q1) — the inverse default (clone *should* provision, since that is the onboarding point)
is defensible; we propose safe-by-default and let the CEO flip it.

## Consequences

- **Positive:**
  - Resolves the ADR-0054-deferred identity graph with the **minimal** shape that serves IT teams: a
    real manager relation **and** the non-lazyit fallback, reusing the at-most-one-CHECK,
    partial-unique-index and append-only-history patterns already in the codebase — no new concepts.
  - Onboarding "same as Ana" becomes one auditable action with explicit scope and an explicit,
    safe-by-default provisioning choice.
  - The workflow mapper gets the `manager` token it was kept forward-compatible for — additively, with
    **no migration** — retiring the "which manager? = manual task" workaround where a manager is known.
  - `legajo` / `username` follow the email soft-delete-reuse precedent exactly, so offboarding/restore
    semantics are already understood and tested-by-pattern.
- **Negative / trade-offs (accepted if ratified):**
  - **A self-referential graph** adds cycle-prevention and offboarding-dangle handling the flat model
    never had — modest, bounded code (short chains in a 5–20-person org), but real.
  - **Clone is a multi-row orchestration** with partial-success reporting — more surface than a plain
    create; the engine-fire path must be invariant-tested (a cloned grant fires **after** commit, never
    inside the clone tx) the same way ADR-0054 §1 is.
  - **Manager is a step toward an org graph** — the very creep ADR-0054 §6c warned about. We hold the
    line: this ADR models **manager only**, **not** team/role-beyond-RBAC/AD-groups (Open questions
    Q3). The mapper stays additive so a later team/AD ADR is non-breaking.
  - **A soft-deleted manager dangles by design** (reports keep a `managerId` to an offboarded row); the
    read layer must surface it honestly (`isOffboarded`) and an offboard-time re-manager prompt is the
    clean UX (Q2).
- **Follow-ups (only if accepted):** the Prisma migration (two unique-partial indexes + the manager
  CHECK + the self-relation), the `@lazyit/shared` deltas (user schema + `clone-user.ts` +
  `MANAGER_CHANGED`), the `POST /users/:id/clone` service/controller with the no-rollback invariant
  test, the mapper `grantee.manager`/`legajo`/`username` token group, the web clone wizard + manager
  picker (user-or-text), and the `users/[id]` detail surfacing manager + reports. An offboard-time
  re-manager prompt and a "who reports to me" view are natural but separable.
  - **Backend + shared slice — LANDED (issue #303, `feat/issue-303-users-manager-clone-backend`).** The
    migration (`20260611180848_user_manager_clone`: `legajo`/`username` partial-unique indexes + the
    `users_manager_at_most_one` / `users_manager_not_self` CHECKs + the `UserManager` self-relation +
    `MANAGER_CHANGED` enum value + the `recent_activity` view's `MANAGER_CHANGED` branch), the
    `@lazyit/shared` deltas (`UserSchema` manager descriptor + input union + `legajo`/`username`,
    `clone-user.ts`, `MANAGER_CHANGED`, `manager_changed` feed verb), and the users service/controller
    (manager XOR + self/cycle guard, the resolved read descriptor with `isOffboarded`, `MANAGER_CHANGED`
    emission, and `POST /users/:id/clone` with the safe-by-default engine toggle) all shipped with Jest
    coverage.
  - **Mapper token slice — LANDED (issues #350 + #357, `feat/issue-357-grantee-mapper-tokens`).** The
    engine's `grantee` mapping context now additively exposes `grantee.legajo`, `grantee.username` and a
    redaction-safe `grantee.manager.{name,email}` descriptor (`+ isOffboarded`), projected from the
    already-loaded grantee `User` by a framework-pure `projectGrantee` shared between the live run
    (`run-context.ts`) and the dry-run preview (`workflow-dry-run.service.ts`) — **no migration**. INV-6:
    a soft-deleted (offboarded) linked manager BLANKS the name/email and only flags `isOffboarded`; the
    free-text fallback yields `name` only; no manager → empty. The builder catalog
    (`apps/web/lib/workflow/context-tokens.ts`) offers the new tokens (all under the existing `grantee`
    root, so the drift guard's root set is unchanged), and #350 had already reconciled the catalog with
    the engine (no `context.*` / `application.vendor` / `url`). **Still open (separate follow-up):** the
    builder picker leaf labels remain hardcoded English (the existing catalog convention — only the group
    headings are i18n'd).
  - **Web slice — LANDED (issue #303, `feat/issue-303-users-manager-clone-ui`).** The `@lazyit/shared`
    payload builders (`toManagerInput` — the manager XOR; `managerDescriptorToFormValue`; `dedupeIds`) with
    `bun test` coverage, the `cloneUser` API client + `useCloneUser` hook, the create/edit user form's
    `legajo`/`username` inputs + manager XOR picker (lazyit user · free-text · none), the `users/[id]` detail
    surfacing the resolved manager (with the "former manager (offboarded)" treatment) + legajo + username,
    and the **server-orchestrated clone wizard** (a `user:manage`-gated row/detail action: the new user's
    profile, opt-in checklists of the source's ACTIVE assignments + grants, the `fireWorkflowsOnClonedGrants`
    toggle with a clear "this will attempt to provision N applications" warning, and a per-item result view
    showing `created` + the `skipped` reasons). The clone wizard replaces the User's old lightweight in-form
    clone-as-create (the `cloneUserDefaults` pre-fill path on `UserFormDialog`) — `cloneUserDefaults` itself
    stays for now but is no longer wired into the User UI. **Open follow-up:** the `users/[id]` read DTO does
    not expose a user's `reports` ("who reports to me"), so the detail surfaces the manager only; a reports
    view is separable and needs a backend read.

## Decision (ratified 2026-06-11)

The CEO ratified all five questions **as proposed** (every safe-by-default option). This authorizes
implementation.

1. **Engine default on clone (Q1) — clone does NOT fire the workflow engine by default**
   (`fireWorkflowsOnClonedGrants: false`). A clone records the grants but does not provision; the admin
   **opts in per clone**, and that opt-in is audited in the clone's `UserHistory` `CREATED` payload.
2. **Manager offboarding (Q2) — keep the link, surface it honestly.** When a manager is soft-deleted,
   their direct reports **keep** their `managerId` pointing at the soft-deleted row; the read layer
   resolves it through the soft-delete filter and surfaces `isOffboarded` ("former manager
   (offboarded)") — never a dangle or a leak. No auto-null, no forced re-assignment (an offboard-time
   re-manager prompt is a separable later UX).
3. **Scope (Q3) — manager only.** This ADR models the `manager` relation (+ the free-text fallback)
   **only**. `team`, `boss`-vs-manager, and AD/LDAP-group integration are **explicitly excluded** (they
   pull toward Identity-Governance — the anti-goal); the manual-task path keeps answering "which team?".
   The mapper stays additive so a future team/AD ADR is non-breaking.
4. **`username` semantics (Q4) — a directory/display handle, never an auth credential.** Authentication
   stays the IdP's job; `username` is never an account-linking key (that stays `email`/`externalId`).
   It may be exposed as a mapper token (e.g. to feed a connector's `sAMAccountName`) but is never a
   lazyit credential.
5. **`legajo` uniqueness (Q5) — optional + unique-among-live.** A partial unique index
   `WHERE "deletedAt" IS NULL` (the email precedent), so offboarding frees the `legajo` for
   reuse/restore. Normalized (trim) on write.

## Amendment (2026-07-01, #869) — offboarding also revokes Secret-vault memberships + a rotation prompt

The offboard transaction (`UsersService.remove`, `apps/api/src/users/users.service.ts`) previously
revoked active [[access-grant]]s + released [[asset-assignment]]s + deactivated the IdP account, but
**never touched [[vault-membership]]** — so a departed user kept their wrapped-DEK rows and retained
**cryptographic read access** to every Secret vault they belonged to (a SOC2 offboarding-control gap).
This amendment folds the vault-membership revoke into the **same one transaction** (a half-offboarding
that leaves crypto access is strictly worse; separation-of-duties is acceptable because it only
**removes** access, never reads a secret). Concretely, inside the existing `$transaction`:

- **Hard-drop every membership the user holds** — `tx.vaultMembership.deleteMany({ where: { userId } })`,
  the bulk twin of `SecretManagerService.revokeMembership`. [[vault-membership]] is a HARD-DROP join (no
  `deletedAt`), so `deleteMany` is correct. **INV-10-safe** ([[0061-secret-manager-zero-knowledge]] §9):
  a **pure row-delete** of wrapped key material — the server never decrypts anything.
- **A rotation prompt, read BEFORE the delete** — the affected vaults' **name + live secret count** (pure
  metadata, left of the §9 zero-knowledge line — never a value/key/ciphertext) are collected first (the
  rows vanish after the delete) and returned as `rotationVaults`. lazyit **cannot auto-rotate** (it can't
  re-encrypt), so the offboarding success sheet surfaces a **display-only "Secrets to rotate"** section —
  an honest prompt to rotate those secrets by hand, in the ambient restraint register
  ([[0049-activated-restraint-ux-direction]]).
- **Audit parity, in-lane** — one **`MEMBERSHIP_REVOKED` [[secret-audit-log]]** row per revoked vault via
  a direct `tx.secretAuditLog.createMany` (not a call into `SecretManagerService` — lanes disjoint),
  attributed with the **same human-XOR-SA actor mapping** the grant revocation uses (human → `actorId`,
  service account → `serviceAccountId`; the table's at-most-one-actor CHECK, [[0048-service-accounts]]).
  This is the SOC2 "who removed this person's vault access, when" answer.
- **`OffboardResult`** gains `revokedVaultMemberships: number` + `rotationVaults: { vaultId, name,
  itemCount }[]` (api + web mirror). **No new endpoint, permission verb, enum value, or migration**
  (`MEMBERSHIP_REVOKED` already exists in `SecretAuditAction`).

**Atomicity:** everything stays in the one transaction, so an IdP failure (or any step) rolls the
membership drops back too — no split-brain. **Deferred (unchanged):** no auto-rotation, no DEK rotation,
no hard-revoke of a cached DEK (ADR-0061 §5 Phase-2); the pre-confirm preview of memberships and the
printable Return Act secrets section are separable later UX.

## References

[[0054-applications-workflow-engine]] (the deferral this resolves; the decoupling invariant,
`ACCESS_GRANTED` trigger, mapper context, `LAST_ACTIVE_GRANT`) ·
[[0050-user-history-and-activity-user-entity]] (the `UserHistory` audit this extends with
`MANAGER_CHANGED`) · [[0048-service-accounts]] (the at-most-one-actor CHECK pattern the manager
either/or reuses) · [[0041-soft-delete-reuse-and-restore]] (live-only partial unique index for
`legajo`/`username`) · [[0032-soft-delete-middleware]] (the read filter the manager resolution honours)
· [[0006-soft-delete-and-auditing]] (append-only joins; a clone opens new rows, never copies) ·
[[0005-id-strategy]] (`User` stays `uuid`) · [[0030-list-pagination-contract]] (the per-item batch
result shape) · [[0016-auth-strategy-deferred]] / [[0043-zitadel-source-of-truth]] (auth stays the
IdP's; `username` is not a credential) · [[user]] · [[asset-assignment]] · [[access-grant]] ·
`docs/workflow-engine/frontend.md` §5b (the additive-mapper forward-compat note) · [[INVARIANTS]] INV-6.
</content>
</invoke>
