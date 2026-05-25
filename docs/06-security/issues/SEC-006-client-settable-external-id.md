---
id: SEC-006
title: externalId (the future IdP linkage) is settable by clients on POST /users
severity: low
status: open
cwe: CWE-639
discovered: 2026-05-25
module: users
tags: [mass-assignment, auth, account-takeover, forward-looking]
---

# SEC-006 — Client-settable externalId enables IdP account pre-linking

## Summary

`POST /users` accepts `externalId` from the request body. That field is reserved to hold the IdP `sub`
once auth lands (ADR-0016); letting clients set it now means a pre-created local row can claim a future
federated identity.

## Description

`CreateUserSchema` includes `externalId` (`packages/shared/src/schemas/user.ts:33`) and the service
persists the body as-is (`users.service.ts:28-30`). `externalId` is unique and, per ADR-0016, maps 1:1
to the IdP `sub` when OIDC is integrated. If a caller creates a user with
`externalId = "<victim-oidc-sub>"` today, then when auth is wired and a login resolves
`token.sub → User.externalId`, that login binds to the attacker-seeded row (with attacker-chosen
email/name) — an account pre-takeover / authorization-by-user-controlled-key problem. `UpdateUserSchema`
correctly omits `externalId`; only create is affected. Inert today (no auth), but the field is the
exact hinge the auth migration depends on.

## Impact

Low now (no auth; the whole API is open anyway). Becomes a real account-linking/takeover risk the
moment OIDC maps `sub → externalId`, unless the integration ignores/overwrites client-set values. Filed
now because it is a quiet, cheap-to-fix precondition the auth work would otherwise inherit.

## Proof of concept

Reasoned, **not executed**:

```sh
curl -X POST http://localhost:3001/users -H 'content-type: application/json' \
  -d '{"email":"a@b.c","firstName":"A","lastName":"B","externalId":"victim-idp-sub"}'
```

## Affected

- `packages/shared/src/schemas/user.ts:33` — `externalId` in `CreateUserSchema`.
- `apps/api/src/users/users.service.ts:28-30` — `create` persists the body verbatim.

## Recommendation

- Drop `externalId` from `CreateUserSchema` (never accept it from a body). Provision it server-side
  only, by the IdP integration, when auth lands.
- Add a regression test asserting a client-supplied `externalId` is ignored/rejected.

## Prevention

Treat identity-linkage fields (`externalId`, future `sub`, any role/permission field) as server-owned:
never in a create/update DTO. Note this in ADR-0016 so the auth work doesn't re-open it.

## References

- CWE-639: Authorization Bypass Through User-Controlled Key. CWE-294 (account pre-hijacking class).
- ADR-0016 (auth deferred; externalId) · ADR-0022 (author from shim, not body — same principle).

## Triage note

🚨 Escalated to user on 2026-05-25 — touches the **auth contract** (`externalId` is the IdP `sub`
hinge, ADR-0016) and the **shared contract** (`web` consumes `CreateUserSchema`). Per the
remediation rules, auth-contract changes are your decision. The fix is otherwise small and the
direction (server-owned `externalId`) aligns with ADR-0016 / DEF-002 / DEF-005.

Options:

1. **Drop `externalId` from `CreateUserSchema`** (the finding's recommendation) — never
   client-settable; the future IdP integration provisions it server-side. Cleanest, but a
   shared-contract change (a `web` "create user" form sending it would break) and removes the only
   current way to set `externalId`.
2. **Keep the field but strip/ignore it in `UsersService.create`** — no contract change for web, but
   the field stays visibly settable and silently dropped (its own footgun).

Recommendation: (1), plus a note in ADR-0016 that `externalId` is server-owned (provisioned by the
IdP integration, never accepted from a body). I can implement (1) + a regression test + the ADR note
on your go-ahead — please confirm no current `web` flow POSTs `externalId`.
