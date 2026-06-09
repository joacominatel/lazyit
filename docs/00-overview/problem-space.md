---
title: Problem Space
tags: [overview]
status: draft
created: 2026-05-25
updated: 2026-06-08
---

# Problem Space

## The situation

A small IT team owns a sprawl of heterogeneous things — laptops, servers, switches,
licenses, SaaS seats, AD groups, cables and toner — plus the requests and incidents that
swirl around them. The knowledge of "what we have, where it is, and who can touch it"
lives in spreadsheets, someone's head, and a chat history.

## Why it hurts

- **No single source of truth.** Inventory, access, and tickets live in different tools
  (or no tool), so reconciliation is manual and audits are painful.
- **People rotate, assets persist.** Ownership knowledge evaporates when someone leaves.
  The recurring question "who has asset X / who can access app Y?" has no reliable answer.
- **Onboarding/offboarding is error-prone.** Granting and (critically) *revoking* access
  is ad hoc, which is both a productivity and a security problem.
- **No history.** "What changed, when, by whom?" cannot be answered, so root-cause and
  compliance both suffer.

## Why existing tools don't fit

- **Too expensive / heavy** — ServiceNow and peers are priced and scoped for large
  enterprises; a 5–20 person team drowns in them.
- **Too generic** — Jira / Linear are great at issues but know nothing about IT objects;
  you bolt assets and access on with custom fields and discipline that erodes.
- **Too narrow** — Snipe-IT does inventory well but stops there; access, tickets and
  knowledge live elsewhere.

See [[competitors]] for the detailed comparison.

## The bet

A focused, IT-native, asset-centric system (see [[asset-centric]]) that unifies inventory,
access, tickets, consumables and knowledge — with auditability built in — is more valuable
to a small IT team than any of the generic or narrow alternatives, and far cheaper to run
than the enterprise suites.

And where the ad-hoc grant/revoke pain above bites hardest, an opt-in
[[workflow-engine/_MOC|Workflow Engine]] now automates provisioning and deprovisioning into the
external systems — without ever blocking or rolling back the access record itself.

Related: [[vision]] · [[competitors]] · [[asset-centric]]
