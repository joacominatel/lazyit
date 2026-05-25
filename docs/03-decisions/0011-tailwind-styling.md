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

accepted — Tailwind v4 + shadcn/ui both **installed and configured** in `apps/web`
(`radix-nova` preset, Radix primitives, `neutral` base color, CSS variables).

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

**Tailwind CSS v4** for styling, with **shadcn/ui** (Radix primitives) as the component
layer — copy-into-repo components we own and restyle, living in `apps/web/components/ui/`.
As of 2026-05 this is **installed and configured**, not just planned.

Concrete setup (shadcn CLI `v4.8.0`, which is now **preset-driven** rather than a flat
`--base-color` flag):

- **`radix-nova` preset** — the *Nova* style on **Radix** primitives (`shadcn init -b radix`),
  chosen over the newer **Base UI** option (`base-nova`) to honour the Radix decision in this
  ADR. Note: `--defaults` maps to `base-nova` (Base UI), so the Radix base must be passed
  explicitly.
- **`neutral` base color**, **CSS variables**, Tailwind v4 tokens in `oklch` (light + dark in
  `app/globals.css`). Neutral grayscale keeps the look clean and IT-native, not flashy.
- **Typography: Geist + Geist Mono** (`next/font/google`) — the font the Nova preset assumes;
  neutral, technical and legible at small sizes for data-dense tables.
- **Dark mode** via `next-themes` — system default + manual toggle, persisted to
  `localStorage`.

### Icons — Heroicons only (with one boundary)

App-authored UI uses **`@heroicons/react` exclusively**; we do **not** introduce
`lucide-react`, `react-icons` or any other icon set in our own code.

The catch: shadcn/ui's `iconLibrary` only supports `lucide` or `radix` — **not** Heroicons —
and the vendored primitives import Lucide internally (dialog close, dropdown chevrons/checks,
sonner status glyphs). We adopt the **"Option A" pragmatic boundary**: `lucide-react` stays
installed but lives **only inside `components/ui/*`**, treated as an implementation detail of
those vendored files and **never imported from application code**. We deliberately do *not*
strip Lucide out of the primitives — that would fight every future `shadcn add`.

## Consequences

- **Positive:** fast, consistent UI; neutral design tokens centralize the look; Radix
  primitives are accessible and owned in-repo; Heroicons gives one coherent icon language for
  our own components.
- **Trade-offs:** utility-class verbosity; vendored components are maintained in-repo (a
  feature, but upkeep); **two icon sets physically coexist** — Heroicons (ours) and Lucide
  (inside `components/ui/*`) — kept apart by the convention above, not by tooling.
- **Follow-ups:** keep component conventions in [[code-conventions]] in sync as the UI grows;
  [[stack]] still lists shadcn/ui as "not yet installed" and should be updated; revisit if
  shadcn ever supports Heroicons natively. Frontend testing remains deferred
  ([[0012-testing-strategy]]).
