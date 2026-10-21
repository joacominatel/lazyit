---
title: "ADR-0104: Custom roles — a roles table with protected system roles"
tags: [adr, auth, authz, rbac, permissions, security, data-model, migration]
status: accepted
created: 2026-10-21
updated: 2026-10-21
deciders: [Joaquín Minatel]
---

# ADR-0104: Custom roles — a roles table with protected system roles

## Status

**accepted** — 2026-10-21 (CEO decision on #1560). The CEO accepted Option B and the eleven
recommendations of the #1560 analysis, listed in [§ The eleven decisions](#the-eleven-decisions).

> [!warning] Build deferred — nothing in this record is built
> The direction is settled and the build is **deferred** until there is a concrete first custom
> role to ship. Until U1 lands ([§ Phased plan](#phased-plan-future-work)), lazyit runs exactly what
> [[0046-roles-permissions-v2]] §1 describes: `enum Role { ADMIN MEMBER VIEWER }`, three fixed roles,
> no `roles` table, no `role:manage`. The as-built notes ([[role-permission]], [[user]],
> [[authorization]], [[INVARIANTS]] INV-7 / INV-8) describe today's code and stay correct until then.
> Do not cite this record as a description of current behavior.

**Supersedes** [[0046-roles-permissions-v2]] **§1** ("Roles stay fixed; permissions become the unit of
authorization") and Option B's deferral in that record's *Considered options*. Everything else in
ADR-0046 stands: the frozen catalog-as-code (§2), the DB-first role-to-permission map (§3, whose table
this record replaces in U1), the read tiers (§4), ADMIN as the immutable full set (§5), and its
amendments. Permissions stay the unit of authorization. What changes is that the set of roles becomes
data.

**Closes in favour of this direction:** #846 (groups or teams as a membership subject) and #619
(per-user permission overrides) were closed as *not planned* on 2026-10-21. Both are variants of
Option C below.

## Context

[[0046-roles-permissions-v2]] kept three fixed roles with configurable per-role permissions and
deferred dynamic custom roles to a future ADR, for three reasons:

1. **The fixed-role invariants.** The last-admin guard and the first-user-is-ADMIN bootstrap
   ([[INVARIANTS]] INV-7).
2. **The IdP mirror** of exactly three project roles.
3. **The cost** of a role-management UI and lifecycle.

Since then:

- **Reason 2 is gone.** [[0102-remove-bundled-zitadel]] removed the bundled Zitadel and its role
  write-back. Roles are lazyit-local, like permissions.
- **Reason 1 holds if ADMIN stays special.** Both invariants are about ADMIN. A design that keeps
  ADMIN a protected, built-in role leaves them untouched.
- **Reason 3 is a real cost** and is priced into the phased plan below.

The groundwork already exists. All 325 `@RequirePermission` sites in the API and the 130 `useCan()`
call sites in the web check a **permission**, never a role. A custom role is therefore a named
permission set. The work sits in four places:

- the resolver and the data model;
- about 20 call sites that read a role: counts, the email audience, KB folder rules, the AI tools;
- the anti-escalation rules;
- the role-management UI.

Three fixed roles cannot express a team's real shape. "Help desk" means MEMBER plus
`accessGrant:grant`, minus purchases. Today that can only be done by changing every MEMBER at once.

SEC-088 has meanwhile bounded the two escalation paths that custom roles would make far more
likely to be used:

- **The role ceiling** on a delegated `user:manage`: [[0040-rbac-roles]], *Amendment — role ceiling
  and usable admins*. It relies on the order `ADMIN > MEMBER > VIEWER`.
- **The ADMIN-only matrix write**: [[0046-roles-permissions-v2]], *Amendment — the matrix is edited by
  an ADMIN only*, which reserves it "until custom roles (#1560) give them their own verb".

Custom roles have no natural order, so the role ceiling has to become a subset rule (INV-ROLE-1
below).

## Considered options

- **Option A — Keep three fixed roles.**
  - For: no cost.
  - Against: cannot express a role such as Help desk without changing every MEMBER.
  - Rejected as the long-term shape. It remains what runs until the build.
- **Option B — A `roles` table with three protected system rows, plus custom roles copied from a
  template (chosen).**
  - Each user holds exactly one role.
  - ADMIN, MEMBER and VIEWER become system rows whose keys equal today's enum literals.
  - A custom role is created from MEMBER, VIEWER or another custom role.
  - For: the permission checks do not change, and the ADMIN invariants are preserved.
  - Against: a new table, a migration and a management UI.
- **Option C — Several roles per user, permission groups, or per-user overrides** (#846, #619).
  - Rejected. Each one complicates the last-admin guard, KB folder role rules, email audiences and
    auditing: "which grant gave this user `X`?" no longer has one answer.
  - It also works against *opinionated over configurable*.

## Decision

Adopt **Option B**, to be built in the phases below. These sections are the binding design for U1
to U4.

### 1. The role entity

- **The model.** `RoleDefinition` (`@@map("roles")`). Its fields:
  - `key`: the natural key, immutable, an upper-snake identifier such as `HELP_DESK`. The system keys
    are exactly `ADMIN`, `MEMBER` and `VIEWER`.
  - `name`: the display name.
  - `isSystem`.
  - `templateKey`: the role it was copied from.
  - The soft-delete archival columns ([[0006-soft-delete-and-auditing]]).
- **The key is a deliberate exception to [[0005-id-strategy]].** Role values are already stored as
  text inside JSON: KB folder rules ([[0060-kb-folder-access-control]]), history payloads (`UserHistory`
  `ROLE_CHANGED`) and notification audiences. A natural key keeps every stored value valid with no
  rewrite. Keys are **never reused**, so an old payload never names a different role.
- **The system rows** are seeded and protected: they are never archived, never renamed by key, and
  ADMIN is never edited.

### 2. The user's role

- **`users.role_key`** is the authoritative role: a foreign key to `roles.key`, `NOT NULL`, default
  `'VIEWER'`.
- **`users.role`** stays as a **coarse level**: `ADMIN | MEMBER | VIEWER | CUSTOM`.
  - Every ADMIN-specific check keeps working unchanged: the last-admin guard, `AdminOnlyGuard`, the
    bootstrap, INV-DIR-1.
  - The new `CUSTOM` value makes the compiler flag every place that assumes exactly three roles.
- **A CHECK constraint keeps the two consistent.** A system key implies the matching level, and a
  custom key implies `CUSTOM`.

### 3. ADMIN stays special

- ADMIN is never editable and never usable as a template. It remains the full catalog through the
  resolver short-circuit ([[0046-roles-permissions-v2]] §5, INV-8).
- ADMIN alone holds the new **`role:manage`** permission. It replaces `settings:manage` plus
  `AdminOnlyGuard` as the gate on matrix editing.
- The last-admin and first-user-ADMIN invariants (INV-7) are unchanged.

### 4. Defaults and directory persons

- New users still default to **VIEWER** (INV-7). The default is not configurable.
- A directory person ([[INVARIANTS]] INV-DIR-1) is still forced to VIEWER until promoted.

### 5. Templates and future catalog defaults

- A custom role is created by copying the permission set of a template: MEMBER, VIEWER or another
  custom role.
- When a later release adds a catalog permission, a custom role receives its **template's** default
  for it **once**, through the seed-once ledger ([[0046-roles-permissions-v2]] §4, #1314). After that
  it is the operator's to change, and a revocation is durable, exactly as for MEMBER and VIEWER today.

### 6. Archival

- **The 409.** Archiving a role returns **409** while any live user holds it.
- **The way out.** A bulk "reassign holders" action moves those users to another role and unblocks
  the archive.
- **No reuse.** An archived key is never reused, and it is restorable.
- **KB folder rules.** A rule naming an archived or unknown key matches **nobody**: it fails closed,
  and the read path tolerates the value.

### 7. KB folder rules

Custom roles can be used in KB folder role rules ([[0060-kb-folder-access-control]]), by key.

### 8. Audit

- `PermissionAuditLog` gains a nullable `roleKey` and role lifecycle actions: created, renamed,
  archived, restored and reassigned.
- A user's role assignment stays in `UserHistory` as `ROLE_CHANGED`, now naming the keys.

### 9. Contract changes (`packages/shared`)

- A new `RoleKeySchema`.
- The permission matrix schemas become keyed by role key (string) instead of the three-literal enum.
- **New endpoints**, all declared `unexposed` to the AI tool catalog ([[0097-ai-assistant-mcp-and-headless-api]]):
  - `GET /roles`;
  - create, rename, archive, restore and reassign-holders.
- Matrix editing moves from `settings:manage` to `role:manage`.

### 10. INV-ROLE-1: no escalation through roles

A new invariant, written into [[INVARIANTS]] by U2 and not before:

- **`role:manage` is ADMIN-only.** It is never grantable to another role or to a service account.
- **The subset rule.** Assigning a role to a user, or creating, cloning or editing a user, requires
  that the target role's effective permissions are a **subset** of the actor's own.
  - This generalizes the SEC-088 role ceiling, which assumes an order the custom roles do not have.
  - The 403 code is settled in U2.
- **Only ADMIN assigns ADMIN.**
- **Nobody changes their own role.**

### 11. The cap

At most **10** custom roles (live, not archived). The system rows do not count.

## The eleven decisions

The CEO's decisions on #1560, each accepted as recommended:

| # | Decision |
| --- | --- |
| 1 | Accept the direction now. Build it after #1543 and v2.1 ship, once there is a concrete first custom role. |
| 2 | One role per user. |
| 3 | Templates are MEMBER, VIEWER or a custom role, never ADMIN. |
| 4 | A new ADMIN-only `role:manage` permission replaces `settings:manage` for matrix editing. |
| 5 | The subset rule applies to `user:manage` holders, and only ADMIN assigns ADMIN. |
| 6 | Custom roles inherit their template's future catalog defaults once. |
| 7 | Archival is blocked while users hold the role, with bulk reassign and no key reuse. |
| 8 | The default role stays VIEWER and is not configurable. |
| 9 | A cap of 10 custom roles. |
| 10 | Custom roles can be used in KB folder rules, by key. |
| 11 | The legacy enum and tables are not retired in this epic. |

## Upgrade path

Every step is additive, and populated databases upgrade in place
([[0084-update-awareness-and-guided-update]], `docs/04-development/claude-workflow.md` §7).

1. Add the enum value `CUSTOM` to `Role`.
2. Create the `roles` table and seed the three system rows.
3. Add `users.role_key` with its default `'VIEWER'`, and backfill it from `role::text`.
4. Create `role_grants` and `applied_role_grant_defaults`, copied from `role_permissions` and
   `applied_role_permission_defaults`. New tables are needed because the legacy primary key is the
   enum column.
5. Add a nullable `permission_audit_log.role_key`.
6. In a **second migration**, add the CHECK constraints. PostgreSQL cannot use a new enum value in
   the same transaction that adds it, so this waits until `CUSTOM` is committed.

What happens to existing data:

- **The legacy tables.** `role_permissions` and `applied_role_permission_defaults` stay in place but
  are no longer written. They are **never dropped** in this epic (decision 11).
- **Every user keeps their role.** The backfill maps each user to the system row of the same name.
- **Permissions do not change.** A golden test proves that each role resolves to exactly the same
  permission set before and after the migration.
- **The audit log.** Existing rows keep `role_key = null`, and their `role` column still names the
  role.

Rollout takes two releases:

1. The migration plus the resolver switch, with no visible change.
2. The custom-role feature itself.

## Phased plan (future work)

An integration-branch epic, started only when the build is green-lit:

| Unit | Lane | Scope | Size |
| --- | --- | --- | --- |
| U0 | docs | This ADR. **Done.** | S |
| U1 | backend | The migrations; resolver and seed on `role_grants`; the role-write helper; the parity (golden) test | M, the riskiest |
| U2 | backend + shared | Role schemas, `role:manage`, `RolesModule`, INV-ROLE-1, and the call sites: counts, email audience, folder rules, AI tools | L |
| U3 | frontend + Manual | An N-column matrix; create, rename, archive and reassign; role selects and badges; the Manual in en and es | L |
| U4 | security | A sentinel pass over the new surface and the invariants | S |

## Consequences

**Positive:**

- Operators can express their real team shape, such as Help desk, without bending MEMBER for
  everyone.
- The permission checks do not change. Not one `@RequirePermission` or `useCan()` site is rewritten.
- The ADMIN invariants hold unchanged, because ADMIN stays a built-in, protected role.
- One subset rule replaces the order-based role ceiling, and it also covers the custom roles.
- Matrix editing gets its own ADMIN-only verb instead of the `settings:manage` plus
  `AdminOnlyGuard` patch.

**Negative / trade-offs:**

- **Two role columns.** `users.role` and `users.role_key` must agree. That needs a CHECK constraint
  and discipline in every write path: a write helper in U1, not ad hoc updates.
- **Dead tables.** The legacy `role_permissions` and `applied_role_permission_defaults` tables stay in
  the schema, unused, for at least this epic: dead weight that someone has to know is dead.
- **A natural-key exception** to [[0005-id-strategy]]. Role keys are immutable forever, so a typo in
  a key is permanent. Only the display name can be fixed.
- **About 20 call sites** that read a role must be revisited. A missed one silently treats a custom
  role as no role. The `CUSTOM` enum value makes the compiler find most of them, not all.
- **The subset check** runs on every user and role write. It is more expensive and harder to explain
  in an error than "ranks above you".
- **A real UI cost.** An N-column matrix, a role lifecycle, a reassign flow and the Manual pages:
  the cost ADR-0046 deferred.
- **Deferral risk.** A design accepted long before it is built can drift from the code under it. U1
  must re-read this record against the code of the day and amend it, not build from it blindly.

**Follow-ups:**

- U1 to U4 above, behind a concrete first custom role.
- At U2: add INV-ROLE-1 to [[INVARIANTS]], amend the role ceiling in [[0040-rbac-roles]] to the subset
  rule, and update [[role-permission]], [[user]] and [[authorization]] to the as-built shape.

Related: [[0046-roles-permissions-v2]] · [[0040-rbac-roles]] · [[0102-remove-bundled-zitadel]] ·
[[0060-kb-folder-access-control]] · [[0005-id-strategy]] · [[0006-soft-delete-and-auditing]] ·
[[0097-ai-assistant-mcp-and-headless-api]] · [[role-permission]] · [[user]] · [[authorization]] ·
[[INVARIANTS]]
