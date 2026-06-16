---
title: Vision
tags: [overview]
status: draft
created: 2026-05-25
updated: 2026-06-16
---

# Vision

**lazyit** is an internal web application for IT / Systems teams — helpdesk, support,
infrastructure. It is the single place where a small IT team manages everything technical
in a company: asset inventory, application access, datacenter, backups, switches and Cisco
gear, laptops, licenses, requests, and internal documentation.

## Who it is for

Small teams of **5–20 people** who own *all* of a company's technology. They are
generalists under load: the same person provisions a laptop, approves a SaaS seat, files a
change on a switch, and writes the runbook for it. Tooling overhead is a tax they cannot
afford.

## Positioning

Inspired by ServiceNow, but deliberately different:

- **Modern** — current aesthetics and UX, not enterprise legacy.
- **IT-native** — built around IT objects (assets, access, consumables), not a generic
  ticketing tool bent into shape.
- **Lightweight and opinionated** — a curated set of capabilities, not a thousand toggles.
- **Self-hosted** — runs inside the company, not a third-party cloud.

## Deployment model

lazyit is headed toward a **self-hosted product for IT teams** — one instance per organization,
run inside the customer. The immediate step is **internal validation** (own / former company)
before any external distribution. Self-hosting is the right default for this segment: the data
(inventory, access, credentials-adjacent records) is sensitive, AD/LDAP integration is expected,
and compliance often forbids keeping it off-premises — with clear market precedents (Snipe-IT,
GLPI, Zammad, Authentik). **Multi-tenant SaaS is deferred** — not designed for now, revisitable
later. Full rationale: [[0015-deployment-model]]; authentication direction:
[[0016-auth-strategy-deferred]].

## Principles

1. **Asset-centric.** The asset is the first-class citizen of the system, not the user.
   See [[asset-centric]] for the full rationale.
2. **Auditability by default.** Nothing is hard-deleted; history is automatic. See
   [[conventions]].
3. **Opinionated over configurable.** Sensible defaults beat infinite settings.
4. **Boring, durable technology.** A small team should be able to operate this for years.

## Non-goals (for now)

- Public/customer-facing service portal (this is internal).
- ITIL-complete process certification.
- Multi-tenant SaaS — **deferred**, not now; lazyit ships single-org and self-hosted
  ([[0015-deployment-model]]).
- **Ticketing system** — lazyit will NOT have a dedicated ticketing pillar. CEO decision
  2026-06-16: the product is IT-native (assets, access, consumables, KB) and deliberately
  not a generic ticket tool. The `Ticket`/`TicketComment` entities were never built; they
  are removed from the domain.

Related: [[problem-space]] · [[competitors]] · [[asset-centric]]
