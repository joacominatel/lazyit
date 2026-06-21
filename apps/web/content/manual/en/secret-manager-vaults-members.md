---
title: Vaults & members
category: secret-manager
subcategory: vaults-members
order: 1
---

# Vaults & members

The **Secret Manager** is where your team keeps **shared secrets** — the credentials an IT team passes
around: a shared root password, a VPN pre-shared key, a registrar login. It is a separate area from the
Knowledge Base. The **Knowledge Base** holds your runbooks; the **Secret Manager** holds the
credentials those runbooks need. You reach it from the Secret Manager area in the app.

Secrets are never stored where lazyit can read them — they are encrypted in your browser before they
are saved, and lazyit cannot decrypt them. See [Security model](/help/secret-manager) for what that
means in practice.

## Vaults vs the Knowledge Base

A **vault** is a named container for secrets, shared with a list of **members**. Only members of a
vault can read the secrets inside it.

| | Knowledge Base | Secret Manager |
| --- | --- | --- |
| Holds | Articles, runbooks, documentation | Credentials and secret values |
| Shared by | Folder access | Vault membership |
| Readable by lazyit | Yes (it renders the article) | **No** — values are encrypted on your device |

A Knowledge Base article can **point to** a secret without copying the value into the article — see
[Secret references](/help/secret-manager-secret-references).

## Creating a vault

1. Open the Secret Manager. The first time, you set up a password — see
   [Passwords & recovery keys](/help/secret-manager-passwords-recovery-keys).
2. Choose **New vault**, give it a short, descriptive name (for example, "Production credentials"),
   and create it. You become its first member automatically.

The vault **name** and its **member list** are visible to administrators and to anyone managing the
Secret Manager — they are labels, not secrets. **Name vaults plainly and do not put a secret in the
name.**

## Adding secrets to a vault

Open a vault and choose **Add secret**. Each secret has:

- a **Label** — a human-readable name, for example "Cloudflare API key";
- a **Handle** — a short machine identifier (lowercase letters, numbers, underscores, dots and
  hyphens), used to reference the secret from Knowledge Base articles;
- a **Secret value** — the credential itself.

The value is encrypted in your browser before it is stored. To read a secret later, open the vault and
choose **Reveal value**; **Copy value** puts it on your clipboard. A revealed value hides itself again
after a few seconds, and a copied value is **cleared from the clipboard automatically after about 30
seconds** so the plaintext does not linger after you paste it. This auto-clear is **best-effort**: your
browser may not allow it (for example over plain HTTP, or if another app or a clipboard manager has
already captured the value), so treat it as a convenience, not a guarantee — paste promptly. You can
edit a secret's label or handle, replace its value, or delete it.

## Searching a vault

A vault with more than a handful of secrets shows a **search box** above the list. It filters by
**label** and **handle** as you type — the non-secret names, never the values. Searching never decrypts
anything; it just narrows what's on screen.

## Bulk-importing from a .env file

To onboard an application's secrets all at once instead of one at a time, open a vault and choose
**Import**. Paste your `KEY=value` lines (or **upload a `.env` file**) and lazyit shows a **preview**
before anything is saved:

- how many keys are **new** and will be imported;
- how many are **skipped** because a secret with that handle already exists — import **never overwrites**
  an existing secret;
- any lines it couldn't parse (these are ignored).

It understands the common `.env` shape: `KEY=value`, `export KEY=...`, single- or double-quoted values,
`# comments` and blank lines. Each imported value is **encrypted in your browser** before it is stored —
the same as adding a secret by hand, so lazyit never sees the plaintext.

## Exporting a vault to a .env file

To back up a vault, seed an app's `.env`, or hand secrets to a developer, open a vault and choose
**Export**. lazyit **decrypts the secrets in your browser** and downloads them as a `.env` file.

> **Export writes your secrets in PLAINTEXT to your device.** Anyone who can read the downloaded file
> can read the secrets. Store it somewhere safe and delete it once you're done. lazyit records *that*
> you exported (who, which vault, when) for the audit trail — but, true to the security model, it never
> sees the values themselves.

## Adding and revoking members

Vaults are shared by managing **members**:

- **Grant access** — open a vault, choose **Grant access**, and pick a person. They gain the ability
  to read the vault's secrets. You can only grant access to a vault you are a member of yourself — you
  cannot share access you do not have. The person must have opened the Secret Manager and set up their
  own password at least once; if they haven't, lazyit tells you to ask them to do so first.
- **Revoke access** — choose **Revoke access** next to a member to remove them. They can no longer
  read the vault's secrets. A vault must always keep at least one member, so you cannot revoke the
  last one — add another member first.

> **Revoking stops future access; it does not "un-tell" a secret.** Removing a member prevents them
> from reading the vault going forward, but it cannot undo a value they have already seen. If a
> credential may have been exposed, the real fix is the same as it has always been: **change the
> underlying credential** (for example, rotate the actual password).

## Don't leave an important vault with one member

lazyit warns you when a vault has only **one member**. A single-member vault has no one who can restore
access if that person loses their credentials — see [Security model](/help/secret-manager) for the one
case that cannot be recovered. **Add a second member to any vault that matters.**
