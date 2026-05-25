---
title: "ADR-0012: Testing strategy"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0012: Testing strategy

## Status

accepted

## Context

We need a testing policy now, before the domain is implemented, so testing is deliberate
rather than ad hoc. The product's value is in its **core logic** (asset lifecycle,
ownership/assignments, access grants, stock ledgers) — that is what must not break. This
policy is part of how we work; see [[claude-workflow]].

## Considered options

- **Coverage:** hard global threshold (e.g. 80% repo-wide) · gate scoped to core packages ·
  rigor on core via review with no blunt global gate.
- **E2E:** adopt Playwright now · adopt later when flows exist · none for now.
- **Frontend unit runner:** Vitest · `bun test` · Jest · defer until components carry logic.

## Decision

- **Unit tests always.** Every change ships with unit tests. **Complex / core business
  logic gets thorough, many-cased testing** (edge cases, invariants). Priority is the
  **application core** (domain rules, services), not scaffolding or presentational UI.
- **Runners:**
  - **API (`apps/api`):** Jest — already the stack ([[0002-nestjs-backend]], [[0009-bun-first-vs-app-stack]]).
  - **`packages/shared`:** `bun test` (pure, framework-agnostic logic — see [[shared-package]]).
  - **Frontend (`apps/web`):** **deferred** — no frontend unit tests yet; revisit (and pick a
    runner) when components carry real logic.
- **E2E:** **none for now.** Choose a tool (Playwright a likely candidate) once there are
  critical user flows worth covering end to end.
- **Coverage:** **rigor on the core, no blunt global gate.** Core/complex logic must be
  well-covered, enforced via review; we deliberately avoid a repo-wide percentage threshold
  (it rewards trivial tests). A coverage gate scoped to core packages may be added later.

## Consequences

- **Positive:** effort goes where risk is (core logic); no metric-gaming; tooling matches
  each workspace's stack.
- **Trade-offs:** "well-covered core" is judgement-based (lives in review, see
  [[claude-workflow]]); UI/e2e gaps are accepted for now and must be revisited.
- **Follow-ups:** revisit the **frontend runner** and **e2e tool** when UI grows; consider a
  core-scoped coverage gate in CI then.
