---
title: "ADR-0016: Authentication deferred; external IdP when needed"
tags: [adr]
status: superseded
created: 2026-05-25
updated: 2026-05-30
deciders: [Joaquín Minatel]
---

# ADR-0016: Authentication deferred; external IdP when needed

## Status

superseded by [[0037-idp-choice-zitadel-byoi]] / [[0039-authjs-v5-frontend-oidc]] (auth
implemented) — the deferral this ADR described is over. lazyit now authenticates via **OIDC**:
Zitadel is the bundled default IdP with a BYOI contract ([[0037-idp-choice-zitadel-byoi]]), the
API validates Bearer JWTs and JIT-provisions users ([[0038-jit-user-provisioning]]), and the
Next.js frontend logs in via Auth.js v5 ([[0039-authjs-v5-frontend-oidc]]). The IdP `sub`→
`User.externalId` mapping and `externalId` being server-owned (decided below) were carried
forward unchanged. The decision body is kept for the historical record.

> [!warning] Body describes a pre-auth world
> This ADR says "no authentication yet / endpoints are open / do not expose this build publicly".
> That posture **no longer holds** — see the auth trio above. The `AUTH_MODE=shim` dev path is
> the only place the old unauthenticated behaviour survives, and it is dev/test only.

The deferral originally reframed the earlier "NextAuth vs better-auth" open question noted in
[[stack]] and [[0010-nextjs-frontend]]: we will **not** build our own auth with those; we
integrate with an external IdP. Follows the deployment model in [[0015-deployment-model]].

## Context

There is **no authentication yet**. The current API endpoints are **open** (no guards). We need
to state that status explicitly and decide the direction so nobody fills the gap ad hoc or bolts
on a SaaS auth provider that would undermine self-hosting ([[0015-deployment-model]]).

## Considered options

- **Implement our own auth now** (password + sessions + MFA). Large surface, security-sensitive,
  and largely thrown away once we integrate with a customer's IdP. Premature.
- **Adopt a SaaS auth provider** (Auth0 / Clerk). Fast, but ties the product to a hosted service
  and is incompatible with the self-hosted target ([[0015-deployment-model]]).
- **Defer, and design for an external IdP** — keep a single cheap signal (`externalId`) now,
  integrate via OIDC with a self-hosted IdP later. *(chosen)*

## Decision

- **Defer full auth** until the first endpoint that genuinely depends on real identity exists.
- Until then, the **local [[user]] is the source of truth** for the domain.
- [[user]] carries **`externalId` (nullable, unique)**, prepared to hold the IdP `sub` when auth
  arrives. Nullable because there is no auth today; unique because once populated it must be 1:1.
  It is **server-owned**: never accepted from a create/update body — the future IdP integration
  provisions it. `CreateUserSchema` omits it and, being a `strictObject`, rejects a client-supplied
  value, so a caller cannot pre-link a local row to a future federated identity (SEC-006).
- **Do not** implement our own password / sessions / MFA.

## Consequences

- **Current endpoints are for local development only** — they are unauthenticated. Treat them
  accordingly (see [[user]] and [[setup]]); do not expose this build publicly.
- When auth lands it will be an **OIDC integration with a self-hosted IdP** (Authentik / Keycloak
  / equivalent — **TBD**, its own future ADR). The IdP `sub` maps to `User.externalId`.
- No interim guard/middleware is added by this ADR (out of scope); endpoint protection is part of
  the future auth work.

## Open questions

- **IdP / provider choice** — Authentik vs Keycloak vs Zitadel vs equivalent (future ADR, shared
  with the default-IdP question in [[0015-deployment-model]]).
- **Interim protection** — whether the dev build needs any stopgap protection before the real
  integration (currently: none; dev-only).

Related: [[0015-deployment-model]] · [[user]] · [[stack]] · [[0010-nextjs-frontend]]
