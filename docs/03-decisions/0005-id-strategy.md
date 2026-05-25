---
title: "ADR-0005: Mixed ID strategy (uuid / cuid / autoincrement)"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0005: Mixed ID strategy (uuid / cuid / autoincrement)

## Status

accepted

## Context

Different entities have different exposure and access patterns. Sensitive/exposed records
should not be enumerable; high-volume logs want cheap ordered keys; most domain rows want a
compact non-sequential id.

## Considered options

- **One strategy everywhere** (e.g. all `uuid`, or all `autoincrement`). Simpler, but either
  leaks enumeration on exposed entities or wastes the benefits where they'd help.
- **Per-purpose strategy** — pick the id type per entity role.

## Decision

Per-purpose:

| Strategy | Used for | Why |
| --- | --- | --- |
| `uuid()` | sensitive/exposed — primarily [[user]] | non-enumerable, safe in URLs/tokens |
| `cuid()` | most domain entities — [[asset]], [[ticket]], … | compact, collision-resistant |
| `autoincrement()` | logs/history — [[asset-history]], audit, ledgers | cheap, ordered, never exposed |

Documented in [[conventions]].

## Consequences

- **Positive:** right trade-off per entity; no enumeration on exposed rows; cheap log keys.
- **Trade-offs:** two+ id types to keep straight; the rule must be explicit (it is, in
  [[conventions]]).
- **Follow-ups:** confirm [[article-version]] id type at implementation (autoincrement vs cuid
  depending on external referencing).
