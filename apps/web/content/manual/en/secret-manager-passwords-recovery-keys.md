---
title: Passwords & recovery keys
category: secret-manager
subcategory: passwords-recovery-keys
order: 2
---

# Passwords & recovery keys

To use the Secret Manager you set up two credentials, **once**, the first time you open it. They are
specific to the Secret Manager and are **not** your sign-in password. Together they protect your access
to every vault you belong to.

- **Password** — your **daily key**. You enter it to unlock the Secret Manager in a session, and again
  to reveal a secret inline in a Knowledge Base article. You can **change** it whenever you like.
- **Recovery key** — your **backup key**. It is a long, one-time code shown in the format
  `XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`. Its only job is to **reset your password** if you forget it. It is
  not a second daily key — you do not use it to unlock day to day.

Think of it as: the **password is the door you use every day**, and the **recovery key is the master
key in the safe** that lets you fit a new lock if you ever lose your daily key.

## First-time setup

The first time you open the Secret Manager, lazyit asks you to **set up your password**. Choose
something strong and memorable (at least 8 characters). Your password is never sent to the server.

Immediately after, lazyit shows you your **recovery key**.

> **The recovery key is shown exactly once.** lazyit displays it during setup and **never shows it
> again** — it is not stored anywhere lazyit can read. Save it somewhere safe and **off the system**: a
> password manager, or a printed copy in a secure place. You confirm you have saved it before
> continuing. If you later lose your password and you do not have your recovery key, no one can reset
> it for you.

## Unlocking day to day

When you return, the Secret Manager is **locked**. Enter your **password** to unlock it for your
session. You can lock it again at any time, which clears the in-memory key. The recovery key is **not**
used here — only your password unlocks day to day.

## Changing your password

Use **Change password**, enter your **current password**, then choose a new one. Your access to every
vault carries over and your recovery key is unaffected — nothing else changes. This is the routine way
to rotate your Secret Manager password.

## Resetting a forgotten password

If you have forgotten your password but you still have your **recovery key**, choose
**Forgot your password?** at the unlock screen. Enter your recovery key and set a new password. You are
**signed in automatically** once it is reset — your access to every vault is intact.

A few things to know:

- The recovery key **resets** the password; it is not a way to log in directly.
- The recovery key is **fixed when you first set up** the Secret Manager. It cannot be regenerated
  using your password, so keep the copy you saved at setup safe.
- Whoever holds your recovery key can reset your password and take over your vaults — that is exactly
  why it is high-entropy, shown once, and meant to live off the system, not in daily use.

## If you have lost both

If you have lost **both** your password and your recovery key, choose
**I lost both my password and recovery key** at the unlock screen. This sets you up with a brand-new
identity. **You will lose access to every vault until a current member of each vault grants you access
again** — coordinate with your team before doing this. What happens next, and the one case that cannot
be recovered at all, is covered in [Security model](/help/secret-manager).
