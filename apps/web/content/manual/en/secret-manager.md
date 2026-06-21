---
title: Security model
order: 3
category: secret-manager
subcategory: security-model
---

# Security model

The Secret Manager keeps your team's **shared secrets** in **vaults** that only their members can read.
What makes it different from anywhere else you might stash a password is the security guarantee behind
it. This page explains that guarantee, what it protects you from, and the one case it cannot save you
from.

For day-to-day tasks, see [Vaults & members](/help/secret-manager-vaults-members) and
[Passwords & recovery keys](/help/secret-manager-passwords-recovery-keys).

## lazyit cannot read your secrets

> **The Secret Manager is end-to-end encrypted.** Secret values are only ever readable in your browser,
> by a member of the vault. lazyit stores them in a form it **cannot** decrypt — not the server, not an
> administrator, and not a database backup can reveal a secret value. This is the whole point of the
> feature, and it shapes how recovery works.

Encryption and decryption happen **on your device**. Your password and your recovery key never leave
your browser. The server's job is to **store and serve** the encrypted data and to enforce *who may
fetch which vault*; it is structurally incapable of producing a plaintext value.

This is a deliberate trade-off. Because there is no master key on the server, there is **no back door** —
and that is exactly what makes the guarantee trustworthy.

## What is and isn't hidden from lazyit

Not everything is hidden — some labels have to be visible so the app can show you a list and so
administrators can manage access.

| Visible to lazyit (labels / metadata) | Never readable by lazyit |
| --- | --- |
| Vault **names** and **member lists** | Secret **values** |
| Secret **labels** and **handles** | Your **password** and **recovery key** |

Because names, members and handles are visible, **name vaults and secrets plainly — never put a secret
value in a label or a name.**

## Two layers of access

Reaching the Secret Manager and decrypting a vault are **two separate things**:

1. **Permission to enter** — an administrator grants the Secret Manager capability. This lets you reach
   the Secret Manager and see that vaults exist (their names and members). On its own it reveals **no**
   secret values.
2. **Vault membership** — to actually **decrypt** a vault's secrets, you must be a **member** of that
   vault (see [Vaults & members](/help/secret-manager-vaults-members)).

These can disagree, and one consequence matters: **removing someone's permission to enter does not
cryptographically lock them out of a vault they were already a member of.** The server will refuse
their requests, but the only way to truly cut off a vault is to **revoke their membership** — and, for
a real compromise, to **rotate the underlying credential**. An administrator can see every vault's name
and members and manage who may enter, but an administrator who was never made a member of a vault
**cannot read its secrets**.

## Recovering access — and the one case you can't

Because lazyit cannot read your secrets, recovery is something you and your team do, not something the
server can do for you. There are three situations:

- **You lost your password but have your recovery key.** Use the recovery key to **reset your password**
  ([Passwords & recovery keys](/help/secret-manager-passwords-recovery-keys)). You are back in, and your
  vault access is intact.
- **You lost both, but the vault has other members.** Set yourself up with a fresh password and
  recovery key, and a current member of each vault **grants you access again**. No one ever learns your
  password to do this — they simply re-share the vault with your new identity.
- **You lost both, and you were the vault's only member.** This is the one case with no way back. If the
  **only** member of a vault loses **both** their password and their recovery key, **the vault cannot be
  recovered** — not by a teammate, not by an administrator, not by lazyit. There is no back door; that
  is what makes the encryption trustworthy.

## Protect yourself from permanent loss

Two simple habits prevent the unrecoverable case:

- **Keep your recovery key safe and off the system.** It is your personal backup — store it where a
  server breach or a database loss cannot touch it. It is shown only once, at setup.
- **Don't leave a vault that matters with only one member.** Add a second member to any important vault
  so a teammate can restore your access if you ever lose your keys. lazyit warns you when a vault has
  only one member — take the hint before it is too late.

## The session locks itself when you step away

Once you unlock the Secret Manager, your key stays available in the browser so you don't have to re-enter
your password for every secret. To protect an unattended screen, the session **locks itself
automatically after about 15 minutes of inactivity** — and sooner if you leave the tab hidden for a
minute or so. When it locks, every revealed value is hidden and the in-memory key is dropped; you simply
unlock again with your password to continue. Any activity (typing, clicking, scrolling) resets the timer,
and you can always lock immediately with the **Lock** action.

## When a secret may be exposed

Removing a member, or even deleting a secret, stops **future** reads through lazyit — it does not
"un-tell" a value someone already saw. If you suspect a credential has been exposed, the real
remediation is the one it has always been: **change the underlying credential** (rotate the actual
password, re-issue the key) at its source.
