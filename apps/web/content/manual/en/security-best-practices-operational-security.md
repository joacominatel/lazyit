---
title: Operational security
category: security-best-practices
subcategory: operational-security
order: 3
---

# Operational security

Running lazyit safely is mostly about a few habits: backing up the right things, keeping recovery
material off the system, and knowing what to do when something is exposed. This page is the
operator's checklist.

## Back up everything needed to recover — not just the database

The single most common disaster-recovery mistake is backing up only the application database.
A working restore needs **more than that**:

- **The application database** — your assets, users, access, Knowledge Base, and the *encrypted*
  Secret Manager data.
- **Your identity provider's data** — if you run the bundled sign-in service, its accounts and keys
  live separately. Restore the app database without it and everyone is locked out.
- **Your environment / secrets file** — the deployment secrets (database password, encryption keys
  for the sign-in service and for workflow connector credentials, the app secret). Some of these keys
  **cannot be regenerated**: restore a database without the matching key and that data is
  unreadable.

Treat the secrets file as **irreplaceable**: keep an encrypted copy **off the host**, and never let
the running server be its only copy. Test a restore before you rely on lazyit for real — an untested
backup is a guess.

> The deployment-and-operations section of this Manual covers the mechanics of backing up and
> restoring. The point here is the **scope**: database **plus** identity-provider data **plus** the
> secrets file, kept together and kept off-host.

## Secret Manager recovery is the operator's responsibility — and it's different

The Secret Manager is **end-to-end encrypted**: the server can never read your shared secrets (see
[Secret Manager](/help/secret-manager)). That has a sharp consequence for disaster recovery that
every operator must understand:

- **A perfect database-and-secrets restore does *not* make vaults readable again.** The restore
  brings back encrypted data only. There is no server-side key over secret values to recover with —
  by design.
- **The recovery material is held by users, not by you.** Each person's **recovery key** is their
  personal backup, shown **once** when they first set up the Secret Manager and never stored anywhere
  the server can read. You cannot back it up for them.
- **A single-member vault that loses both its password and its recovery key is gone for good** — no
  restore, no administrator, and no support can recover it.

What this means operationally:

- **Make "store your recovery key off the system" part of onboarding.** It is a personal duty, not
  an operator backup item. A password manager or a printed copy in a safe place is fine.
- **Keep important vaults multi-member.** A second member can restore a teammate's access after a
  reset. lazyit warns when a vault has only one member — act on that warning.

## Incident response: what to do when access is exposed

When a credential or an account may have been exposed, work in this order.

### A person leaves, or an account is compromised

1. **Offboard or disable the account** so they can no longer sign in. In lazyit, offboarding a user
   removes their access; if you run your own provider, also disable them there.
2. **Revoke their application access and vault membership.** Removing a person from a vault stops them
   reaching its secrets through lazyit going forward.

### A shared secret may have leaked

Revoking access in lazyit stops *future* access — it does **not** un-tell a secret someone already
saw, and it does not retroactively re-encrypt what they could already read. So for a credential that
may genuinely be exposed:

> **Rotate the underlying credential.** Change the actual password, key, or token at the source, then
> update it in lazyit. That is the only real remediation — and it's true of any password manager, not
> just lazyit.

### A deployment secret or key may have leaked

If a deployment secret (a database password, an encryption key, an OIDC client secret) may be
exposed, rotate what *can* be rotated and re-deploy. Note that a couple of encryption keys are
**unrotatable by design** — losing or leaking them is serious, which is exactly why they belong in an
encrypted, off-host backup and on a tightly controlled host.

## Everyday hygiene

- **Keep the administrator count small** and review it periodically. Each admin is a high-value
  account.
- **Give each automation its own service account** with the narrowest permissions, and rotate its
  token if it may have been exposed.
- **Offboard promptly.** Because ownership and access in lazyit follow the live user, removing a
  person cleanly removes their reach.
- **Keep your identity provider patched and protected** — it's the front door, and lazyit trusts it.
