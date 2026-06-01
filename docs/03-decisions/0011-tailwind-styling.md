---
title: "ADR-0011: Tailwind CSS + shadcn/ui for styling"
tags: [adr]
status: accepted
created: 2026-05-25
updated: 2026-06-01
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

- **`radix-nova` preset** — the *Nova* style on **Radix** primitives, scaffolded with
  `bunx shadcn@latest init --preset nova -b radix`, chosen over the newer **Base UI** option
  (`base-nova`) to honour the Radix decision in this ADR. Note: `--defaults` maps to
  `base-nova` (Base UI), so the Radix base (`-b radix`) must be passed explicitly. Components
  are added the same way — `bunx shadcn@latest add <component>` — which reads `components.json`
  and emits the `radix-nova` variant.
- **`neutral` base color**, **CSS variables**, Tailwind v4 tokens in `oklch` (light + dark in
  `app/globals.css`). The neutral ramp keeps the look clean and IT-native, not flashy — but
  see the *Palette evolution* note below: it has since moved from a chromaless grayscale to
  **calm, warm neutrals**, and a single brand accent was layered on top.
- **Typography: Geist + Geist Mono** (`next/font/google`) — the font the Nova preset assumes;
  neutral, technical and legible at small sizes for data-dense tables. The Nova-generated
  `app/globals.css` expects the CSS variables `--font-sans` and `--font-geist-mono` in its
  `@theme inline` block, so `app/layout.tsx` **reconciles** this by binding Geist to
  `--font-sans` and Geist Mono to `--font-geist-mono` (`next/font` `variable` option) — without
  that wiring the body falls back to the system font.
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

### Palette evolution (amendments)

The original tokens were a **pure grayscale** ramp (`oklch(* 0 0)`) on pure white / pure
black anchors. Two CEO-driven amendments have since refined this **at the token level only**
(no per-component restyling):

1. **Brand accent + semantic colors** (2026-05, PR #65). A single disciplined deep-indigo
   hue (`oklch(0.55 0.18 275)`, lightened to `0.62` in dark) was wired through
   `--primary` / `--ring` / `--sidebar-primary` and the chart ramp, plus semantic
   `--success` / `--warning` / `--info` tokens. "Neutral, not flashy" now means *one*
   accent on an otherwise quiet canvas — not chromaless.

2. **Calm, warm neutrals** (2026-06, this ADR's amendment). The CEO finds pure black and
   pure white too harsh ("son fuertes") and asked for calmer anchors — "un hueso y un gris
   muy oscuro." So the **neutral ramp** (`--background`, `--foreground`, `--card`,
   `--popover`, `--muted`, `--muted-foreground`, `--secondary`, `--accent`, `--border`,
   `--input`, and the `--sidebar-*` neutrals) was retuned away from chromaless gray:
   - **Light mode:** background is a warm **bone** (`oklch(0.985 0.004 95)`), foreground a
     **very dark warm gray** (`oklch(0.21 0.006 75)`) — never `#fff` / `#000`. Cards/popovers
     sit a hair above the bone so surfaces stay layered; muted/secondary a hair below.
   - **Dark mode:** background is a **very dark warm gray** (`oklch(0.205 0.006 75)`),
     foreground the same warm **bone** (`oklch(0.96 0.004 95)`). Cards/popovers step up in
     lightness; borders are warm-tinted translucent whites.
   - All neutrals carry a tiny chroma (≈0.003–0.008) at a warm hue (bone ≈95, gray ≈75) so
     the canvas feels warm rather than clinical, without reading as a tint.
   - **Contrast holds AA.** Body `--foreground` on `--background` is **~16.9:1** (light) /
     **~16.0:1** (dark); `--muted-foreground` on background is **~5.3:1** (light) /
     **~7.1:1** (dark) — all ≥ 4.5:1. Surface hierarchy (background → card → muted) remains
     visually distinguishable in both themes.

   The **brand accent and the semantic colors from amendment 1 are unchanged** — only the
   neutral ramp was softened.

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
