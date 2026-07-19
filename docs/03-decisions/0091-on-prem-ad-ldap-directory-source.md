---
title: "ADR-0091: On-prem AD/LDAP as a read-only directory source"
tags: [adr, directory, ldap, active-directory, users, provisioning, security, data-model]
status: accepted
created: 2026-07-19
updated: 2026-07-19
deciders: [Joaquín Minatel]
---

# ADR-0091: On-prem AD/LDAP as a read-only directory source

## Status

**accepted** — 2026-07-19 (issue [#839](https://github.com/joacominatel/lazyit/issues/839)). Backend
built 2026-07-19 (shared contracts + the `apps/api/src/directory` module + the additive migration + this
ADR + the dev-`docs/` notes); the Settings → Instance → Directory screen and the public `/help` Manual
pages ship in the frontend lane per CLAUDE.md #3/#7.

## Context

A recurring ask from self-hosted teams already running **on-prem Active Directory / LDAP**: don't make me
re-type the org into lazyit — read it from the directory I already maintain. lazyit already has the two
rails this needs:

- A **login-less person** (`User.directoryOnly = true`, `externalId = null`, `role = VIEWER`) — created
  today by the bulk importer's `skipIdpWriteBack` branch (`users.service.ts`), so an asset can be assigned
  to someone who has no login. See ADR-0069.
- A **reconcile-into-a-PENDING-tray** pattern — the reporting agent (ADR-0074) ingests host reports and
  drops unknown hosts into a human-review tray keyed on an immutable id.

This ADR combines them: bind read-only to AD, subtree-search, and **upsert login-less directory persons**
so the roster stays in step without hand entry.

### Hard non-goals (explicitly out of scope)

- **No write-back to AD.** The direction is strictly one-way (read). lazyit never creates/modifies/deletes
  a directory object.
- **NOT a new `AUTH_MODE`, NOT LDAP-bind login.** Authentication stays OIDC (ADR-0016) or local
  (ADR-0086). A directory person has **no login** until an admin explicitly provisions one
  (`provisionAccount` / `provisionLocalAccount`, #1072) — that stays the ONLY login-granting path.
- **No group-as-subject.** AD `memberOf` DNs are captured **inert** in `directoryAttrs`
  (store-now-act-later); mapping a group to a lazyit role/grant is deferred to
  [#846](https://github.com/joacominatel/lazyit/issues/846).

## Decision

A singleton **`DirectoryConnection`** config row (Settings → Instance → Directory, gated `settings:manage`,
**off by default**) drives a **read-only reconcile** run by (a) a periodic sweeper and (b) an ad-hoc
`POST /directory/sync` ("Sync now"). The reconcile binds read-only, subtree-searches the base DN with a
static operator filter, and **upserts** login-less `directoryOnly` VIEWER persons.

### Natural key

Match on a **new nullable `User.directorySourceId`** = the AD `objectGUID` formatted as a canonical GUID
string, plus a `User.directorySource` marker (`"ad"`). **NOT `externalId`** — that is the OIDC-sub /
account-linking key (INV-2); overloading it would collide a login-linked identity with a login-less
directory row. **Email is only a merge HINT** surfaced in the review tray, NEVER an auto-merge key (two AD
objects can share or rotate a mailbox). Uniqueness is a **live-scoped partial unique index** on
`directorySourceId` (`WHERE "deletedAt" IS NULL AND "directorySourceId" IS NOT NULL`), raw SQL in the
migration following the `email`/`legajo`/`username` precedent (ADR-0041) — Prisma can't express partial
uniques.

### Reconcile outcomes

- **NEW** (no `directorySourceId` match) → create a `directoryOnly` VIEWER person via the sanctioned
  `users.service.create({ skipIdpWriteBack: true, directorySource: "ad", directorySourceId, directoryAttrs })`
  rail. It lands in the **PENDING review tray** — which is simply *"the set of `directoryOnly` persons"*
  (the existing `directoryOnly` list filter); `User` has no `state` column, so a person **is** the tray
  (no new lifecycle column). Email is the mapped `mail` iff it doesn't collide with a live user, else a
  per-GUID non-routable `<guid>@directory.local` placeholder (import parity) with the real mail flagged in
  `directoryAttrs`.
- **MATCHED** → refresh mapped profile fields (`firstName`/`lastName`) + `directoryAttrs` only, via a
  **fixed field allowlist** (mass-assignment-proof). Username/email columns are NOT overwritten on refresh
  (they are live-unique — collision minefield; the raw values live in `directoryAttrs` as hints).
- **DISAPPEARED** past a configurable **grace threshold** (`offboardGraceDays`, default 7) → **soft
  offboard** (`isActive = false` + `directoryOffboardedAt`), NEVER a hard delete (ADR-0006). "Missing
  since" is the person's `directoryAttrs.lastSeenAt` heartbeat (bumped every run they're present), so the
  grace is per-person and a single dropped run can't mass-deactivate the directory. A reappearance clears
  the offboard — but only when *we* set it (a manual deactivation is never auto-reactivated).

### Hard invariants (enforced in code, asserted by a jest test)

The reconcile **NEVER** changes `role` (stays VIEWER), **NEVER** sets `passwordHash`, **NEVER** sets
`externalId`, **NEVER** flips `directoryOnly` to `false`, **NEVER** grants a login, and **NEVER**
hard-deletes. New AD persons are created `directoryOnly` so the first-user→ADMIN bootstrap (which excludes
`directoryOnly` rows, `jwt-auth.guard.ts`) can never hand ADMIN to an unauthenticated directory row.

### Credential storage

The read-only bind password is a **server-managed machine credential** (the server MUST decrypt it to
bind — the explicit inverse of the zero-knowledge Secret Manager, INV-10; using the vault here would be a
category error). It is stored **AES-256-GCM at rest** on the `DirectoryConnection` row (envelope columns
`bindPassword{Ciphertext,Iv,AuthTag,KeyVersion}`), **write-only** on the wire (the read shape exposes only
`bindPasswordSet`), decrypted in memory only at bind time.

### Attribution + audit

Attribution is an **optional dedicated directory `ServiceAccount`** (ADR-0048) the config points at
(`serviceAccountId`, SetNull); matched/offboard `UserHistory` rows are attributed to it (else a system
actor). Each run is audited via the cached `lastSync{At,Status,Counts}` on the row and logs **redacted
counts only** (`created/updated/offboarded/skipped`) — never the bind password, DNs, or attribute PII.
Reused `UserHistoryEventType` `CREATED`/`UPDATED` with a discriminating `{ action: "directorySync" }`
payload (no new enum value).

## Deviations from the originally-proposed shape (reconciled against the repo)

Two points where the build follows repo convention over the ADR's first-draft wording:

1. **Scheduling: a `setInterval` sweeper, not a BullMQ repeatable job.** The draft said "scheduled (BullMQ
   repeatable) reconcile", but the repo has **zero** repeatable/JobScheduler jobs — all 8 periodic tasks
   are `setInterval` sweepers (including the ADR-0074 reporting-agent sweeper this feature is modelled on).
   So `directory-sync.sweeper.ts` is built on the `InfraAgentStalenessSweeper` mold (unref'd interval,
   skipped under `NODE_ENV=test`, re-entrancy-guarded, whole-pass try/caught), and **"Sync now" calls the
   same re-entrancy-guarded reconcile method** — no queue. Introducing a first-ever BullMQ repeatable would
   be net-new machinery the repo has deliberately avoided (one line before fifty).
2. **Crypto: a dedicated `DIRECTORY_SECRET_KEY` axis via `directory.crypto.ts`, not the WorkflowSecret
   `SecretService`.** The draft named a "SecretEncryptionService"; the real `SecretService` is coupled to
   the `WorkflowSecret` model (requires an `applicationId` a directory bind lacks) and fails loud at boot
   for its key. Directory sync is OPTIONAL, so the build reuses the **AES-256-GCM primitive** via a
   standalone `directory.crypto.ts` mirroring `smtp.crypto.ts` under its OWN **optional, lazily-resolved**
   key axis `DIRECTORY_SECRET_KEY` (the app boots without it; a bind-password write with no key returns a
   clean 409) — never a fail-loud `onModuleInit`.

## Consequences

- **Upgrade-safe (STANDING RULE #8):** three nullable columns on `users` (no backfill), a new singleton
  config table, all additive. Existing rows read `null` and are untouched; new validation enforces only on
  write. `prisma migrate deploy` on a populated DB is deploy-safe (no destructive drop, no NOT-NULL without
  default). *Live migrate-deploy validation on a populated DB was PENDING at build time (Docker down in the
  build env) — verify before promotion.*
- **Security posture:** LDAPS default (`rejectUnauthorized` true), StartTLS explicit, plaintext a loud
  opt-in; `settings:manage` + `ServicePrincipalForbiddenGuard`; bounded connect/op timeouts + paged/max-
  entries caps against a hostile/huge directory. The LDAP dialer is deliberately **not** routed through the
  HTTP egress guard — AD legitimately lives on RFC1918, and the guard's private-IP DENY would break every
  real deployment. The search runs the operator's **static** filter with **zero** user-value interpolation
  (no LDAP-injection surface); an `escapeLdapFilterValue` helper (ldapts `Filter.escape`) is shipped as the
  sanctioned escaper for any future per-value filter.
- **New dependency:** `ldapts` (^9.0.0) — a maintained, Promise/TS-native LDAP client; a real wire protocol
  with no stdlib equivalent. Its documented `Filter.escape`, `tlsOptions.rejectUnauthorized`, paged search,
  and `explicitBufferAttributes` (for the binary `objectGUID`) are used.

## Alternatives considered

- **LDAP-bind login / a new `AUTH_MODE`** — rejected: a much larger auth-surface change; the ask is a
  *roster source*, not an auth backend. OIDC/local already cover authentication.
- **Overload `externalId` as the natural key** — rejected: it is the OIDC-sub / account-linking key;
  overloading collides a login identity with a login-less directory row (INV-2).
- **Group-as-subject (map `memberOf` → roles/grants)** — deferred to #846; `memberOf` is stored inert now.
- **A BullMQ repeatable job** — rejected for parity with the repo's 8 existing sweepers (see Deviations).

## Related

- ADR-0069 (directory-only persons / bulk import), ADR-0074 (reporting agent reconcile + PENDING tray),
  ADR-0048 (service accounts + actor attribution), ADR-0079 (SMTP write-only server secret + own key axis),
  ADR-0041 (live-scoped partial unique), ADR-0006 (soft delete), #1072 (`provisionLocalAccount`), #846
  (group-as-subject, deferred).
