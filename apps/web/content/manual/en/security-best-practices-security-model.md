---
title: Security model
category: security-best-practices
subcategory: security-model
order: 1
---

# Security model

This page explains, in plain terms, how lazyit decides **who you are** and **what you're allowed to
do**. You don't need to configure any of it to be safe — these are sensible defaults — but knowing
how it works helps you run the instance well.

## Identity comes from your provider, not from lazyit

lazyit does **not** store sign-in passwords. Authentication is delegated to an **identity provider
(IdP)** that speaks OIDC — either the sign-in service bundled with lazyit, or your own provider
(your company SSO). You choose which on the first run; see
[Getting started](/help/getting-started).

That single decision shapes the whole security model:

- **Your provider owns the login credential.** When you use your own provider, lazyit never sees,
  sets, or stores a sign-in password. Password rules, multi-factor, lockout policy, and account
  resets all live with that provider — configure them there.
- **lazyit trusts the identity your provider asserts.** After a successful sign-in, lazyit identifies
  you by the stable account identifier the provider sends, not by anything a user can type. It treats
  that provider as the source of truth for *who is signing in*.

> Because identity is delegated, the strength of your sign-in is the strength of your IdP. Enable
> multi-factor authentication and a sane password policy **in your provider** — that is where those
> controls belong.

## Accounts are matched by verified email

The first time someone signs in through your provider, lazyit links that sign-in to a lazyit user
record by **verified email**. This lets you pre-create a person in lazyit and have their account
"just work" the first time they sign in.

Two safeguards make this safe:

- **The email must be verified by your provider.** An unverified email is never linked to an existing
  account — so someone signing up with an address they don't own cannot inherit another person's
  record.
- **An email already linked to one sign-in is never re-bound to a different one.** A returning
  sign-in cannot take over an account, and an offboarded person's record is never resurrected by a
  later sign-in.

## What you can do is decided by lazyit, not by your token

Once you're signed in, **lazyit decides your permissions from its own database** — your role and the
permissions behind it (see [Permissions](/help/permissions)). It does **not** read your role or your
rights from the sign-in token.

This matters: even if a token were misconfigured or tampered with, it cannot grant powers inside
lazyit. Your abilities come from your lazyit role, which only an administrator can change. It also
keeps lazyit portable across identity providers — a generic OIDC provider doesn't need to know
anything about lazyit roles.

## Sessions

After you sign in, you hold a session in your browser. Signing out ends it. Day-to-day, that session
is what proves who you are to lazyit; the heavy lifting of *proving identity* already happened at your
provider.

The **Secret Manager** has its own, separate unlock on top of your sign-in: it is end-to-end
encrypted, so even when you're signed in you must unlock it with a password that is specific to the
Secret Manager and never leaves your browser. See [Secret Manager](/help/secret-manager) for how that
works and why even an administrator cannot read your secrets.

## What this gives you

- **No password database to leak.** lazyit holds no sign-in passwords — there is nothing to steal
  there.
- **One place to enforce sign-in policy** — your identity provider — instead of two.
- **Tamper-resistant authorization** — your rights are read from lazyit's database, never from a
  token a client could forge.
- **Honest secrets** — the Secret Manager is encrypted so that the server itself cannot read your
  shared credentials.
