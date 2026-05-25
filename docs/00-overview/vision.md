---
title: Vision
tags: [overview]
status: draft
created: 2026-05-25
updated: 2026-05-25
---

# Vision

**lazyit** is an internal web application for IT / Systems teams — helpdesk, support,
infrastructure. It is the single place where a small IT team manages everything technical
in a company: asset inventory, application access, datacenter, backups, switches and Cisco
gear, laptops, licenses, tickets, requests, and internal documentation.

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
- **Self-hosted** — runs inside the company, for internal use.

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
- Multi-tenant SaaS — lazyit is single-org, self-hosted.

Related: [[problem-space]] · [[competitors]] · [[asset-centric]]
