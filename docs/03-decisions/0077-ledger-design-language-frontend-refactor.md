---
title: "ADR-0077: «The Ledger» — adopt the landing's design language in the app"
tags: [adr, frontend, design-system, branding, web, refactor]
status: accepted
created: 2026-06-29
updated: 2026-06-30
deciders: [Joaquín Minatel]
---

# ADR-0077: «The Ledger» — adopt the landing's design language in the app

## Status

**accepted** — 2026-06-30 (proposed 2026-06-29). The **Phase-1 token + font foundation has
shipped** on branch `refac/frontend-design` (issue #863): `apps/web/app/globals.css` now carries
the Ledger palette (pure-neutral surfaces, the oxblood `--brand`, the security-green `--verify`
seal, the brand-decoupled categorical ramp) and `apps/web/app/layout.tsx` binds the type trio
(Hanken Grotesk body / Commit Mono data / Redaction display). The CEO has ratified the questions
that were open at proposal — recorded under §Resolved decisions — and the as-shipped values are
recorded under §Final palette. This ADR **revises the palette + type identity** of
[[0049-activated-restraint]] (whose *restraint* principle still holds for the product register) and
is bounded by [[0015-deployment-model]] (single-org) and [[0046-roles-permissions-v2]]. Companion
reference (concrete values + from→to mapping): [[ledger-design-language]].

## Context

We designed and shipped a landing (`lazyit-landing`, live on Vercel) with a deliberate,
validated design language we call **"The Ledger"**: pure-neutral **paper white / carbon black**
surfaces, an **oxblood** rubber-stamp brand color + a security-**green** *verify* mark, the type
trio **Redaction** (display) / **Hanken Grotesk** (body) / **Commit Mono** (ledger data), and a
record/stamp/audit-tape visual vocabulary. It was built against the `impeccable` design
methodology, which explicitly flags the app's current direction as the 2026 "AI-cream" tell.

There is now a **visual discrepancy** between the two surfaces:

| | App (`apps/web`) today | Landing («The Ledger») |
| --- | --- | --- |
| Body bg | `oklch(0.985 0.004 95)` — **warm bone** | `oklch(0.985 0 0)` — **pure neutral white** |
| Brand | **indigo-violet** (`--brand`) | **oxblood** `oklch(0.52 0.2 25)` |
| Fonts | **Geist + Geist Mono** | **Hanken Grotesk + Commit Mono** (+ Redaction display) |
| Register | product (design serves work) | brand (design communicates) |

**Why it fits the app especially well:** The Ledger is not arbitrary paint — **the product *is* a
system of record** (append-only history, audit logs, the asset-ownership timeline, statuses). The
ledger/stamp/tape vocabulary is the product's own concept made UI. The differentiator
(auditability — [[0006-soft-delete-and-auditing]]) becomes the visual language.

## Decision

Adopt **The Ledger** as the app's design language, **translated from brand register to product
register**, via a **layered, tokens-first migration** (never a big-bang rewrite).

1. **Oxblood becomes THE lazyit brand color**, replacing indigo across app + landing + docs +
   logo — unifying the current split. (Ratified — see §Resolved decisions 1.)
2. **Tokens-first (Phase 1 — cheap, high-impact, low-risk).** `apps/web` uses the shadcn CSS-var
   token system; swap the **values** of `--background/--foreground/--primary/--accent/--ring/
   --border/--font-*` (and the `.dark` set) to the Ledger palette + Hanken/Commit Mono. Token
   **names stay**, so the change cascades through every component with minimal churn. Re-tune the
   pillar/chart data palette ([[0049-activated-restraint]]) to sit on the new neutrals. Exact
   from→to table in [[ledger-design-language]].
3. **Ledger-native patterns (Phase 2 — selective, where the data IS a record).** Status →
   **stamp** (VERIFIED / PENDING / RECORDED, not a generic badge); audit log → **ledger tape**;
   asset history → the **timeline** treatment; tabular data (IDs, timestamps, logs) in **Commit
   Mono** with `tabular-nums`. These are genuine UX wins, not paint.
4. **Per-screen polish (Phase 3 — long tail).**
5. **Register translation — do NOT copy the landing literally.** OUT: manifesto copy voice,
   Redaction in dense UI, stamps as decoration. IN: the palette, mono-for-data, stamps **only for
   status**, the ledger patterns. Redaction is allowed only on sparse hero/auth/empty-state
   moments, never on tables/labels/buttons.
6. **Validate before the big refactor with a 1-screen spike:** re-theme the **asset detail +
   history** screen (literally a ledger) and confirm it holds up in product register before
   committing to the full sweep. If it reads costume-y in dense UI, fall back to tokens+fonts only.

## Consequences

- **Positive:** one coherent brand across product + marketing; the app's own differentiator
  (auditability) made legible; kills the AI-cream/indigo tell; Commit Mono is a real UX win for
  the data-dense app; the tokens-first slice is high-leverage and low-risk.
- **Negative / cost:** a full sweep is a large surface (every screen, shadcn theme, the pillar
  palette, charts, emails). Re-theme has no functional gain — it's cohesion/brand. Regression risk
  concentrated in the token swap (verify contrast/AA in both themes, charts/data-viz readability).
- **Neutral:** [[0049-activated-restraint]]'s *restraint* philosophy is preserved (product register
  = Restrained: neutral surfaces + one accent); only its **color + type identity** is revised here.

