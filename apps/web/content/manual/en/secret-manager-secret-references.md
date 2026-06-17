---
title: Secret references
category: secret-manager
subcategory: secret-references
order: 4
---

# Secret references

A Knowledge Base article often documents a procedure that needs a credential — "log in with the
registrar password", "use the VPN pre-shared key". Instead of pasting the secret into the article
(which would turn the Knowledge Base into an unprotected secret store), you **reference** it. The
article shows a **masked chip** in place of the value, and only a vault member can reveal it.

## Adding a reference

In a Knowledge Base article, reference a secret by its **handle** using the token:

```
{{ lazyit_secret.HANDLE }}
```

where `HANDLE` is the handle of a secret in one of your vaults (for example,
`{{ lazyit_secret.cloudflare_api_key }}`). The handle is the secret's identifier — **not** its value.
When you type `{{ lazyit_secret.`, the editor offers the handles of secrets you can reach, so you do not
have to remember them. Autocomplete lists **handles only, never values**.

The reference is stored as plain text in the article. It carries no secret — the value is fetched and
decrypted only when someone reveals the chip.

## How the chip behaves for a reader

When the article is displayed, the token becomes a small inline **chip**. What a reader sees depends on
their access:

- **A key chip (revealable).** The reader is a member of the secret's vault. Clicking **Reveal** (and,
  if the Secret Manager is locked, entering their password) shows the value **inline, in their browser**.
  Clicking again hides it; **Copy** puts it on the clipboard.
- **A locked chip.** The reader can open the article but is **not** a member of the secret's vault. They
  see the handle and a padlock, and cannot reveal anything.
- **A broken chip.** The handle does not match any current secret — for example, it was renamed or
  deleted. The chip is flagged so an author can fix the reference.

## The two-key rule

Revealing a referenced secret requires access to **both**:

1. the **article** — through its Knowledge Base folder access; **and**
2. the secret's **vault** — through vault membership.

Embedding a secret in an article therefore **never widens who can read it**. A reader who can open the
article but is not a vault member only ever sees a locked chip. Granting and revoking access to the
secret is still done in the vault (see [Vaults & members](/help/secret-manager-vaults-members)), not in
the article.

## What never touches the server in clear

When a chip is revealed, the value is decrypted **in the reader's browser** — it never round-trips
through the server as plaintext. This is the same end-to-end guarantee as the rest of the Secret
Manager: referencing a secret from an article does not make it readable by lazyit. See
[Security model](/help/secret-manager) for the full picture.
