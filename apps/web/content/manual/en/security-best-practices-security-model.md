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

## How you sign in

Sign-in works one of two ways, chosen once when the instance is deployed; see
[Getting started](/help/getting-started).

- **Local accounts (the default).** lazyit owns sign-in. It stores each password only as an
  **argon2id hash** — a slow, salted, one-way fingerprint — never the password itself, so nobody, an
  administrator included, can read a password back. Repeated failed sign-ins are slowed down and
  rate-limited, and lazyit issues its own signed session. Sign-in is password-only in this version.
- **Your own OIDC provider.** Authentication is delegated to an **identity provider (IdP)** you run,
  such as your company SSO. lazyit never sees, sets, or stores a sign-in password: password rules,
  multi-factor, lockout policy, and account resets all live with that provider — configure them there.
  lazyit trusts the identity your provider asserts: after a successful sign-in, it identifies you by
  the stable account identifier the provider sends, not by anything a user can type.

> With local accounts, the strength of your sign-in is the strength of your passwords — use long,
> unique ones. With your own provider, it is the strength of your IdP: enable multi-factor
> authentication and a sane password policy **there**. If you need multi-factor today, connect your
> own provider.

## Accounts are matched by verified email (OIDC)

The first time someone signs in through your own provider, lazyit links that sign-in to a lazyit user
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
is what proves who you are to lazyit; the heavy lifting of *proving identity* already happened at
sign-in.

On an instance with **local accounts**, a session lasts 12 hours unless the person ticks **Keep me
signed in**, which keeps it until they sign out. Such a session has no time limit behind it, so it is
meant for personal, trusted devices only. Signing out ends a person's sessions on **every** device, and
so do a password change or reset, deactivation and offboarding. See
[Your profile](/help/getting-started-your-profile) for what people see.

**AI apps connected over MCP are not sessions.** Signing out does not disconnect them; a password change
or reset, deactivation and offboarding do, and each person can revoke one at any time. See
[What ends a connection](/help/ai-assistant-connected-apps#what-ends-a-connection).

The **Secret Manager** has its own, separate unlock on top of your sign-in: it is end-to-end
encrypted, so even when you're signed in you must unlock it with a password that is specific to the
Secret Manager and never leaves your browser. See [Secret Manager](/help/secret-manager) for how that
works and why even an administrator cannot read your secrets.

## The AI assistant and external agents

AI is off until an administrator turns it on, and it never widens anyone's rights: the in-app assistant,
external agents over MCP and headless service-account runs all act **as** a person or service account,
checked by lazyit on every call exactly like a click in the app. What changes is where data goes and who
decides:

- **Data leaves to the AI provider.** Whatever the assistant reads for a person — any record that person
  can see — is sent to the provider the administrator chose, under your contract with it. Secrets never
  are. Read [What leaves your server](/help/ai-assistant-overview#what-leaves-your-server) before
  enabling it.
- **Text can try to steer the model** (prompt injection). The in-app assistant cannot change anything
  without an approval card built by lazyit from the real change; a change proposed after reading
  someone else's content is flagged and never auto-approved; privilege and identity changes need the
  person's password. See [How lazyit keeps the assistant in check](/help/ai-assistant-overview#how-lazyit-keeps-the-assistant-in-check).
- **External agents decide for themselves.** Over MCP, the client — not lazyit — asks before a change,
  and lazyit data goes to the client's own provider. Admin-level access is never preselected and needs a
  password. See [Before you connect](/help/ai-assistant-claude-code-mcp#before-you-connect-what-you-are-trusting).

## What this gives you

- **No readable passwords.** With local accounts lazyit keeps only argon2id hashes; with your own
  provider it holds no sign-in passwords at all.
- **One place to enforce sign-in policy** — lazyit with local accounts, or your identity provider —
  never two.
- **Tamper-resistant authorization** — your rights are read from lazyit's database, never from a
  token a client could forge.
- **Honest secrets** — the Secret Manager is encrypted so that the server itself cannot read your
  shared credentials.
