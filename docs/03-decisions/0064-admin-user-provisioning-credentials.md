---
title: "ADR-0064: Admin user provisioning credentials — temporary password only, forced change at first login"
tags: [adr, users, auth, zitadel, provisioning, byoi, rbac, frontend, backend]
status: accepted
created: 2026-06-14
updated: 2026-06-14
deciders: [Joaquín Minatel]
---

# ADR-0064: Admin user provisioning credentials — temporary password only, forced change at first login

## Status

**accepted** — 2026-06-14 (CEO sign-off). Issue #411. A full-page, asset-style user-creation flow whose
**only** credential-provisioning carve-out is a **temporary password with forced change at first login**.
It is a **bounded extension** of the Zitadel-as-identity-source-of-truth arc
([[0037-idp-choice-zitadel-byoi]] / [[0038-jit-user-provisioning]] / [[0043-zitadel-source-of-truth]]),
and reuses the existing `user:manage` permission ([[0046-roles-permissions-v2]]) — no new permission.

> **Scope of this ADR.** A full-page user-creation flow (replacing the current dialog) with optional
> assign-asset / assign-app at create time; a **second, narrow credential carve-out** from
> "lazyit never sets a permanent password" — the admin may set **only a temporary password** with
> **`changeRequired = true`**; **email auto-verify is always-on** for admin-provisioned users; the
> controls are **hidden under BYOI**; and authorization stays on the existing **`user:manage`**.

## Context

User creation today is a **dialog** (`apps/web/app/(app)/users/_components/user-form-dialog.tsx`) that
collects the basics and creates the user. The CEO wants to grow this into a **full-page, asset-style
flow** — the same generous, multi-section create experience assets have — that also lets an admin, at
create time, **assign an asset** and **grant application access**, and **provision the user's first
credential** so the person can actually log in without a separate dance.

The credential part touches the most carefully-guarded contract in the codebase. The identity arc is
explicit and non-negotiable:

- **Zitadel (or a BYOI IdP) is the identity & authorization source of truth**
  ([[0043-zitadel-source-of-truth]]). lazyit **delegates authentication** to the IdP and **never
  receives the login credential** at runtime ([[0016-auth-strategy-deferred]],
  [[0039-authjs-v5-frontend-oidc]]). The standing stance is **"lazyit never sets a password"**
  (ADR-0016/0037).
