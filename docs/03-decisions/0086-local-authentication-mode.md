---
title: "ADR-0086: Local (first-party) authentication mode — make Zitadel/OIDC opt-in"
tags: [adr, auth, security, deployment, data-model]
status: accepted
created: 2026-07-03
updated: 2026-09-02
deciders: [Joaquín Minatel]
---

# ADR-0086: Local (first-party) authentication mode — make Zitadel/OIDC opt-in

## Status

**accepted** — 2026-07-03 (issue #989). CEO ratified the direction and the resolved decisions; build
proceeds in phases F1–F4.
**Supersedes** the "no first-party auth" posture of [[0016-auth-strategy-deferred]].
**Amends** [[0037-idp-choice-zitadel-byoi]], [[0038-jit-user-provisioning]],
[[0039-authjs-v5-frontend-oidc]], [[0043-zitadel-source-of-truth]],
[[0047-guided-first-deploy-bootstrap]], [[0058-user-manager-and-clone-actions]],
[[0061-secret-manager-zero-knowledge]], [[0066-secret-manager-password-vs-recovery-root]].
Builds on the DB-first authorization model ([[0046-roles-permissions-v2]]) which is already
authentication-mechanism-agnostic, and mirrors the first-party bearer-token pattern of the
Service Account tokens ([[0080-service-account-secret-retrieval]]).

> **Scope.** A THIRD, instance-wide, deploy-time-chosen, **immutable** authentication mode —
> `AUTH_MODE=local` — where lazyit owns username/email + password credentials directly (argon2id),
> mints its own signed session token, and runs with **no external IdP** (no Zitadel, no auth subdomain,
> no OIDC issuer). OIDC (bundled Zitadel or BYOI) remains fully supported as the opt-in "enterprise/SSO"
> mode. **NOT** in scope: MFA/TOTP for local mode (deferred), federation/mixed OIDC+local users on one
> instance (a single mode per instance), and **plain-HTTP-on-LAN** (a separate deployment-TLS axis —
> its own follow-up, see §"Non-goals").

## Context

lazyit targets small IT/Systems teams (5–20). The observed reality of that segment: **most do not
have a public domain.** At best an internal DNS name; often they reach the app by LAN IP and accept a
self-signed certificate. Today lazyit **forces** the enterprise path on everyone: OIDC via Zitadel is
**mandatory** ([[0037-idp-choice-zitadel-byoi]], [[0039-authjs-v5-frontend-oidc]],
[[0043-zitadel-source-of-truth]]), which drags in three coupled requirements — (a) a stable OIDC issuer
URL, (b) a second hostname `auth.{domain}`, and (c) HTTPS everywhere. On a `localhost`/LAN deploy this
manifests as real friction (browser cert warnings; a remote agent hitting the box by IP fails the TLS
handshake because Caddy's internal CA only covers `localhost`). The standard self-hosted pattern for
this segment (Gitea, Portainer, Proxmox) is **local accounts by default, OIDC opt-in**.

**Key architectural finding (from a four-lens investigation of the codebase, #989):** the friction is
**not** TLS — it is the mandatory-OIDC coupling. And authentication vs authorization were split cleanly
from the start:

- **Authorization is already 100% mechanism-agnostic.** `RolesGuard`, `PermissionResolverService` and
  every `@RequirePermission` read `User.role` / `request.principal` from the DB, **never a token claim**
  ([[0046-roles-permissions-v2]]). Given a `User.id` + `Role`, RBAC needs **zero** changes.
- **A first-party bearer scheme already exists and runs in every mode.** Service-Account tokens
  (`lzit_sa_*`: hashed-at-rest, `timingSafeEqual`, generic-401 no-enumeration, its own guard branch)
  are the proven mold for a local human session ([[0080-service-account-secret-retrieval]]).
- **The mode seam is half-built.** `AUTH_MODE` is already an enum (`shim` | `oidc`), `IntegrationMode`
  is `zitadel` | `generic-oidc`, the `IdentityProvider` adapter is a real abstraction point, and
  `/config/status` + the `/setup` wizard are already mode-aware. Adding `local` **extends** these; it is
  not greenfield.

What is genuinely new — and where the risk concentrates — is the **credential and session machinery**
lazyit deliberately never built ([[0016-auth-strategy-deferred]] chose "delegate to an IdP; do not
implement our own password/sessions/MFA"). A four-lens adversarial review (security, architecture
completeness, data/migration, infra) surfaced seven bricking/outage-class gaps and a set of security
decisions that this ADR resolves before any code is written.

## Considered options

**(1) Keep OIDC mandatory (status quo).** ❌ Excludes lazyit's own core segment; the LAN/domain friction
is structural, not a bug.

**(2) Drop TLS / go HTTP-only for internal deploys.** ❌ Wrong lever. TLS is easy to relax; the anchor is
OIDC. And "HTTP on LAN" is a real security downgrade that deserves its own explicit, separate decision —
it is **not** a substitute for solving the auth coupling. Carved out as a follow-up (§Non-goals).

**(3) A first-party local auth mode, OIDC opt-in (chosen).** Adds `AUTH_MODE=local`: lazyit owns
username/email + password (argon2id) and mints its own signed session, with no IdP. OIDC stays as the
opt-in mode. Matches the proven self-hosted pattern and reuses the DB-first authZ + SA-token precedents.

Within option 3, the sub-decisions (each an adversarial-review finding) and the chosen resolutions:

- **Session revocation:** stateless JWT (unrevocable — logout/offboard/password-change become no-ops,
  regressing the OIDC offboarding fix) vs. **a token-version column (chosen)** vs. a full session table
  (granular but a new mutable table + GC). Chosen: a `User.sessionEpoch` embedded in the token; the guard
  already re-reads the `User` row every request (for `isActive`), so the epoch/active/soft-delete check is
  ~free and closes logout + password-change + offboard at once. A session table is over-scoped for the
  target.
- **Peppering:** server-held pepper (stronger against a DB-only leak — INV-10's threat model — but a new
  hard DR linchpin) vs. **none in v1 (chosen)**, with the column shaped to tolerate one later.
- **Brute-force:** hard per-account lockout (DoS-able against a known admin) vs. **per-account
  exponential backoff + per-IP rate-limit (chosen)**, plus a constant-time dummy-hash on unknown users.
- **Login identifiers:** email-only vs. **email + optional username (chosen)**; explicitly **not** the
  employee number (`legajo`). This reopens the `username`-is-not-a-credential invariant of
  [[0058-user-manager-and-clone-actions]] — amended below.
- **Escape hatch for a lost last-admin password:** none (instance bricks) vs. **a one-shot recovery CLI
  (chosen)** that resets an admin's `passwordHash` against the DB (the self-hosted operator has shell —
  the Gitea/Portainer pattern) vs. a printed recovery key (heavier UX). 
- **Mode immutability enforcement:** documentation-only (an operator will flip the env and brick the
  instance) vs. **a persisted, boot-checked mode marker (chosen)** that refuses to start on a mismatch.

## Decision

### 1. A third, instance-wide, immutable auth mode

`AUTH_MODE` becomes a **three-state** enum — `shim` | `local` | `oidc` — everywhere (`boot-config`,
`IntegrationModeSchema`, the guard, `/config/status`). The modes stay distinct: `shim` remains the
unauthenticated dev bypass (X-User-Id header, **prod-forbidden**); `local` is real password auth,
**allowed in prod**; `oidc` is the existing IdP path. The guard's `shim ? … : oidc` ternary becomes a
`switch` with an explicit `handleLocal`.

The mode is **chosen once at first deploy and is immutable.** Switching modes on a populated instance is
unsupported (oidc↔local half-migrates and bricks: OIDC users have `externalId` and no password; local
users the reverse). Enforcement is **not** documentation: a **persisted mode marker** (a one-row
`instance_config`, written at first successful setup) is checked at boot; if `env.AUTH_MODE` ≠ the stored
marker, the API **refuses to start** (fail-loud, same posture as `boot-config`). Migrating an existing
instance to another mode is an explicit, out-of-band data operation, not a config flip.

### 2. Backwards compatibility — `AUTH_MODE` becomes explicit-required (the outage-class fix)

Today `AUTH_MODE` is **unset in every production deploy** and resolves to OIDC by an implicit else-branch.
If "unset" were repurposed to mean `local`, **every existing OIDC instance would silently flip to local on
the next restart** — a full outage (no local users, no `passwordHash`). Therefore, once the third mode
exists, **`AUTH_MODE` has no implicit default**: an unset value is a hard boot failure with a clear message.

- The "**local is the default**" decision applies **only** to what `start.sh` / `dev-setup` *write into a
  freshly generated env for a new install* — never to the runtime fallback of an already-unset value on an
  existing file.
- The release notes / upgrade runbook ([[0083-versioning-and-releases]]) MUST carry a required step:
  *"before upgrading, set `AUTH_MODE=oidc` explicitly in your `.env`."* An existing OIDC deploy that sets it
  needs **zero** data migration — `externalId`-linked users and the IdP seam are untouched.

### 3. Credentials, hashing, and the login flow (lazyit now owns these)

- **Schema (additive, no backfill):** `User.passwordHash String?`, `User.passwordUpdatedAt DateTime?`,
  `User.sessionEpoch Int @default(0)`. Nullable — OIDC and `directoryOnly` users never get one. No new
  unique index needed: the live-scoped partial uniques on email and username already exist.
- **Hashing:** **argon2id** (`@node-rs/argon2`, Docker-build-verified per [[claude-workflow]] #6), params
  pinned as constants in `@lazyit/shared` (OWASP floor: m=19 MiB, t=2, p=1), PHC-encoded per-hash salt,
  **rehash-on-successful-login** when stored params are below target. No server-side hashing precedent
  exists (the SA path uses fast SHA-256 by design; a human password needs the slow KDF).
- **Login (`POST /auth/login`):** looks up the user on the **live-filtered** client by email or username,
  verifies argon2id, and mints a **first-party session JWT signed HMAC-`HS256`** with a persistent server
  secret. Security invariants (all non-negotiable, mirroring the SA guard and the OIDC alg-pin):
  - **Algorithm pinned to `HS256`** on verify (anti `alg:none`/confusion, as OIDC pins `RS256`).
  - The token carries `sub` (User.id) + `sessionEpoch` and **nothing authorization-bearing** — role is
    always resolved DB-first every request (INV-1).
  - Uniform `401` for unknown-user and wrong-password, **constant-time** via a dummy-hash verify on the
    unknown-user path (no enumeration/timing oracle — the discipline of INV-SA-1).
  - `null`/empty `passwordHash` **fails closed** (never verifies against any password, incl. empty).
  - Rejects `directoryOnly`, inactive, and soft-deleted rows.
  - Per-account exponential backoff + per-IP rate-limit (the `SetupRateLimitGuard` pattern); password
    length capped before argon2 (anti-DoS); server-side minimum strength at set-time.
- **Session revocation:** the guard's `handleLocal` re-loads the `User` every request and rejects when
  `token.sessionEpoch ≠ user.sessionEpoch` or `!isActive` or soft-deleted. Password change, admin reset,
  deactivate, and "sign out everywhere" **bump `sessionEpoch`** → all prior tokens die. Short token TTL is
  belt-and-suspenders on top of the epoch check.
- **Guard dispatch order** is unchanged: `@Public` → SA-token branch (unambiguous `lzit_sa_` prefix, no
  namespace overlap) → `handleLocal` / `handleOidc` by mode. A local token is rejected in OIDC mode and
  vice-versa (asserted in tests).

### 4. The signing secret is a required, fail-loud, low-severity-DR secret

`AUTH_MODE=local` **requires** a persistent `SESSION_SIGNING_SECRET` — generated by `start.sh`
(`openssl`, length-asserted like `WORKFLOW_SECRET_KEY`) and validated by a **new `boot-config` refine**
(a misconfigured local deploy must fail at boot, not on the first login). It is **distinct** from
`AUTH_SECRET` (Auth.js's cookie key, needed in all modes). Its DR severity is **lower** than
`ZITADEL_MASTERKEY`/`WORKFLOW_SECRET_KEY`: rotating it only forces re-login (no data loss). It must
**not** be the per-boot-random pattern (that silently invalidates all sessions on every restart). Password
hashes need no special DR handling — they ride the ordinary app-DB `pg_dump`.

### 5. Provisioning — set-password moves to F1; the two blocking guards get a local branch

Removing JIT (OIDC-only) makes `/setup` and explicit user creation the **only** ways a user comes to
exist. Two existing guards actively break local mode and are fixed:

- `requiresAdminPassword` is **decoupled from `supportsManagement`** — in local mode `/setup` **requires**
  a password and hashes it (else it would create a passwordless, un-loggable first ADMIN → brick).
- `UsersService.create`'s `if (data.password && !supportsManagement) → 400` and
  `requestPasswordReset`'s `if (!externalId) → 501` get a `kind==='local'` branch: hash the password
  locally / mint a local temp-password. Local credential logic lives in a **new `LocalCredentialService`**;
  `LocalIdentityProvider` stays a **pure no-op** (the `IdentityProvider` seam is about *mirroring to a
  foreign IdP*, which local mode does not do).
- **Admin-set-password** is audited append-only (`PASSWORD_RESET_BY_ADMIN`, actor+subject) and sets a
  `mustChangePassword` flag (one-time credential; narrows the ADMIN→impersonation window). It grants **zero**
  additional crypto access to the victim's Secret Manager vaults (§7).
- **Imported/migrated users** land `passwordHash=null` (can't log in until an admin provisions one);
  `directoryOnly` users stay login-incapable by construction. (Correction of record: the bulk importer has
  only ever created `directoryOnly` VIEWER rows; "real user import" was deferred in
  [[0069-migrator-import]] §12.)
- **Amendment (issue #1072) — admin-initiated LOCAL onboarding of a directory person.** The prior invariant
  ("a `directoryOnly` row never receives a credential via any path") was **absolute** and, after a mass
  import in local mode, left every imported person permanently stranded: login rejects `directoryOnly`,
  `requestPasswordReset` 422s a directory person, and `provisionAccount` hard-gates on
  `supportsManagement=false`. The invariant is **narrowed, not dropped**: a `directoryOnly` row may receive a
  credential **only** through a new explicit, admin-action-gated `UsersService.provisionLocalAccount`
  (`POST /users/:id/provision-local-account`, `user:manage`), which mints a one-time temp password with the
  **same** primitives as the admin reset (`generateTempPassword` + `credentialFields({mustChangePassword:true})`),
  flips `directoryOnly=false`, appends an audited `UPDATED` history row, and returns the plaintext **once**.
  Security reasoning that keeps this safe: (1) **no self-service** — only an ADMIN (never the subject, never
  the login path) can trigger it; (2) **no role widening** — the import forced VIEWER and onboarding passes
  the existing role through untouched (the method never reads a role from any payload); (3) **shown once** —
  the temp password is never stored in plaintext or refetchable, and `mustChangePassword` forces a change at
  first sign-in (narrowing the hand-off window, exactly like the admin reset); (4) **local-mode only** — the
  method 400s in OIDC/BYOI (where `provisionAccount` / the foreign IdP own onboarding), so the invariant is
  unchanged there. INV-10 is untouched: onboarding grants **zero** additional Secret-Manager crypto access
  (the vault passphrase is a separate credential, §7).
- **Amendment (issue #1268) — the admin reset gains a SECOND delivery, and the UI finally reaches it.**
  Two problems, one root. First, the Users page gated its reset action on `externalId == null`, which is
  true for **every** local-mode user by construction — so the local admin reset built above shipped
  unreachable, and an operator on a local instance could not reset anyone from the UI at all. Second,
  minting a temp password was the *only* delivery this ADR contemplated, because at the time lazyit had no
  outbound email; [[0079-instance-smtp-outbound-email]] has since shipped, and the self-service
  forgot-password flow (§F4) already mints a single-use, ≤1h `PasswordResetToken` and emails the link. An
  admin had no way to trigger that same, better path for someone else.
  **The admin now chooses the delivery explicitly** (`POST /users/:id/reset-password`, body
  `{ delivery, revokeSessions? }`, `user:manage`):
  - `email` — mint a reset link and send it through the instance SMTP. The subject sets their own
    password; lazyit never learns it. Preferred when the mailbox is reachable.
  - `temporary-password` — the original behavior above, unchanged. It stays available **even when email
    works**, because it is the escape hatch for a subject who cannot reach their mailbox (wrong address,
    locked out of email, no SMTP), and removing it would recreate the lockout this ADR exists to prevent.
  **Honest reporting is the deliberate divergence from §F4.** The public forgot flow is uniform-by-design
  so it cannot be used as an account-enumeration oracle, and it fails soft. Neither property is worth
  anything here: the caller is an authenticated admin who already knows the account exists, so a silent
  no-op would deceive only the person who needs the truth. This path therefore reports synchronously —
  **409** (`reason: smtp-not-configured | origin-unknown`) when the link cannot be sent, **503** when the
  relay refuses — and the per-account token cap does not silently skip. §F4's own semantics are untouched.
  **Session revocation splits by delivery, and the asymmetry is not an oversight.** `temporary-password`
  **always** bumps `sessionEpoch`: it replaces `passwordHash` on the spot, so a surviving session would
  hold a credential that no longer exists. `email` revokes **only** when the admin opts in
  (`revokeSessions`, default off): sending a link changes no credential, so the subject's live sessions are
  still legitimately theirs, and killing them is a deliberate "I believe this account is compromised" act
  rather than a side effect of routine help-desk work. The send happens **before** any revocation, so a
  failed send leaves the account completely untouched and retryable.
  **Link origin.** `WEB_ORIGIN` when pinned. When it is unset **and** `AUTH_TRUST_HOST=true` — the
  host-agnostic LAN deploy of [[0087-plain-http-lan-deployment-axis]], where unset is *correct*, not a
  mistake — the origin is derived from the requesting admin's own request host, which is the only reason
  the email delivery is available on that deployment shape at all. That derivation is confined to this
  authenticated `user:manage` route: a `Host` header shapes a URL landing in someone else's mailbox
  (classic reset poisoning), and it is defensible here only because the header comes from an authenticated
  admin's browser through the terminating proxy. It is **never** wired into the anonymous forgot flow,
  which stays `WEB_ORIGIN`-only. Otherwise → `origin-unknown`.
  **Upgrade-safety.** The request body is optional and the response is a superset of the old one, so an
  API updated ahead of the web build keeps today's exact behavior (CLAUDE.md §8). OIDC/BYOI are byte-
  identical; an explicit `delivery` there is a 400 rather than a silently ignored field. Availability is
  published on a new `GET /users/password-reset-capabilities` behind `user:manage` — deliberately **not**
  on the `@Public` `GET /config/status`, since whether an instance has working outbound email is not
  anonymous-readable operational detail.
- **Escape hatch:** a one-shot **recovery CLI** (`bun` script) resets a named admin's `passwordHash`
  directly against the DB — the only recovery when the last admin forgets their password and no SMTP
  exists ([[0079-instance-smtp-outbound-email]] pending).
- **Seed:** never seeds a password-bearing admin in prod (`/setup`/CLI only). Dev convenience gains a
  `SEED_ADMIN_PASSWORD` opt-in, gated to non-production (the [[0016-auth-strategy-deferred]]/#333 lesson).

### 6. Frontend + the first-run "inicio"

- Auth.js gains a **Credentials provider** beside `oidc`; its `authorize()` calls `POST /auth/login` and
  stores the API-minted token as `session.accessToken` — the entire downstream (Bearer forwarding, the
  `proxy.ts` gate, 401 handling) is already mechanism-agnostic and **unchanged**.
- `ConfigStatus` gains an **`authMode: 'oidc' | 'local'`** field so the UI can branch.
- **`/login`:** username/email + password form (local) vs. the SSO button (oidc), by `authMode`.
- **`/setup`:** a third branch — "create the first ADMIN (name, email, **password**)" — inheriting the same
  CSRF + rate-limit + any-admin-exists-409 + audit guards as today (parity test required).
- **Cookie posture:** the session cookie is `HttpOnly` + `SameSite` **always**; `Secure` is keyed to the
  **actual request scheme**, not `NODE_ENV` (otherwise a prod-over-HTTP LAN deploy sets `__Secure-` cookies
  that never persist → silent login failure).

### 7. Reconciling the Secret Manager zero-knowledge premise (INV-10)

[[0061-secret-manager-zero-knowledge]] §3 and [[0066-secret-manager-password-vs-recovery-root]] both rest
on *"lazyit never receives the login credential."* **Local mode breaks that premise** — the server now
receives a login password on every login. This ADR amends both:

- **INV-10 holds**: the server still never receives or derives the vault DEK / private key. The Secret
  Manager password (Copy-A wrap) remains a **separate, separately-entered** credential.
- The login `passwordHash` and the vault-passphrase machinery are kept **code-separate** (the login module
  is forbidden from touching vault key material, guarded like `inv-10.guard.spec`).
- **UX** presents the two as distinct credentials and **discourages reuse** (reusing the login password as
  the vault passphrase erodes INV-10's "survives full-server-compromise" guarantee in practice — worse over
  HTTP). Users in local mode therefore juggle two passwords by design; this is accepted.

## Consequences

**Reused unchanged** (the payoff of the authN/authZ split): all of RBAC v2 (`RolesGuard`,
`PermissionResolverService`, `@RequirePermission`), the `Principal` union + `@CurrentUser`/`@CurrentPrincipal`,
the SA-token scheme, every domain module, the audit trail, the Bearer-forwarding/gate/401 web plumbing, and
the entire OIDC path for instances that stay on it.

**Amended ADRs:** [[0016-auth-strategy-deferred]] (superseded — local auth is now built),
[[0037-idp-choice-zitadel-byoi]]/[[0043-zitadel-source-of-truth]] (Zitadel is now opt-in, not mandatory),
[[0038-jit-user-provisioning]] (JIT is OIDC-only; local provisions explicitly),
[[0039-authjs-v5-frontend-oidc]] (a Credentials provider joins the OIDC one),
[[0047-guided-first-deploy-bootstrap]] (a third IdP choice + `AUTH_MODE` write + Caddy/compose notes),
[[0058-user-manager-and-clone-actions]] (`username` is a login identifier *in local mode*),
[[0061-secret-manager-zero-knowledge]]/[[0066-secret-manager-password-vs-recovery-root]] (§7 reconciliation).

**Infra consequences (must ship with the mode, else they break deploys):** a new
`infra/docker-compose.oidc.yaml` overlay carries the `api`/`web` → `zitadel-bootstrap` `depends_on`
(else the profile flip is parse-fatal for existing deploys); zitadel services move to a **bare**
`profiles:[oidc]` (profiles are OR-ed — the `[prod, oidc]` shape would fail to be opt-in); the backup
sidecar's cron becomes mode-aware (it currently dumps `zitadel_db` unconditionally → nightly FAILED in
local mode); the Caddy `auth.{domain}` block is mode-gated (502s + wastes ACME in local mode); the CI
boot-smoke (#929) is extended to cover `AUTH_MODE=local` (it never calls `bootstrap()` today);
`dev-setup` defaults to local (a real DX win — drops the `zitadel`/`zitadel_db` containers, the health
poll, and the `jq`/`curl` host-tool requirement), with `--zitadel` as opt-in.

**New security surface lazyit now owns** (previously delegated to Zitadel): password storage, session
issuance/revocation, brute-force defense, reset flows, and — deferred — MFA. This is a real increase in
security-critical code; the SA-token scheme is the trusted precedent to model on.

### Phased plan

- **F0 (this ADR)** — decisions locked; ADRs superseded/amended.
- **F1 — backend core:** the three-column migration + the mode-marker migration; `LocalCredentialService`;
  `POST /auth/login` + HS256 session; the guard `handleLocal`; three-state `boot-config` + the signing-secret
  refine; `requiresAdminPassword` decoupling; the **set-password primitive**; first-admin bootstrap; the
  recovery CLI. Tests (cross-mode rejection, null-hash fail-closed, enumeration/timing, last-admin, INV-10
  separation).
- **F2 — frontend + inicio:** Credentials provider, `ConfigStatus.authMode`, the cookie-scheme fix, the
  `/login` and `/setup` branches, Manual (en + es).
- **F3 — infra:** the `oidc` overlay + `--profile oidc`, `start.sh` three-way (AUTH_MODE explicit), the
  local-default `dev-setup`, the mode-gated Caddy block, the mode-aware backup, the runbook + upgrade note.
- **F4 — password lifecycle:** self-service change + forgot/reset-token, SMTP-gated email reset. Shipped
  in two parts — **F4a (backend, #1003):** `POST /auth/{change,forgot,reset}-password`, the same-password
  rejection, the reset-token sweep-on-change, and the `MustChangePasswordGuard` (`403
  { code: 'PASSWORD_CHANGE_REQUIRED' }` on non-exempt routes; exempt: change-password, `GET /users/me`,
  public). **F4b (frontend, #1004):** the profile change-password panel, the blocking `/change-password`
  forced-change wall (interception wired into the TanStack query/mutation `onError` seam alongside the
  global-401 handler — a hard navigation the user cannot click past), the public `/forgot-password` +
  `/reset-password` pages linked from local `/login`, and Manual (en + es). All local-mode-gated; the
  OIDC path is byte-identical (the guard never fires in OIDC, so the web interception is inert).
- **Follow-up (separate ADR/issue):** plain-HTTP-on-LAN — a deployment-TLS axis distinct from `AUTH_MODE`.
  **Done (#1035):** [[0087-plain-http-lan-deployment-axis]] — a host-agnostic `lan` mode + `start.sh
  --reconfigure`.

## Non-goals

- **MFA/TOTP for local mode** — deferred; password-only is accepted for the target segment in v1.
- **Mixed OIDC + local users on one instance** — one mode per instance, immutable.
- **Plain-HTTP-on-LAN** — a third, orthogonal deployment axis (not implied by `AUTH_MODE=local`, which
  keeps the internal-CA TLS default). It is a real security-posture decision (credentials in cleartext on
  the LAN) and gets its own ADR; local mode + that follow-up together deliver the "just works on a LAN"
  experience. **Now decided in [[0087-plain-http-lan-deployment-axis]]** (#1035): a `lan` network mode
  (host-agnostic HTTP, requires `AUTH_MODE=local`) + `start.sh --reconfigure`.
