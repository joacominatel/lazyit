---
title: Secret Manager
order: 1
category: secret-manager
subcategory: security-model
---

# Secret Manager

The Secret Manager is where your team keeps **shared secrets** — the kind of thing an IT team passes
around: a shared root password, a VPN pre-shared key, a registrar login. It is separate from the
Knowledge Base: the Knowledge Base holds your runbooks, the Secret Manager holds the credentials
those runbooks need.

Secrets live in **vaults**. A vault is a named container with a list of **members**. Only members of
a vault can read the secrets inside it.

> **lazyit cannot read your secrets.** The Secret Manager is end-to-end encrypted. Secret values are
> only ever readable in your browser by a member of the vault — lazyit stores them in a form it
> cannot decrypt. Not the server, not an administrator, and not a database backup can reveal a secret
> value. This is the point of the feature, and it shapes how recovery works (below).

## Your password and your recovery key

To use the Secret Manager you set up two credentials, **once**, the first time you open it. They are
specific to the Secret Manager and are **not** your sign-in password.

- **Password** — your **daily key**. You enter it to unlock the Secret Manager in a session. You can
  **change** it whenever you like (you need your current password to do so).
- **Recovery key** — your **backup key**. It is a long, one-time code shown in the format
  `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. Its only job is to **reset your password** if you forget it. It is
  not a second daily key — you do not use it to unlock day to day.

> **The recovery key is shown exactly once.** lazyit displays it when you first set up the Secret
> Manager and **never shows it again** — it is not stored anywhere lazyit can read. Save it somewhere
> safe and off the system: a password manager, or a printed copy in a secure place. If you lose your
> password and you do not have your recovery key, no one can reset it for you.

Think of it as: the **password is the door you use every day**, and the **recovery key is the master
key in the safe** that lets you fit a new lock if you ever lose your daily key.

## Day-to-day use

- **Unlock** — enter your password to unlock the Secret Manager for your session.
- **Change your password** — enter your current password, then a new one. Your access to every vault
  carries over; nothing else changes.
- **Reset your password** — if you have forgotten your password, use your **recovery key** to set a
  new one. After a reset you are unlocked straight away.

## Sharing a vault

Vaults are shared by adding **members**:

- **Add a member** — any current member of a vault can grant access to another person. You can only
  add someone to a vault you can read yourself — you cannot share access you do not have.
- **Revoke a member** — remove someone from a vault and they can no longer read its secrets.

> Revoking a member stops future access through lazyit. It does not "un-tell" a secret someone
> already read. If a credential may have been exposed, the real fix is the same as it has always been:
> **change the underlying credential** (for example, rotate the actual password).

## Recovering access — and the one case you can't

Because lazyit cannot read your secrets, recovery is something you and your team do, not something the
server can do for you. There are three situations:

- **You lost your password but have your recovery key.** Use the recovery key to reset your password.
  You are back in.
- **You lost both, but the vault has other members.** Another member can **restore your access** to
  each vault: you set up a fresh password and recovery key, and a peer re-shares each vault with you.
  No one ever learns your password to do this.
- **You lost both, and you were the vault's only member.** This is the one case with no way back. If
  the **only** member of a vault loses **both** their password and their recovery key, **the vault
  cannot be recovered** — not by a teammate, not by an administrator, not by lazyit. There is no back
  door; that is what makes the encryption trustworthy.

### Protect yourself from permanent loss

Two simple habits prevent the unrecoverable case:

- **Keep your recovery key safe and off the system.** It is your personal backup — store it where a
  server breach or a database loss cannot touch it.
- **Don't leave a vault that matters with only one member.** Add a second member to any important
  vault so a teammate can restore access if you ever lose your keys. lazyit warns you when a vault
  has only one member — take the hint before it is too late.