## Resolved decisions (ratified at build)

1. **Brand colour org-wide — YES.** Oxblood is THE lazyit brand colour, replacing indigo across
   app, landing, logo, README and docs. Shipped as `--brand oklch(0.52 0.2 25)` (light) /
   `oklch(0.62 0.19 25)` (dark), wired to `--primary` / `--ring` / `--sidebar-primary`. It is a
   **stamp**, not a wall: reserved for the singular CTA / active accent, never a tinted body.
2. **Redaction in-app — login + empty-states ONLY (CEO-locked).** `--font-display` (Redaction) is
   opt-in on those sparse moments and nowhere else — never on tables/labels/buttons/dense UI.
   Headings stay on the body face (`--font-heading` = `--font-sans` = Hanken Grotesk).
3. **Charts / data-viz — the 5 categorical/pillar hues are KEPT but DECOUPLED from the brand.** The
   ramp deliberately vacates the red (oxblood ~25) and green (`--verify` ~162) bands so no data
   colour reads as "brand" or "verified": blue 255 · amber 80 · violet 300 · cyan 200 · magenta 335,
   on a lightness ladder so series stay separable under deuteranopia/protanopia/tritanopia (no
   categorical red↔green pair). Pillars re-map onto it (Access→blue, Knowledge→amber, Manage→violet,
   Inventory/Consumables→cyan). The §4 AA rule is preserved: pillar hue is a tint/border/dot/chip
   only; readable text stays on `--foreground`.
4. **`--success` ≠ `--verify`.** The everyday emerald `--success` (operational/good) is KEPT and
   stays DISTINCT from `--verify`, a cooler, deeper security-green RESERVED for the Secret Manager /
   zero-knowledge seal — so "operational" never reads as "cryptographically verified". `--verify`
   shipped at the in-gamut max chroma (0.105) for the spec's hue/lightness.
5. **`--destructive` reads distinct from the brand.** The brand is a muted oxblood wine at hue 25;
   `--destructive` is a hotter scarlet shifted to hue ~30 (`oklch(0.55 0.21 30)` light /
   `oklch(0.7 0.19 32)` dark) with its own `--destructive-foreground`, so "danger" never reads as
   "brand".
