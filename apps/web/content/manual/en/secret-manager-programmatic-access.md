---
title: Programmatic access (service accounts)
category: secret-manager
subcategory: programmatic-access
order: 5
---

# Programmatic access (service accounts)

Sometimes a **script or a deploy pipeline** needs a vault's secrets — a CI job that injects environment
variables, an Ansible run, a container that reads its config on startup. Instead of a person copy-pasting
values, a **service account** can pull them over the API and a small command-line tool decrypts them on
your machine into a `.env` file.

The important guarantee is unchanged: **lazyit still cannot read your secrets.** The server only ever
hands back **encrypted** data; the decryption happens on your machine, with the service account's token.
See [Security model](/help/secret-manager) for what "the server can't read them" means.

## How it works, in one picture

A service account gets its **own encryption key**, exactly like a person does. You then **add the service
account to a vault** (the same "add member" action you use for people). From then on, a headless tool can
fetch that vault's encrypted secrets and unlock them locally:

1. The service account's private key is locked with its **token** (the `lzit_sa_…` credential shown once
   when you create it).
2. Adding the service account to a vault wraps that vault's key to the service account — the standard
   grant. You can only do this for a vault **you can already read**.
3. The `lazyit-fetch` tool sends the token to the API, gets back **only ciphertext**, and unlocks it on
   the deploy machine.

Because the key is **per vault**, a token can read **only the vault(s) that service account was added to** —
never everything. If you want tighter isolation, put sensitive secrets in a **separate vault** and add the
service account only there.

## Step 1 — Create the service account and its key

1. In **Settings → Service accounts**, create a service account and grant it the **Fetch secrets
   programmatically** permission (`secret:fetch`). This is the only secret permission a service account can
   hold — it can never be given the human "view" or "manage" permissions.
2. On creation the app also generates an **encryption keypair** for the service account, locked with its
   token. **Copy the token now** — it is shown once and is what the fetch tool uses to decrypt. If you lose
   it, rotate the service account (which re-issues the key) and add it to the vaults again.

## Step 2 — Add the service account to a vault

1. Open the vault in the **Secret Manager** and use **Add service account** in the members area.
2. Pick the service account. Your browser re-encrypts the vault's key to the service account's key — so, as
   always, **you can only grant a vault you can read yourself.**

The service account now appears as a machine member of that vault. Revoke it any time with the member's
remove action (this stops future reads; rotate the underlying credential if you suspect the token leaked).

## Step 3 — Fetch secrets on the deploy machine

Use the **`lazyit-fetch`** command-line tool (in `packages/fetch-cli`). Give it the token, the API URL and
the vault id:

```sh
# The token is read from an env var so it never lands in your shell history or `ps` output.
export LAZYIT_SA_TOKEN="lzit_sa_…"
export LAZYIT_API_URL="https://lazyit.example.com/api"

# Write a .env file in the current directory:
lazyit-fetch --vault <vaultId> --out .env

# …or print to stdout to compose with other tools:
lazyit-fetch --vault <vaultId> > .env

# List the vaults this service account may fetch:
lazyit-fetch --list

# Verify the tool's crypto without touching the server:
lazyit-fetch --self-check
```

Each secret becomes one line, `HANDLE=value`. The **handle** is upper-cased and non-alphanumeric
characters become `_`, so `prod-db-password` becomes `PROD_DB_PASSWORD`. Choose handles that make good
environment-variable names.

## What the server sees, and what it doesn't

- The server returns **ciphertext only** — the encrypted values plus the encrypted keys the tool needs. It
  **never** returns a plaintext value, and it never decrypts one.
- Every programmatic fetch is **recorded** — which service account read which vault, and when.
- The **token is the key.** Anyone who holds it can decrypt that vault's secrets, so treat it like the
  secrets themselves: keep it in a secure environment variable, scope each service account to only the
  vaults it needs, and rotate it if it may have leaked.
