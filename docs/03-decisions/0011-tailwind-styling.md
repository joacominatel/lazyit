---
title: "ADR-0011: Tailwind CSS + shadcn/ui for styling"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-05-25
deciders: [Joaquín Minatel]
---

# ADR-0011: Tailwind CSS + shadcn/ui for styling

## Status

accepted — Tailwind confirmed; shadcn/ui is the intended component layer (not yet installed).

## Context

The product aims for a modern, consistent, opinionated UI ([[vision]]) built by a small
team. We want fast iteration, a shared design language, and to avoid bikeshedding CSS
architecture. Tailwind v4 is already wired into `apps/web` ([[stack]]).

## Considered options

- **Tailwind CSS (utility-first)** — speed, consistency via design tokens, no naming/CSS
  architecture overhead; pairs with shadcn/ui for accessible, copy-in components. Cons:
  verbose class lists; utility approach is divisive.
- **CSS Modules** — scoped, framework-native. Cons: slower to build a consistent system; no
  ready component layer.
- **CSS-in-JS (styled-components/emotion)** — co-located styles. Cons: runtime cost, weaker
  fit with React Server Components ([[0010-nextjs-frontend]]).
- **Vanilla CSS / Sass** — full control. Cons: we own the whole system; slowest path to a
  coherent UI.

## Decision

**Tailwind CSS v4** for styling, with **shadcn/ui** as the planned component layer (Radix +
Tailwind, copy-into-repo components we own and restyle). shadcn/ui is the intended approach
but is **not yet installed** — adopt when UI work starts.

## Consequences

- **Positive:** fast, consistent UI; design tokens centralize the look; shadcn/ui gives
  accessible primitives without a heavy dependency we can't control.
- **Trade-offs:** utility-class verbosity; shadcn/ui components are owned/maintained in-repo
  (a feature, but it is upkeep).
- **Follow-ups:** install/configure shadcn/ui when UI begins; document component conventions
  in [[code-conventions]] at that point.