- There is already **one** deliberate, narrow carve-out of that stance ([[0043-zitadel-source-of-truth]],
  issue #335): the **first-deploy bootstrap wizard** sets an **initial password** on the *first ADMIN*
  with **`changeRequired:false`** (so the operator can sign in immediately on a no-SMTP bundled install).
  That carve-out is scoped to the **management path** (`idp.supportsManagement`, i.e. the **bundled
  Zitadel** lazyit owns) and **never to BYOI**.

The CEO's decision for admin-provisioned users, verbatim:

> *"Solo password temporal"* — **only a temporary password**.

So this is a **second** carve-out, deliberately *narrower* than the bootstrap one: where the wizard sets a
permanent-usable password (`changeRequired:false`) for the very first admin, admin-provisioned users get
a **temporary** password they **must change at first login** (`changeRequired:true`). No preset
permanent passwords for provisioned users — the admin hands out a one-time secret, the user owns their
real credential from first login onward.

## Considered options

- **Temporary password only, `changeRequired = true` (chosen — CEO decision).** The admin may set a
  one-time password on the new (bundled-Zitadel) user; Zitadel forces a change at first login. The
  provisioned credential is never a standing password the admin knows — it is a hand-off secret, replaced
  immediately by the user. Minimal, honest, and the standard "IT provisions a temp password" pattern.
- **Allow a preset permanent password (`changeRequired = false`) — rejected by the CEO.** The original
  issue #411 floated "preset OR temp password". The CEO scoped it to *temp only*: a standing
  admin-known password is a weaker posture (the admin keeps a credential the user thinks is theirs),
  and it is not needed — the bootstrap wizard's `changeRequired:false` exists only because the *first*
  admin has no one to provision them. Every *subsequent* user has an admin to hand them a temp password.
- **No credential provisioning at all (email-invite only) — rejected for the bundled path.** The bundled
  install has **no SMTP** (and never will — [[0043-zitadel-source-of-truth]] §4), so a Zitadel user
  created with only a verified email and no credential lands in the *initialize-by-emailed-code* lockout
  state (the exact #335 bug). For the bundled IdP, the admin **must** be able to set a starting
  credential; a temp password is the safe form of that.
- **A new `user:provision` / `credential:set` permission — rejected.** User administration is already
  gated by the coarse **`user:manage`** verb (ADR-0046 §P4; ADMIN-only by default). Provisioning a user
  *is* user administration. A separate permission adds catalog surface and a golden-test + web-typecheck
  churn for no authorization benefit — the same gate already covers create/update/role/offboard.

## Decision

A **full-page, asset-style user-creation flow** with optional assign-asset / assign-app, whose credential
provisioning is a **bounded carve-out**: **temporary password only, `changeRequired = true`,
email auto-verified, hidden under BYOI, gated by the existing `user:manage`.**

### 1. Full-page creation flow + optional assignments at create time

The dialog (`user-form-dialog.tsx`) grows into a **full-page, asset-style** create flow. In addition to
the identity/role fields, the admin may **optionally**, at create time:

- **assign an asset** (an [[asset-assignment]] — the timestamped-join ownership model,
  [[0019-asset-assignment-integrity]]), and
- **grant application access** (an [[access-grant]], [[0023-access-management-design]]).

These reuse the **existing** assignment/grant write paths and their existing authorization
(`asset` / `accessGrant:grant` permissions) — bundling them into the create flow is a UX convenience, not
a new authorization surface. Each is best-effort relative to the user creation: the user is created
first, then the optional assignment/grant follow (a failed assignment never un-creates the user).

### 2. Credential provisioning — temporary password only, `changeRequired = true`

A **bounded, second carve-out** of the "lazyit never sets a password" stance (the first being the
bootstrap wizard, [[0043-zitadel-source-of-truth]] / #335):

- On the **management path only** (`idp.supportsManagement` — the **bundled Zitadel** lazyit owns), the
  admin may set a **temporary password** on the new Zitadel user, written with **`changeRequired = true`**
  so Zitadel **forces a password change at first login**. The provisioned password is a **one-time
  hand-off secret**, not a standing credential.
- **No preset permanent passwords.** Unlike the bootstrap wizard's `changeRequired:false` (justified
  because the first admin has no one to provision them), every admin-provisioned user gets
  `changeRequired:true`. There is no option to set a permanent password.
- The temporary password is validated against Zitadel's complexity policy (reusing the shared
  password-schema discipline of the setup flow). It is **never persisted or logged by lazyit** — it is
  set on the IdP and shown to the admin to hand off, consistent with the never-log posture
  ([[0031-logging-strategy]]) and the shown-once handling of other provisioned secrets.
- **Mirror-blocks-not-degrades on the management path**, exactly as #335 established: if the Zitadel
  user create/credential-set fails, the just-created local row is **compensated** (the standing
  management-path contract from [[0043-zitadel-source-of-truth]] §4 #2), so a half-provisioned,
  un-loggable user is never left behind.

> **How this differs from the bootstrap carve-out (kept distinct on purpose).**
> | | Bootstrap wizard ([[0043-zitadel-source-of-truth]] / #335) | **Admin provisioning (this ADR)** |
> | --- | --- | --- |
> | Who | the **first ADMIN** (no one to provision them) | any **subsequently-provisioned** user |
> | `changeRequired` | **false** (sign in immediately) | **true** (forced change at first login) |
> | Password kind | initial, usable | **temporary**, one-time hand-off |
> | Path | management (bundled Zitadel) | management (bundled Zitadel) |
> | BYOI | never (no password sent) | never (controls hidden, §4) |

### 3. Email auto-verify — always-on for admin-provisioned users

Admin-provisioned (bundled-Zitadel) users are created **email-verified** (always-on). With no SMTP on
the bundled install ([[0043-zitadel-source-of-truth]] §4), an unverified email would block first login;
the admin is asserting the address on the user's behalf. This mirrors the bootstrap flow's verified-email
handling and is the only sane default for a no-SMTP, admin-driven provisioning path.

### 4. BYOI hides the credential controls

When the instance runs **BYOI** (a customer-brought IdP — `integrationMode != 'zitadel'` /
`!idp.supportsManagement`), provisioning of the credential happens in **that** IdP, not in lazyit. So:

- The full-page flow **hides** the temporary-password and email-verify controls entirely under BYOI
  (driven by the existing `requiresAdminPassword`/`supportsManagement` capability flag from
  `GET /config/status`, the same signal the wizard uses — [[0043-zitadel-source-of-truth]] §4 #1).
- lazyit **sends no password** to a BYOI IdP and shows no credential UI — the operator's directory owns
  the credential lifecycle. This preserves the **BYOI-safe** invariant of the whole auth arc
  ([[0037-idp-choice-zitadel-byoi]] / [[0043-zitadel-source-of-truth]] §6 #4): the management path is
  setup/write-back only, never the runtime authN path, and BYOI degrades gracefully.

### 5. RBAC — reuse `user:manage`, no new permission

The whole flow (create + provision + the bundled assignment/grant convenience) is gated by the
**existing coarse `user:manage`** verb ([[0046-roles-permissions-v2]] §P4 — ADMIN-only by default,
already the gate for create/update/role/offboard/restore). **No new permission catalog entry** is added,
so there is **no golden-test / web-exhaustive-map churn** ([[0046-roles-permissions-v2]] §6). Provisioning
a user is user administration; the existing gate is exactly right.

## Consequences

- **Positive:**
  - A generous, **asset-style** user-creation flow that lets an admin onboard a person end-to-end —
    identity, a starting credential, an asset, app access — in one place.
  - The credential carve-out is **minimal and honest**: a **temporary** password the user must replace at
    first login, never a standing admin-known credential. It closes the no-SMTP first-login lockout (#335)
    for *provisioned* users the same way the wizard closed it for the *first* admin — without weakening
    the posture.
  - **BYOI stays clean** — no credential UI, no password sent; the customer's IdP owns provisioning, and
    the BYOI-safe invariant holds.
  - **No new authorization surface** — reuses `user:manage`; no catalog/golden-test/web-typecheck cost.
  - The identity source-of-truth contract is **respected**: lazyit still never holds the user's *real*
    login credential (the temp password is replaced at first login and never persisted by lazyit), and
    runtime authN is still delegated to the IdP.
- **Negative / trade-offs (accepted):**
  - **A second password carve-out to reason about** — but deliberately *narrower* than the bootstrap one
    (`changeRequired:true`, temp-only), documented side-by-side (§2) so the two never blur.
  - **Management-path-only credential provisioning** — a BYOI admin cannot set a temp password from
    lazyit (correct: their IdP owns it). The flow degrades to identity + assignments under BYOI.
  - **Email auto-verify trusts the admin** asserting the address — acceptable on a no-SMTP, admin-driven,
    single-org install (the same trust the bootstrap flow already takes).
- **Follow-ups:**
  - The full-page user-create route + form (replacing the dialog) with the optional asset/app assignment
    sections; the backend temp-password (`changeRequired:true`) + always-verified provisioning on the
    management path (with the §2 compensate-on-failure), capability-gated by `requiresAdminPassword`; the
    BYOI control-hiding; tests for the temp-password forced-change, the email-verified default, the BYOI
    no-credential path, and the `user:manage` gate.

**Related:** #411 · [[0037-idp-choice-zitadel-byoi]] · [[0038-jit-user-provisioning]] ·
[[0043-zitadel-source-of-truth]] · [[0046-roles-permissions-v2]] · [[0016-auth-strategy-deferred]] ·
[[0039-authjs-v5-frontend-oidc]] · [[0019-asset-assignment-integrity]] ·
[[0023-access-management-design]] · [[0031-logging-strategy]] · [[user]] · [[INVARIANTS]]
