---
title: "ADR-0015: Deployment model — self-hosted for IT teams"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0015: Deployment model — self-hosted for IT teams

## Status

accepted

## Context

We needed to settle *who runs lazyit and where*, because it drives current design decisions
(auth, identity, multi-tenancy) far more than any single feature. The dilemma is **multi-tenant
SaaS** vs **self-hosted product**:

- The data lazyit holds — asset inventory, application access, credentials-adjacent records — is
  **sensitive**; serious IT teams do not want it in a third party's cloud.
- **AD/LDAP integration** is effectively mandatory in this segment.
- **Compliance**: many companies cannot keep this kind of data off-premises.
- The market has clear self-hosted precedents: **Snipe-IT, GLPI, Zammad, Authentik, Sentry**
  (self-hosted).

If we silently designed for SaaS now (tenant scoping everywhere, a hosted identity provider),
we would add complexity that fights the self-hosted target and the "boring, durable,
single-org" stance in [[vision]].

## Considered options

- **Self-hosted product for IT teams** — one instance = one organization, run inside the
  customer. Matches the data-sensitivity / compliance / AD-LDAP realities. *(chosen)*
- **Multi-tenant SaaS now** — design tenant isolation, hosted auth, billing from day one.
  Maximum reach, but contradicts the segment's needs and front-loads large complexity.
- **Internal-only tool (no product ambition)** — simplest, but throws away the obvious
  mid-term opportunity and would bake in internal-only assumptions.

## Decision

- **Primary target: self-hosted** product for small IT teams (the mid-term direction).
- **Initial validation: internal** (own / former company) before any external distribution.
- **SaaS multi-tenant: deferred** — possible in the *far* future, but we **do not design for it
  now**. We leave only minimal, cheap signals so we don't slam the door (see Consequences).

## Consequences

- **Auth:** we will integrate with the customer's **external IdP** (OIDC / SAML / LDAP) when the
  time comes — we do **not** implement our own password/sessions, and we do **not** use a SaaS
  auth provider (Auth0/Clerk) because it ties the product and kills self-hosting. The full
  reasoning and interim state are in [[0016-auth-strategy-deferred]]; the concrete provider is a
  separate future ADR.
- **Identity:** the local [[user]] is the domain projection of a person. [[user]] gains a
  nullable, unique `externalId` so a future IdP `sub` can map onto it — the only schema signal we
  add now.
- **No `Organization` / `tenantId`** is introduced now (YAGNI). This is **deliberate**: do not add
  them "just in case". Revisit only when a concrete requirement demands them.
- **Trade-off accepted:** if we ever pursue multi-tenant SaaS, it will be a **major refactor**
  (tenant scoping across the schema and queries). We knowingly accept that cost over carrying
  unused multi-tenancy complexity now.

## Open questions

- **Default IdP for self-hosted** — which provider we recommend/ship as default
  (Authentik / Keycloak / Zitadel / equivalent). A separate, future decision.
- **Licensing / branding** — how we handle licensing and branding once lazyit leaves purely
  internal use (open / source-available / commercial?).

Related: [[vision]] · [[0016-auth-strategy-deferred]] · [[user]] · [[deployment]] · [[stack]]
