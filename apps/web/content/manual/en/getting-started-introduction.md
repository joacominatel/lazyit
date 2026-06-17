---
title: Introduction
order: 1
category: getting-started
subcategory: introduction
---

# Introduction

lazyit is a single place for a small IT team to manage everything technical in a company: asset
inventory, application access, consumables, and an internal knowledge base. It is built for the
generalists who run all of a company's technology — the same person who provisions a laptop, approves
a SaaS seat, and writes the runbook for it.

> This Manual documents *lazyit itself*. The in-app **Knowledge Base** documents *your estate* — your
> runbooks, procedures, and notes. Keep the two straight: this is the product manual, the Knowledge
> Base is your team's wiki.

## Who it is for

Small IT / Systems teams of roughly **5–20 people** who own all of a company's technology. lazyit is
intentionally lightweight and opinionated: a curated set of capabilities with sensible defaults, not
a thousand toggles to configure. If you have drowned in enterprise tooling overhead, that is the pain
it is built to remove.

## What lazyit is

- **Asset-centric.** The **asset** is the first-class citizen — not the person. Assets persist while
  people rotate, so lazyit records ownership as a timestamped assignment rather than a column on the
  asset. Reassign or return an asset and the history is kept automatically; "who had this laptop, and
  when?" always has an answer.
- **Self-hosted, single-organization.** lazyit runs inside your company — one instance per
  organization — because the data it holds (inventory, access, credential-adjacent records) is
  sensitive. There is no shared multi-tenant cloud.
- **Auditable by default.** Domain records are never hard-deleted; they are archived (soft-deleted)
  and can be restored. History and activity are recorded as you work, so "what changed, when, and by
  whom?" can be answered after the fact.
- **Unified.** Inventory, application access, consumables, and knowledge live in one tool instead of
  scattered across spreadsheets, chat history, and someone's memory.

## What lazyit is NOT

- **Not a ticketing system.** lazyit deliberately has no ticketing pillar. It is built around IT
  objects — assets, access, consumables, knowledge — not around tickets and queues.
- **Not a customer-facing portal.** It is an internal tool for your IT team, not a public service desk
  for end customers.
- **Not a multi-tenant SaaS.** lazyit ships single-organization and self-hosted; running many
  customers from one shared instance is out of scope.
- **Not your identity provider.** lazyit does not own login passwords. Sign-in is delegated over OIDC
  to an identity provider — either the bundled one it ships with, or your own. See
  [Initial setup](/help/getting-started) for the choice.

## The main areas

- **Assets** — the inventory of laptops, servers, network gear, licenses, and anything else you track,
  with models, categories, locations, and assignment history.
- **Users & access** — the people in your organization, their roles, and which applications they can
  reach.
- **Consumables** — stock you draw down, such as cables and toner, with movements and low-stock
  alerts.
- **Knowledge Base** — your team's articles and runbooks, organized into folders with access control.
- **Secret Manager** — shared, end-to-end encrypted vaults for credentials your team holds in common.

## Next steps

- Stand up a fresh instance: [Initial setup](/help/getting-started).
- Add your team: [Users & team](/help/getting-started-users-team).
- Work in English or Spanish: [Languages](/help/getting-started-languages).
