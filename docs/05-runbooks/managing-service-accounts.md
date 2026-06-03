---
title: Managing service accounts
tags: [runbook, auth, authz, service-accounts, security]
status: accepted
created: 2026-06-03
updated: 2026-06-03
---

# Managing service accounts

How to give **automation** (a CI runner, a nightly script, an integration) its own least-privilege API
credential — without minting a human [[user]] or sharing an OIDC token. The model is
[[0048-service-accounts]]; the entity is [[service-account]].

> [!important] The token is shown **ONCE**
> On create and on rotate, the full token `lzit_sa_<id>_<secret>` is displayed **exactly once** and is
> **never recoverable** — only a SHA-256 hash is stored. If you lose it, you **rotate** (you cannot
> retrieve it). Copy it straight into your secret store.

## Who can manage them

All `/service-accounts` operations are gated `@RequirePermission('settings:manage')` — **ADMIN-only** in
the default seed ([[0046-roles-permissions-v2]]). Manage them from the web at
**`/settings/service-accounts`** (or via the API below).

## Create

**Web:** `/settings/service-accounts` → **New** → name + (optional) description → pick the exact
permissions it needs (from the same catalog humans use) → **Create**. The token is revealed once — copy
it now.

**API:**

```sh
curl -sS -X POST https://<host>/api/service-accounts \
  -H "Authorization: Bearer <your-admin-oidc-token>" \
  -H "Content-Type: application/json" \
  -d '{ "name": "ci-asset-registrar",
        "description": "registers freshly-imaged assets",
        "permissions": ["asset:read", "asset:write"] }'
# → 201 { ...account, token: "lzit_sa_<id>_<secret>" }   ← the ONLY time you see the token
```

**Scoping (least privilege):**

- Grant only the `domain:action` permissions the automation actually needs (e.g. `asset:write`,
  `consumable:write`, `accessGrant:grant`). The catalog is the same one the
  [[role-permission]] matrix uses; see [[authorization]] for the full list.
- A service account is **never** ADMIN, **never** has a `Role`, and is **fail-closed**: it can call ONLY
  `@Public` routes and routes whose permission it **fully holds** — an unannotated route returns **403**
  ([[INVARIANTS]] INV-SA-2/INV-SA-3). So grant deliberately; a missing permission is a 403, not a
  silent pass.
- **Cannot author KB articles.** `Article.authorId` is a human-only FK, so an SA hitting an article
  write gets 403 by design ([[INVARIANTS]] INV-SA-4) — don't use a service account for KB authoring.

## Use the token

The automation sends the token as a Bearer credential:

```sh
curl -sS https://<host>/api/assets \
  -H "Authorization: Bearer lzit_sa_<id>_<secret>"
```

The guard's SA branch verifies it DB-first (constant-time hash compare), updates `lastUsedAt`, and
authorizes the request against the account's direct grants. A missing/revoked/inactive/expired account →
a **generic 401** (no enumeration oracle).

## Rotate (the secret leaked, or routine hygiene)

Rotation mints a **new** secret (shown once) and **immediately invalidates the old one**.

**Web:** the account's row → **Rotate** → copy the new token → update your secret store.

**API:**

```sh
curl -sS -X POST https://<host>/api/service-accounts/<id>/rotate \
  -H "Authorization: Bearer <your-admin-oidc-token>"
# → 200 { ...account, token: "lzit_sa_<id>_<new-secret>" }   ← shown once
```

There is **no forced expiry** in v1, but you may set an optional `expiresAt` via `PATCH` (a past value →
401). Rotation cadence is left to you — rotate on suspicion of leak and on a schedule you set.

## Edit permissions / disable / expiry

`PATCH /service-accounts/:id` (web: **Edit**) changes the name, description, the `permissions[]` set,
`isActive` (a soft disable without deleting), or `expiresAt`. Every change is audited
([[service-account-audit-log]], `PERMISSION_CHANGE`).

## Revoke (and restore)

**Revoke** = soft-delete: the account can no longer authenticate (its token 401s), but its **audit
attribution is preserved** (past actions stay attributed to it on the audit-bearing tables —
[[INVARIANTS]] INV-SA-4).

**Web:** the account's row → **Revoke**. **Restore** un-revokes it (the *same* token works again — revoke
does not rotate). To revoke **and** invalidate the credential, **rotate** as well.

**API:**

```sh
curl -sS -X DELETE  https://<host>/api/service-accounts/<id> -H "Authorization: Bearer <admin>"   # revoke
curl -sS -X POST    https://<host>/api/service-accounts/<id>/restore -H "Authorization: Bearer <admin>"  # restore
```

## Audit

Every lifecycle action (mint/rotate/revoke/restore/permission-change) appends an immutable
[[service-account-audit-log]] row — the secret is **never** recorded. The *domain* actions a service
account performs are attributed to its `serviceAccountId` actor column on the 6 audit-bearing tables
([[service-account]]).

> [!note] An SA self-managing service accounts records `actorId = null`
> If you let a service account manage *other* service accounts, the audit row records `actorId = null`
> (honest — it wasn't a human, and there is no SA actor column on that log yet; a follow-up ADR adds it).

## Common operations at a glance

| Goal | Web | API |
| --- | --- | --- |
| Create + get token (once) | New → set permissions | `POST /service-accounts` |
| Leaked / routine rotate | Rotate (token once) | `POST /service-accounts/:id/rotate` |
| Change scope / disable / expiry | Edit | `PATCH /service-accounts/:id` |
| Revoke (keep audit) | Revoke | `DELETE /service-accounts/:id` |
| Restore | Restore | `POST /service-accounts/:id/restore` |
| List (incl. revoked) | the list page | `GET /service-accounts?includeRevoked=true` |

Related: [[service-account]] · [[service-account-permission]] · [[service-account-audit-log]] ·
[[authorization]] · [[role-permission]] · [[0048-service-accounts]] · [[0046-roles-permissions-v2]] ·
[[INVARIANTS]] · [[deploy-self-hosted]]
