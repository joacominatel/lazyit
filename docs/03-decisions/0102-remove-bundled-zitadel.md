---
title: "ADR-0102: Remove the bundled Zitadel IdP; generic OIDC (BYOI) stays opt-in"
tags: [adr, auth, oidc, idp, infra, deployment, security]
status: accepted
created: 2026-10-09
updated: 2026-10-09
deciders: [Joaquín Minatel]
---

# ADR-0102: Remove the bundled Zitadel IdP; generic OIDC (BYOI) stays opt-in

## Status

**accepted** — 2026-10-09 (epic #1543). Accepted by the CEO on PR #1544.

**Supersedes** [[0037-idp-choice-zitadel-byoi]]; its "BYOI by environment variables" contract (§3) is
carried forward here. **Amends** [[0038-jit-user-provisioning]], [[0039-authjs-v5-frontend-oidc]],
[[0040-rbac-roles]], [[0043-zitadel-source-of-truth]], [[0046-roles-permissions-v2]],
[[0047-guided-first-deploy-bootstrap]], [[0048-service-accounts]], [[0054-applications-workflow-engine]],
[[0064-admin-user-provisioning-credentials]], [[0069-migrator-import]],
[[0084-update-awareness-and-guided-update]], [[0086-local-authentication-mode]] and
[[0091-on-prem-ad-ldap-directory-source]]. Narrows #1310, which is closed as superseded by #1543: removing
all OIDC is no longer planned.

**Built** — 2026-10-09 on the epic branch (PRs #1546–#1554). Implementation settled §2, §4, §5, §7 and §8 more
precisely than first written; those sections now describe what shipped, and
[§ Implementation](#implementation) lists the differences.

## Context

[[0037-idp-choice-zitadel-byoi]] shipped Zitadel as the bundled IdP and [[0043-zitadel-source-of-truth]] made
it the identity source of truth that lazyit writes back to. [[0086-local-authentication-mode]] then made
local accounts the default and OIDC opt-in, offered three ways (built-in accounts, bundled Zitadel, BYOI).

The CEO's direction (2026-10-09): *"sacar zitadel, no se usa, es incomodo, y nos entorpece el codigo y
algunas logicas, nos deja bloqueado algunas cosas [...] lo que no debemos sacar es del panel de setup la
config por si queremos exportar a otro oidc."* No production instance runs the bundled Zitadel
(CEO-confirmed).

Reading the code confirms the bundled IdP costs more than it serves, and that it breaks the mode we want
to keep:

- **BYOI is broken today.** `IDENTITY_PROVIDER_TYPE` defaults to `zitadel`
  (`apps/api/src/auth/identity/identity-provider.factory.ts:12`, fallback at `:58`), mirrored by
  `apps/api/src/config/integration-mode.ts:10`. Nothing in `infra/` sets it: `infra/start.sh:621-628`
  writes only the `OIDC_*`/`AUTH_*` client values for BYOI, and the `/setup` snippet lists only the web's
  `AUTH_*` keys (`apps/web/app/setup/_components/byoi-snippet.tsx:14-16`). A BYOI instance therefore builds
  the Zitadel adapter (`supportsManagement = true`,
  `apps/api/src/auth/identity/zitadel.identity-provider.ts:31`) with no service-account key, and every
  management call throws "Zitadel management not configured" as a 503
  (`apps/api/src/auth/identity/zitadel-management.service.ts:811-820`). That reaches `/setup`
  (`apps/api/src/config/config.service.ts:228-230`), user creation
  (`apps/api/src/users/users.service.ts:668`), linked-user edits (`users.service.ts:1080`, `:1090`) and
  offboarding (`users.service.ts:1589`). The "BYOI degrades gracefully" guardrail of
  [[0043-zitadel-source-of-truth]] §6 #4 does not hold in practice.
- **`infra/update.sh` aborts on local and BYOI installs.** It always dumps `zitadel_db`
  (`infra/update.sh:302`), and a failed dump aborts the update by design (`:407-410`). Its
  `missing_env_keys` (`:681`) treats every active key of `.env.prod.example` as required, and the example
  carries active `ZITADEL_*` keys (`infra/env/.env.prod.example:189-226`) and an internal
  `OIDC_JWKS_URI=http://zitadel:8080/...` (`:258`).
- **The write-back is the source of SEC-022.** A role or profile edit mirrors to Zitadel and, on failure,
  reverts only the mirrored fields (`users.service.ts:1069-1135`), so a non-mirrored field such as
  `isActive` survives a "your change was not saved" 503
  ([[SEC-022-isactive-not-rolled-back-on-idp-revert]]).
- **Offboarding makes an IdP HTTP call inside a Prisma interactive transaction**
  (`users.service.ts:1582` opens it; `:1589` calls `idp.deactivateUser`), holding a database transaction
  open across a network round-trip with retries.
- **The Zitadel create-compensation is the only hard delete of a `User`** — `users.service.ts:933`
  (`compensateLocalCreate`) and its twin in setup, `config.service.ts:256`. Everything else soft-deletes
  ([[0006-soft-delete-and-auditing]]).

What stays sound: authorization is DB-first and mechanism-agnostic ([[0046-roles-permissions-v2]]), JIT
provisioning and email account-linking are generic OIDC ([[0038-jit-user-provisioning]]), and the web's
Auth.js provider is generic ([[0039-authjs-v5-frontend-oidc]]). None of it needs Zitadel.

## Considered options

- **Keep as-is (three-way, bundled Zitadel included).** Zero change, but it keeps an IdP nobody runs, the
  code coupling above, the broken BYOI default, and an updater that fails on two of the three modes.
  Fixing BYOI alone (flip the default) leaves the rest. Rejected.
- **Remove all OIDC (the original #1310 scope).** Local accounts only. The smallest codebase, but it drops
  SSO for teams that already run Entra ID, Okta, Keycloak or Authentik — the case the CEO wants to keep
  ("por si queremos exportar a otro oidc"). Rejected.
- **Remove the bundled Zitadel only; generic OIDC (BYOI) stays opt-in (chosen).** Removes the bundled IdP,
  its infra and the write-back coupling; keeps the standard OIDC path that the guard, JIT and Auth.js
  already implement generically; fixes BYOI by making it the only OIDC flavour.

## Decision

### 1. The bundled Zitadel is removed

Everything that exists only to run or drive the bundled IdP goes:

- the `zitadel`, `zitadel_db`, `zitadel-secrets-init` and `zitadel-bootstrap` compose services, the
  `infra/docker-compose.oidc.yaml` overlay, the sidecar's Dockerfile and script, and the Caddy `auth.` site
  (`infra/caddy/sites/auth.caddy`);
- the `bundled` choice in `infra/start.sh` and the `zitadel_db` dump in `infra/update.sh` and the backup
  sidecar;
- in the API: the Zitadel Management client and adapter, the role and profile write-back on user edit, the
  deactivate mirror on offboarding, the create-compensation hard delete, `POST /users/:id/provision-account`,
  and the Zitadel branch of `/setup`.

### 2. Generic OIDC (BYOI) stays as the opt-in SSO mode, configured by environment variables

The contract of [[0037-idp-choice-zitadel-byoi]] §3 carries forward: the API validates tokens from any
OIDC-compliant IdP through its discovery document and JWKS, with no vendor SDK, configured entirely by
environment variables:

- **API:** `AUTH_MODE=oidc`, `OIDC_ISSUER` and `OIDC_JWKS_URI` (both required at boot,
  `apps/api/src/auth/boot-config.ts:98-105`), and an optional `OIDC_CLIENT_ID` that, when set, is the
  expected token audience (`apps/api/src/auth/jwt-auth.guard.ts:405-409`). The API is a resource server
  only: it never reads `OIDC_CLIENT_SECRET`.
- **Web:** `AUTH_ISSUER`, `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` (Auth.js, [[0039-authjs-v5-frontend-oidc]]).

The `/setup` wizard keeps showing the BYOI environment snippet so an operator can wire, or later move to,
their own IdP. It lists both the web and the API keys
(`apps/web/app/setup/_components/byoi-snippet.tsx:13-22`).

**No in-app OIDC configuration and no stored OIDC secret.** Configuring the IdP from the UI, with the client
secret kept in the database, is out of scope.

### 3. `AUTH_MODE` is unchanged; no data migration

`AUTH_MODE` stays `shim | local | oidc` and stays immutable per instance ([[0086-local-authentication-mode]]
§1). The persisted mode marker stores the `AUTH_MODE` value
(`apps/api/src/config/config.service.ts:196-203`), which is `oidc` for both bundled and BYOI, so the boot
check (`apps/api/src/main.ts:39-55`) is unaffected. **No Prisma migration** ships in this epic.

### 4. Read tolerance for the old identity values

- `IDENTITY_PROVIDER_TYPE` is no longer read: the identity posture comes from `AUTH_MODE` alone
  (`resolveIntegrationMode`, `apps/api/src/config/integration-mode.ts:4-6`), so `oidc` always means generic
  OIDC. A legacy `IDENTITY_PROVIDER_TYPE=zitadel` is tolerated: outside `AUTH_MODE=local` it logs one
  warning at boot-config validation (`apps/api/src/auth/boot-config.ts:139-145`). It never fails boot.
- `IntegrationMode` is `generic-oidc | local` (`packages/shared/src/schemas/config.ts:26`). The API never
  emitted `zitadel` after the identity-core change and the web ships in the same release, so the deprecated
  value was dropped within the epic rather than kept for a later release.
- `ConfigStatus.canProvisionAccounts` keeps being emitted as `false` (`apps/api/src/config/config.service.ts:86`),
  and `SetupResult.mirrored` as `false` (`apps/api/src/config/config.controller.ts:130`), so an older web
  build reading them keeps working.

### 5. What the IdP owns stays in the IdP

Under generic OIDC the operator's IdP owns credentials and sessions, so lazyit does not offer them: the
admin password reset is hidden in the UI outside local mode, and there are no temporary passwords and no
sessions list. Offboarding no longer disables an IdP account. The soft delete stays DB-first, and it blocks
a person who has signed in before: their `externalId` still matches the token's `sub`, so the next sign-in
is refused with a 403 instead of being re-provisioned (`apps/api/src/auth/jwt-auth.guard.ts:463-470`,
[[0038-jit-user-provisioning]]).

That block has a limit. A person offboarded **before their first OIDC sign-in** has no `externalId`, and
the verified-email account link ignores soft-deleted rows (`jwt-auth.guard.ts:572`). If their IdP account
stays enabled, their first sign-in JIT-creates a fresh `VIEWER` row. Offboarding under OIDC therefore has
to be paired with disabling the account at the IdP — that step is the operator's, and it is what actually
ends access.

### 6. The `IdentityProvider` seam is retired

With one OIDC flavour and nothing to write back to, the `IdentityProvider` adapter seam of
[[0043-zitadel-source-of-truth]] §1 has no second implementation to abstract. It is retired:
`apps/api/src/auth/identity/` is gone, and the local-mode branches read `AUTH_MODE` directly. This closes the "Zitadel machine-user mirror" that [[0048-service-accounts]] deferred to a future
ADR: it will not be built.

### 7. Upgrade safety: guards, no migration tooling

No live instance runs the bundled Zitadel, so **no migration tooling is built**. Two guards catch a stray
install instead, and both change nothing:

- `infra/start.sh` **refuses to run** on an existing install whose env still wires the bundled IdP — an
  active `ZITADEL_MASTERKEY`; an `OIDC_ISSUER`, `OIDC_JWKS_URI`, `AUTH_ISSUER` or `AUTH_INTERNAL_ISSUER`
  pointing at `zitadel:8080`; or a `<project>_zitadel_db_data` volume with no `OIDC_CLIENT_ID` — before it
  writes anything, and points to the migration runbook (`docs/05-runbooks/migrate-off-bundled-zitadel.md`).
  The guard **does not fire on an `AUTH_MODE=local` install**: local mode never used the IdP, so a stray
  Zitadel volume or key next to it is no reason to stop (`infra/start.sh:904-920`).
- The API **refuses to start** under `AUTH_MODE=oidc` with an active `ZITADEL_MASTERKEY`, or an
  `OIDC_ISSUER` or `OIDC_JWKS_URI` whose host is `zitadel:8080`. It is a boot-config check, so it fails
  before Nest is created, with a CRITICAL log naming the variable and the same runbook
  (`apps/api/src/auth/boot-config.ts:114-126`, exit at `:152-155`). Outside `oidc` those values are inert
  and ignored.

Operator volumes are never removed automatically. Once the services are gone from compose, their volumes
(`zitadel_db_data`, `zitadel_secrets`) are undeclared, and compose never deletes an undeclared volume — not
even on `down -v`. The change ships as **one MAJOR release** whose notes carry the "⚠️ Upgrade actions"
section ([[releasing]], [[0083-versioning-and-releases]]).

### 8. Password policy

`ZitadelPasswordSchema` is renamed `PasswordPolicySchema` (`packages/shared/src/schemas/primitives.ts:119`).
The alias was dropped once every caller had moved to the new name; it was an internal TypeScript name, not
a wire contract. A lazyit-owned password policy is a separate, future issue.

### Not amended

[[0050-user-history-and-activity-user-entity]] mentions the Zitadel mirror as context; its decision does not
depend on it, and it stays as written. [[0040-rbac-roles]], [[0046-roles-permissions-v2]] and
[[0054-applications-workflow-engine]] were first listed here too, but each states something about the seam
or the role mirror that is no longer true, so they carry a dated amendment line instead; their decisions are
unchanged.

## Consequences

- **Positive:**
  - BYOI works: an `AUTH_MODE=oidc` instance with its own IdP gets the generic adapter by default, and
    `/setup`, user creation, edits and offboarding stop returning 503.
  - `infra/update.sh` works on every supported install: one database to dump, no `ZITADEL_*` keys to demand.
  - Four containers, a subdomain, a DNS record, a certificate and an unrotatable master key leave the OIDC
    deployment.
  - SEC-022's root cause goes with the write-back; offboarding no longer holds a transaction across HTTP; the
    only `User` hard delete disappears.
  - Less code on the security-critical path: no Management client, no service-account key, no
    compensation logic.

- **Negative / trade-offs:**
  - An operator who wants SSO must bring and run their own IdP. There is no turnkey SSO any more.
  - lazyit no longer manages IdP accounts: onboarding an SSO user means creating them in the IdP (JIT links
    them on first sign-in), and offboarding means disabling them there too.
  - A stray bundled install cannot just upgrade: it stops at the guard and follows the migration runbook by
    hand.
  - One compatibility shim lives until no supported web build reads it: the always-`false`
    `canProvisionAccounts` and `mirrored` fields.

- **Follow-ups (epic #1543):**
  - API identity and config, users, the shared contract, the setup wizard and users UI, and the operator
    scripts (Phase 1); compose, overlay, Caddy and the bootstrap loaders, then retiring the seam and the enum
    value (Phase 2).
  - Runbooks, including migrating off the bundled Zitadel; the architecture notes ([[auth-zitadel-sot]]);
    the Manual in en and es; and security — closing SEC-022 and revising INV-4, INV-5 and INV-6 in
    [[INVARIANTS]] (Phase 3).
  - A lazyit-owned password policy, as a separate issue.

## Implementation

Built on the integration branch `feat/issue-1543-remove-bundled-zitadel`:

| PR | Unit |
| --- | --- |
| #1546 | Setup wizard: local or your own OIDC; the BYOI snippet lists the web and API keys |
| #1547 | Shared contract: `PasswordPolicySchema`; `zitadel` deprecated in `IntegrationMode` |
| #1548 | Users UI: "Create OIDC account" removed; admin reset hidden outside local mode |
| #1550 | API identity core and `/config`: generic OIDC by default; the boot refusal on bundled leftovers |
| #1551 | Operator scripts: `start.sh` local or BYOI with the refuse guard; the dev Zitadel path removed |
| #1552 | API users: write-back, `provision-account`, deactivate mirror and compensation delete removed |
| #1553 | Runtime: Zitadel compose services, `oidc` overlay, Caddy `auth.` site, bootstrap sidecar and client-file loaders removed; the backup sidecar dumps the app database only |
| #1554 | The `IdentityProvider` seam, the `zitadel` contract value and the `ZitadelPasswordSchema` alias removed |

Where the implementation settled a detail differently from the first draft of this record:

- **§7:** the API boot check refuses to start rather than logging a tripwire, and the `start.sh` guard skips
  `AUTH_MODE=local` installs.
- **§2:** the API needs `OIDC_JWKS_URI` and never reads `OIDC_CLIENT_SECRET`; the client secret is the web's.
- **§4:** the `zitadel` `IntegrationMode` value was dropped within the epic, not in a later release.
- **§8:** the `ZitadelPasswordSchema` alias was dropped with it.
- **§5:** the post-offboarding 403 covers only a person who has signed in before; one offboarded before
  their first sign-in is stopped only by disabling the IdP account.

**Outstanding:** `infra/update.sh` on the integration branch still runs the dual dump of §1 (the app
database and `zitadel_db`, `infra/update.sh:292-305`). Its mode-aware fix is tracked by #1545 (PR #1549,
against `dev`); the `zitadel_db` dump goes when that lands here.

## Related

[[0037-idp-choice-zitadel-byoi]] · [[0038-jit-user-provisioning]] · [[0039-authjs-v5-frontend-oidc]] ·
[[0040-rbac-roles]] · [[0043-zitadel-source-of-truth]] · [[0046-roles-permissions-v2]] ·
[[0047-guided-first-deploy-bootstrap]] · [[0048-service-accounts]] · [[0054-applications-workflow-engine]] ·
[[0064-admin-user-provisioning-credentials]] · [[0069-migrator-import]] · [[0091-on-prem-ad-ldap-directory-source]] ·
[[0083-versioning-and-releases]] · [[0084-update-awareness-and-guided-update]] ·
[[0086-local-authentication-mode]] · [[auth-zitadel-sot]] · [[auth-bootstrap]] · [[backups]] ·
[[releasing]] · [[INVARIANTS]] · [[SEC-022-isactive-not-rolled-back-on-idp-revert]]
