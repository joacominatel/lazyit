---
title: "ADR-0049: «Activated Restraint» — the design-system activation direction"
tags: [adr, web, frontend, ui, design-system, motion, tokens]
status: accepted
created: 2026-06-03
updated: 2026-06-03
deciders: [Joaquín Minatel]
---

# ADR-0049: «Activated Restraint» — the design-system activation direction

## Status

accepted — 2026-06-03. Ratified by the CEO after a multi-agent UX dossier
(`docs/status_jun_2026/ux-redesign/`). This ADR **extends** [[0011-tailwind-styling]] — it
adds an expression layer (motion, depth, per-pillar colour) on top of the warm-bone +
single-indigo system; it does not repaint or replace it. Web-only; no API or contract change.
Wave 0 (this ADR's foundation) shipped under epic #157 / issue #158.

## Context

A UX audit found the UI "half-built": the warm-bone + single-indigo system (ADR-0011) is
correct, but the tokens that express identity, depth and motion ship **dormant**. Five
categorical hues (`--chart-1..5`), three semantic status tokens and the avatar palette are
defined and AA-verified yet ~95% unused. There was **no elevation language** (every Card flat
`ring-1 shadow-none`), **zero authored `@keyframes`**, **zero `prefers-reduced-motion`
handling**, and three confirmed raw-Tailwind token breaks (dashboard `TONE`,
activity `ENTITY_TONE`, asset-history `EVENT_TONE`). The CEO's "no onda" is the gap between the
spec and the build — closable by *activation and craft*, not by relighting the dial ADR-0011
deliberately kept low.

## Considered options

1. **«Activated Restraint»** *(chosen)* — Refined Restraint craft/motion/depth as the spine +
   per-pillar colour identity (delivered as `@theme`-registered utilities) + Warm & Human
   personality/warm-paper shadows. AA-safe by construction, zero new deps, zero vendored-
   primitive edits. The only synthesis the dossier's judges converge on (9/9/8).
2. **Pure Refined Restraint** (craft/motion/depth only, minimal pillar colour). Rejected: may
   under-deliver the visible colour spark the CEO asked for.
3. **Vibrant Pillars lead** (louder, colour-forward). Rejected: risks "flood not seasoning"
   against ADR-0011's "colour is ~5% of pixels" discipline, and leans on AA-fragile pillar-as-
   text and `color-mix()`/relative-colour the repo does not use.

## Decision

Add an expression layer to the ADR-0011 token system. **Five concrete moves**, all via tokens
in `app/globals.css` and composition (no `components/ui/*` hand-edits, no new runtime deps, no
`color-mix()`/`oklch(from …)` relative-colour — derived values are precomputed oklch literals).

### 1. Motion vocabulary (reduced-motion-safe, zero JS lib)

`tw-animate-css` ships only enter/exit/accordion keyframes, so the surface-level vocabulary is
authored in `@layer utilities`. One shared dialect:

- **Easing/duration tokens:** `--ease-out-quad: cubic-bezier(.25,.46,.45,.94)` (workhorse),
  `--ease-spring: cubic-bezier(.34,1.3,.64,1)` (RESERVED for the success-check overshoot only),
  `--dur-fast:120ms` / `--dur-base:180ms` / `--dur-slow:220ms`.
- **Keyframes + utilities:** `.animate-rise-in` (12px rise + fade), `.animate-pulse-soft`
  (opacity 1↔.55 over 2.4s — the one calm attention heartbeat, danger dots only),
  `.animate-shimmer` (skeleton sweep), `.animate-check-draw` (success-check stroke draw).
- **ONE consolidated `@media (prefers-reduced-motion: reduce)` block** collapses
  animation/transition to ~0.01ms and neutralizes the hover translate, so surfaces still get
  the instant elevation/tone change. This landed FIRST so everything after is opt-out-safe.
- `app/(app)/template.tsx` wraps each route in `rise-in` for a ~220ms cross-route settle.

### 2. Warm elevation scale

Three warm-tinted (foreground-hue) shadow tokens — "paper on a warm desk":

- `--elevation-1: 0 1px 2px oklch(0.21 0.006 75 / .06), 0 1px 1px oklch(0.21 0.006 75 / .04)`
- `--elevation-2: 0 4px 12px -2px oklch(0.21 0.006 75 / .10), 0 2px 4px -2px oklch(0.21 0.006 75 / .06)`
- `--elevation-3: 0 12px 28px -6px oklch(0.21 0.006 75 / .14)`

In `.dark` the same shapes run at ~2x alpha PLUS a `inset 0 1px 0 oklch(0.97 0.004 95 / .04)`
top-highlight so raised surfaces catch light on near-black (warm shadows alone vanish there).
Registered as `--shadow-e1/e2/e3` via `@theme inline` → real `shadow-e1/e2/e3` utilities.
The **coordinated hover triad** (`-translate-y-0.5` + `shadow-e1`→`e2` + ring `/10`→`/15`)
ships as the `lift` recipe (`lib/recipes.ts`), applied at call sites.

### 3. Pillar colour family (locked map)

`--color-pillar-*` registered in `@theme inline` **exactly like `--color-avatar-*`** so
Tailwind emits scanner-safe `bg-pillar-*` / `text-pillar-*` utilities — **never**
`bg-[var(--pillar)]/10` (the JIT scanner needs full, non-interpolated class strings;
`lib/avatar-color.ts` warns this). Each pillar aliases one chart hue (which carries light/dark
parity), so the utilities are theme-correct for free. **LOCKED map:**

| Pillar | Token | Hue |
| --- | --- | --- |
| Inventory / Assets | `--chart-2` | teal |
| Access / Applications | `--chart-1` | indigo (the brand hue) |
| Knowledge | `--chart-3` | green |
| Manage / Users | `--chart-5` | rose |

**Consumables shares Inventory teal** — it *is* inventory; differentiate by icon, never invent
a 5th hue. `<PillarScope pillar>` (`components/pillar-scope.tsx`) sets an inherited `--pillar`
var (brand-indigo fallback when omitted) for chrome that wants the *route's* pillar; surfaces
that statically know their pillar use the `bg-pillar-*` utility directly.

### 4. The AA rule (non-negotiable, structural)

**Pillar hue = tint / border / dot / chip ONLY — never small text on the bone canvas.** The
chart hues (teal 0.62L, amber 0.74L, rose) cannot clear 4.5:1 as body text on the 0.985 bone.
So: a decorative ≥24px glyph in a `bg-pillar-*/10` chip is fine (glyphs are exempt from
text-AA), a 3px accent bar is fine, a tint *behind* `--foreground` text is fine — but readable
text always stays on `--foreground` / `--card-foreground` / a token's AA-verified
`*-foreground`. This makes the whole colour program AA-safe by construction in both themes.

**There is no `--pillar-foreground`.** White text on a `var(--pillar)` solid fill is *not*
AA-safe — the pillar aliases a `--chart-*` hue that `.dark` redefines lighter, so white-on-fill
lands at 1.82–3.63:1 in dark (only Access/indigo clears in light). For text-on-colour use a
semantic `StatusBadge` solid fill or the avatar tokens (`--avatar-*` are pinned dark and *not*
redefined in `.dark`, so they keep the white-on-hue AA contract; the pillars deliberately do not).

### 5. De-hardcode the three breaks (+ an anti-rot guard)

- **dashboard `TONE`** → `bg-warning`/`bg-destructive` + `ring-warning/25`/`ring-destructive/30`
  (tokens carry dark parity; the hand-written amber/rose values are gone).
- **activity `ENTITY_TONE`** (decorative icon chips, glyph-exempt) → `bg-pillar-inventory/10
  text-pillar-inventory` (asset + consumable), `bg-pillar-access/10 text-pillar-access`
  (application); the `dark:` variants disappear.
- **asset-history `EVENT_TONE`** (these badges carry **readable text**, so the hue cannot be
  the text colour): semantic events map to solid-fill `StatusBadge` tones whose label sits on
  the token's AA-verified `*-foreground` (CREATED/RESTORED→success, RELEASED→warning,
  STATUS_CHANGED→info, DELETED→danger); categorical events (ASSIGNED/LOCATION_CHANGED/
  MODEL_CHANGED/SPECS_CHANGED) get a **neutral pill + a `--chart-*` dot**, label on
  `--secondary-foreground`. Verified ≥4.5:1 in both themes.