6. **Dark brand lifted for legible links.** `.dark --brand` is lifted to `oklch(0.62 0.19 25)` (vs
   the light 0.52) so `text-primary` links clear AA on the carbon canvas (4.90:1); the trade is
   white-on-fill at large-text AA (3.82:1 — parity with the prior indigo's 3.63:1).
7. **Email/PDF surfaces — print follows the swap; emails out of this slice.** The offboarding /
   reports print path already re-pins ink/paper to the light neutral tokens (`globals.css`
   `@media print`), so it inherits the Ledger neutrals automatically. API-side email templates are
   not token-driven and sit outside this CSS-token slice.

## Final palette (as shipped — `apps/web/app/globals.css`)

Pure-neutral surfaces (chroma 0); the brand lives in the oxblood stamp, never a tinted body. These
mirror `:root` / `.dark` exactly — `globals.css` is the source of truth.

**Type trio** (`layout.tsx` → `@theme inline`): `--font-sans` = **Hanken Grotesk**
(`next/font/google`, body/UI/headings — `--font-heading` aliases it); `--font-mono` = **Commit
Mono** (self-hosted woff2 400/500/600, data/IDs/timestamps/code with `tabular-nums`);
`--font-display` = **Redaction** (self-hosted woff2 400/700, login + empty-states ONLY).

| Token (→ aliases) | Light (`:root`) | Dark (`.dark`) |
| --- | --- | --- |
| `--brand` (→ `--primary` / `--ring` / `--sidebar-primary`) | `oklch(0.52 0.2 25)` | `oklch(0.62 0.19 25)` |
| `--primary-foreground` | `oklch(0.985 0 0)` | `oklch(0.985 0 0)` |
| `--background` | `oklch(0.985 0 0)` | `oklch(0.155 0 0)` |
| `--foreground` | `oklch(0.18 0 0)` | `oklch(0.96 0 0)` |
| `--card` / `--popover` | `oklch(0.965 0 0)` / `oklch(0.985 0 0)` | `oklch(0.195 0 0)` / `oklch(0.195 0 0)` |
| `--secondary` / `--muted` / `--accent` | `oklch(0.945 0 0)` | `oklch(0.225 0 0)` |
| `--muted-foreground` | `oklch(0.45 0 0)` | `oklch(0.7 0 0)` |
| `--border` / `--input` | `oklch(0.88 0 0)` | `oklch(0.32 0 0)` |
| `--sidebar` | `oklch(0.97 0 0)` | `oklch(0.175 0 0)` |
| `--destructive` / `-foreground` | `oklch(0.55 0.21 30)` / `oklch(0.985 0 0)` | `oklch(0.7 0.19 32)` / `oklch(0.18 0 0)` |
| `--success` / `-foreground` | `oklch(0.53 0.14 150)` / `oklch(0.985 0 0)` | `oklch(0.72 0.16 150)` / `oklch(0.18 0 0)` |
| `--warning` / `-foreground` | `oklch(0.82 0.15 85)` / `oklch(0.27 0 0)` | `oklch(0.84 0.15 85)` / `oklch(0.2 0 0)` |
| `--info` / `-foreground` | `oklch(0.52 0.115 240)` / `oklch(0.985 0 0)` | `oklch(0.7 0.13 240)` / `oklch(0.18 0 0)` |
| **`--verify`** / `-foreground` | `oklch(0.5 0.105 162)` / `oklch(0.985 0 0)` | `oklch(0.66 0.14 162)` / `oklch(0.18 0 0)` |
| `--warning-text` / `--info-text` / `--destructive-text` | `oklch(0.52 0.1 75)` · `oklch(0.48 0.12 245)` · `oklch(0.49 0.195 30)` | `oklch(0.9 0.12 90)` · `oklch(0.8 0.11 240)` · `oklch(0.8 0.11 30)` |
| `--code-accent` | `oklch(0.47 0.18 25)` | `oklch(0.74 0.15 25)` |

**Categorical ramp — decoupled from brand** (`--chart-1..5`; pillars alias these via `@theme inline`):

| Series | Hue | Light | Dark | Pillar |
| --- | --- | --- | --- | --- |
| `--chart-1` | blue 255 | `oklch(0.55 0.17 255)` | `oklch(0.64 0.16 255)` | `--pillar-access` |
| `--chart-2` | amber 80 | `oklch(0.76 0.14 80)` | `oklch(0.82 0.14 80)` | `--pillar-knowledge` |
| `--chart-3` | violet 300 | `oklch(0.52 0.18 300)` | `oklch(0.62 0.17 300)` | `--pillar-manage` |
| `--chart-4` | cyan 200 | `oklch(0.68 0.11 200)` | `oklch(0.75 0.11 200)` | `--pillar-inventory` (+ Consumables) |
| `--chart-5` | magenta 335 | `oklch(0.6 0.2 335)` | `oklch(0.7 0.18 335)` | — (5th series) |

Avatar/categorical fills (white-text AA in both themes, NOT redefined in `.dark`): `--avatar-1..5`
= `oklch(0.5 0.16 255)` · `oklch(0.52 0.1 80)` · `oklch(0.5 0.2 300)` · `oklch(0.5 0.08 200)` ·
`oklch(0.52 0.2 335)`; `--avatar-foreground oklch(0.985 0 0)`. Elevation (`--shadow-e1/e2/e3`) is
neutral chroma-0 ink (`oklch(0.21 0 0 / …)`), with a `.dark` `inset 0 1px 0 oklch(0.97 0 0 / 0.04)`
top-highlight.

## Migration plan tracker

Tracked in **#863** + branch `refac/frontend-design`. Phasing: spike (asset+history) → Phase 1
tokens+fonts → Phase 2 ledger patterns → Phase 3 polish. **Live implementation reference:** the
`lazyit-landing` repo (`DESIGN.md`, `PRODUCT.md`, the `Stamp`/`Rule`/`LedgerRow` primitives, the
`global.css` token block) — mirror, don't re-derive.

Related: [[0049-activated-restraint]] · [[0006-soft-delete-and-auditing]] · [[0015-deployment-model]]
· [[0046-roles-permissions-v2]] · [[ledger-design-language]]
