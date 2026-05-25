---
title: "ADR-0004: Asset-centric domain design"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0004: Asset-centric domain design

## Status

accepted

## Context

We must decide what the domain orbits around. In internal IT, assets persist while people
rotate, and the key audit question is "what do we have and where is it?" ([[problem-space]]).

## Considered options

- **User-centric** — model around people, attach assets to users. Cons: ownership knowledge
  evaporates as people leave; weak answer to inventory/audit questions.
- **Ticket-centric** — model around work items (the Jira/ServiceNow default). Cons: inventory
  and access become second-class custom fields ([[competitors]]).
- **Asset-centric** — the [[asset]] is the first-class citizen; users, tickets and access
  attach to it. Ownership is a timestamped join ([[asset-assignment]]).

## Decision

Asset-centric. Full rationale in [[asset-centric]]. Ownership lives in
[[asset-assignment]] (history automatic); state changes in [[asset-history]].

## Consequences

- **Positive:** strong inventory/audit answers; ownership and state history fall out
  naturally; stable model as people rotate.
- **Trade-offs:** users are peripheral to assets but central to access — two orientations to
  keep coherent ([[user]]).
- **Follow-ups:** asset↔user cardinality resolved (2026-05-25) as **concurrent M:N** — an
  asset may have multiple active owners; see [[asset-assignment]].
