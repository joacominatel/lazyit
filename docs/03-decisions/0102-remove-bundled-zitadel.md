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
[[0043-zitadel-source-of-truth]], [[0047-guided-first-deploy-bootstrap]], [[0048-service-accounts]],
[[0064-admin-user-provisioning-credentials]], [[0069-migrator-import]],
[[0084-update-awareness-and-guided-update]] and [[0086-local-authentication-mode]]. Narrows #1310, which is
closed as superseded by #1543: removing all OIDC is no longer planned.

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
environment variables (`OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` for the API; `AUTH_ISSUER`,
`AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` for the web). The `/setup` wizard keeps showing the BYOI environment
snippet so an operator can wire, or later move to, their own IdP; it will list the API keys as well as the
web's.

**No in-app OIDC configuration and no stored OIDC secret.** Configuring the IdP from the UI, with the client
secret kept in the database, is out of scope.

### 3. `AUTH_MODE` is unchanged; no data migration

`AUTH_MODE` stays `shim | local | oidc` and stays immutable per instance ([[0086-local-authentication-mode]]
§1). The persisted mode marker stores the `AUTH_MODE` value (`config.service.ts:303-310`), which is `oidc`
for both bundled and BYOI, so the boot check (`apps/api/src/main.ts:50-61`) is unaffected. **No Prisma
migration** ships in this epic.

### 4. Read tolerance for the old identity values

- `IDENTITY_PROVIDER_TYPE` unset outside `AUTH_MODE=local` means generic OIDC. A legacy `zitadel` value is
  read-tolerated: it maps to generic OIDC and logs one warning. It never fails boot.
- `IntegrationMode` keeps `zitadel` as a deprecated value the API never emits, until the web stops reading
  it; then it is dropped.
- `ConfigStatus.canProvisionAccounts` keeps being emitted as `false`, and `SetupResult.mirrored` as `false`,
  so an older web build reading them keeps working.

### 5. What the IdP owns stays in the IdP

Under generic OIDC the operator's IdP owns credentials and sessions, so lazyit does not offer them: the
admin password reset is hidden in the UI outside local mode, and there are no temporary passwords and no
sessions list. Offboarding no longer disables an IdP account; lazyit still blocks the person itself — the
soft delete stays DB-first, and a soft-deleted user's next sign-in is refused with a 403 instead of being
re-provisioned (`apps/api/src/auth/jwt-auth.guard.ts:469-470`, [[0038-jit-user-provisioning]]). Disabling
the account in the IdP is the operator's step.

### 6. The `IdentityProvider` seam is retired

With one OIDC flavour and nothing to write back to, the `IdentityProvider` adapter seam of
[[0043-zitadel-source-of-truth]] §1 has no second implementation to abstract. It is retired once the callers
are gone. This closes the "Zitadel machine-user mirror" that [[0048-service-accounts]] deferred to a future
ADR: it will not be built.

### 7. Upgrade safety: guards, no migration tooling

No live instance runs the bundled Zitadel, so **no migration tooling is built**. Two guards catch a stray
install instead, and both change nothing:

- `infra/start.sh` **refuses to start** when it finds bundled leftovers — `AUTH_MODE=oidc` with an active
  `ZITADEL_MASTERKEY`, or an issuer or JWKS URL pointing at `zitadel:8080` — and points to a migration
  runbook.
- The API logs a **boot tripwire** on the same signals and points to the same runbook.

Operator volumes are never removed automatically. Once the services are gone from compose, their volumes
(`zitadel_db_data`, `zitadel_secrets`) are undeclared, and compose never deletes an undeclared volume — not
even on `down -v`. The change ships as **one MAJOR release** whose notes carry the "⚠️ Upgrade actions"
section ([[releasing]], [[0083-versioning-and-releases]]).

### 8. Password policy

`ZitadelPasswordSchema` (`packages/shared/src/schemas/primitives.ts:118`) is renamed to a neutral name, with
the old name kept as an alias. A lazyit-owned password policy is a separate, future issue.

### Not amended

[[0040-rbac-roles]], [[0046-roles-permissions-v2]], [[0050-user-history-and-activity-user-entity]] and
[[0054-applications-workflow-engine]] mention the Zitadel mirror as context or contrast. Their decisions do
not depend on it, and they stay as written.

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
  - Two compatibility shims live until the web stops reading them: the deprecated `zitadel` enum value and
    the always-`false` fields.

- **Follow-ups (epic #1543):**
  - API identity and config, users, the shared contract, the setup wizard and users UI, and the operator
    scripts (Phase 1); compose, overlay, Caddy and the bootstrap loaders, then retiring the seam and the enum
    value (Phase 2).
  - Runbooks, including migrating off the bundled Zitadel; the architecture notes ([[auth-zitadel-sot]]);
    the Manual in en and es; and security — closing SEC-022 and revising INV-4, INV-5 and INV-6 in
    [[INVARIANTS]] (Phase 3).
  - A lazyit-owned password policy, as a separate issue.

## Related

[[0037-idp-choice-zitadel-byoi]] · [[0038-jit-user-provisioning]] · [[0039-authjs-v5-frontend-oidc]] ·
[[0043-zitadel-source-of-truth]] · [[0047-guided-first-deploy-bootstrap]] · [[0048-service-accounts]] ·
[[0064-admin-user-provisioning-credentials]] · [[0069-migrator-import]] ·
[[0083-versioning-and-releases]] · [[0084-update-awareness-and-guided-update]] ·
[[0086-local-authentication-mode]] · [[auth-zitadel-sot]] · [[auth-bootstrap]] · [[backups]] ·
[[releasing]] · [[INVARIANTS]] · [[SEC-022-isactive-not-rolled-back-on-idp-revert]]