- **eslint guard** (`apps/web/eslint.config.mjs`, `no-restricted-syntax`, web-scoped, excludes
  `components/ui/*`) flags raw `bg/text/ring/border-{emerald,sky,violet,amber,rose,teal,
  indigo}-NNN`. Severity is `warn` because a sweep found ~15 pre-existing usages on
  Roles/Permissions, Service-accounts and Setup surfaces; de-hardcoding those is Wave-1+ work,
  so the warning keeps the debt visible and flags new drift without a big-bang touch or broken
  CI. Tighten to `error` once those surfaces are de-hardcoded.

### Named type tokens

`--text-display` / `--text-section` / `--text-label` (size + line-height + tracking triples)
in `@theme inline` so "big metric" vs "small eyebrow" is intentional, not pixel-guessed. No
font change; AA untouched.

## Consequences

- **Positive:** colour identity + craft/motion/depth + warmth land immediately, AA-safe by
  construction, zero new runtime deps, zero vendored-primitive edits. `bunx tsc` and
  `bun run build` (web) are green. The guard prevents the token-discipline drift from recurring.
- **Deferred (out of Wave 0):** the per-surface composition waves (PillarCards, sidebar rule,
  EmptyState rollout, login/marketing, activity dividers) — see the dossier roadmap. Sparklines
  / week-over-week deltas stay an ADR-gated fast-follow (DashboardSummary is a point-in-time
  snapshot with no time series). i18n is deferred (its own future ADR).
- **Known debt:** the ~15 pre-existing raw-palette usages the guard now warns on; the lint
  `warn`-not-`error` choice is a deliberate, temporary bridge.
- **Scaffolds shipped, rollout later:** `lift`, `<PillarScope>`, `<EmptyState>` exist but are
  composed by surfaces in later waves.

## References

- Extends [[0011-tailwind-styling]] (the warm-bone + single-indigo token system this builds on).
- [[0045-icon-library-heroicons]] (heroicons-only, two-weight) · [[0010-nextjs-frontend]] ·
  [[0020-frontend-data-layer]].
- Dossier: `docs/status_jun_2026/ux-redesign/00-README.md` (direction, locked pillar map,
  roadmap) and `01-visual-direction.md` (the concrete token moves).
