---
title: "ADR-0077: «The Ledger» — adopt the landing's design language in the app"
tags: [adr, frontend, design-system, branding, web, refactor]
status: proposed
created: 2026-06-29
updated: 2026-06-29
deciders: [Joaquín Minatel]
---

# ADR-0077: «The Ledger» — adopt the landing's design language in the app

## Status

**proposed** — 2026-06-29. No app code is touched yet. This ADR (and the branch
`refac/frontend-design`, issue #863) fix the **direction, the concrete tokens, and the phased
plan** so the eventual refactor starts with everything at hand. It **revises the palette + type
identity** of [[0049-activated-restraint]] (whose *restraint* principle still holds for the
product register) and is bounded by [[0015-deployment-model]] (single-org) and
[[0046-roles-permissions-v2]]. Companion reference (concrete values + from→to mapping):
[[ledger-design-language]].

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
   logo — unifying the current split. (Implicit but real branding decision; see Open questions.)
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

## Open questions (decide before/at build)

1. **Brand color org-wide.** Confirm oxblood replaces indigo everywhere (app, landing already done,
   logo, README, docs, OG). This ADR assumes yes; CEO to ratify.
2. **Redaction usage in-app** — confine to auth/empty-states, or drop entirely from the app?
3. **Charts / data-viz** ([[0049-activated-restraint]] pillar palette) — re-tune to the new
   neutrals while staying colour-blind-safe and AA; needs its own check.
4. **Email/PDF surfaces** (offboarding print, reports) — in scope for the token swap?

## Migration plan tracker

Tracked in **#863** + branch `refac/frontend-design`. Phasing: spike (asset+history) → Phase 1
tokens+fonts → Phase 2 ledger patterns → Phase 3 polish. **Live implementation reference:** the
`lazyit-landing` repo (`DESIGN.md`, `PRODUCT.md`, the `Stamp`/`Rule`/`LedgerRow` primitives, the
`global.css` token block) — mirror, don't re-derive.

Related: [[0049-activated-restraint]] · [[0006-soft-delete-and-auditing]] · [[0015-deployment-model]]
· [[0046-roles-permissions-v2]] · [[ledger-design-language]]
