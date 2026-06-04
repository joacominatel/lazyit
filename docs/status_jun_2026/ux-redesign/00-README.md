---
title: "UX/UI Evolution — Dossier de dirección (Jun 2026)"
status: decisions-ratified
created: 2026-06-03
updated: 2026-06-03
---

# lazyit — UX/UI Evolution · Dossier de dirección

> Producto de un workflow multiagente (24 agentes): mapeo del frontend real → panel
> creativo (4 visiones + 3 jueces) → 4 deep-dives de las features pedidas por el CEO →
> barrido de mejoras por 6 lentes → auditoría de factibilidad/AA/ADR → síntesis.
> **Análisis, no implementación.** Nada se tocó en el código.

## Decisiones tomadas (CEO, 2026-06-03)

1. **Dirección visual → «Activated Restraint»** (contrato único de tokens). Refined
   Restraint como columna + color por pilar (Inventory/Assets=teal · Access/Applications=indigo
   · Knowledge=green · Manage/Users=rose; Consumables comparte teal) vía utilidades
   `@theme`-registradas (`bg-pillar-*`/`text-pillar-*`, **no** `bg-[var(--pillar)]`) +
   personalidad/sombras cálidas (Warm & Human) + barra de salud operacional (Signal Dense).
   **Regla AA:** el hue de pilar va como tinte/borde/chip, **nunca como texto chico** sobre el
   hueso. Sin dependencias nuevas; **no** se editan las primitivas vendored (`components/ui/*`).
2. **«Más onda» → energía por motion/color/depth** (no más CTAs). Complemento aprobado:
   command-palette como superficie de creación + crear-desde-empty-states (inline-create).
3. **i18n / español → DIFERIDO.** Primero el rediseño visual; español como fast-follow posterior.
   ⚠️ **Consecuencia aceptada:** el rediseño hardcodea ~300–500 strings en inglés que serán
   **deuda de extracción** cuando se haga i18n. No se aplica la regla «copy nuevo como keys».
   Sale del roadmap activo (vuelve más adelante con su propio ADR + next-intl cookie-mode).
4. **Backend → DEBT-1 + DEBT-2 aprobados.** DEBT-1 = endpoint de actividad **filtrable**
   (params `WHERE` sobre la vista existente, sin cambio de schema). DEBT-2 = **UserHistory**
   (nuevo modelo + emisión en write paths + ensanchar `ActivityEntityType` + ADR propio).
   ⚠️ **Restricción de secuenciación:** DEBT-2 cambia el contrato `Page<T>`/activity — debe
   aterrizar **junto con su consumidor web**, nunca antes (riesgo *breaking-for-web* del unwrap
   de `Page<T>`). Diferidos: auditoría de categorías (DEBT-3), export server-side (DEBT-5),
   endpoint de series para sparklines/deltas (Ola 4).

> El roadmap más abajo refleja la recomendación original; con estas decisiones: la Ola 3 incorpora
> UserHistory (backend+web juntos) e i18n sale del tramo activo. Próximo paso operativo: **Ola 0
> (fundación)** — pendiente de arranque del CEO.

## Índice del dossier

- **00-README** (este archivo) — resumen ejecutivo, diagnóstico, dirección recomendada, roadmap, decisiones.
- **[01-visual-direction](01-visual-direction.md)** — las 4 visiones creativas completas + puntajes de los jueces.
- **[02-ceo-features](02-ceo-features.md)** — deep-dives: i18n · acta de baja imprimible · dashboard + rail · Informes.
- **[03-improvement-catalog](03-improvement-catalog.md)** — catálogo priorizado de mejoras (6 lentes).
- **[04-feasibility-and-gaps](04-feasibility-and-gaps.md)** — auditoría de factibilidad/AA/ADR + gaps de completitud.
- **[05-current-state-map](05-current-state-map.md)** — mapa del estado actual del frontend.

---

## Resumen ejecutivo

The current UI isn't broken — it's *half-built*. The warm-bone + single-indigo system (ADR-0011) is correct and worth defending; what's missing is craft and the activation of tokens that already ship dormant in globals.css. Five categorical hues (--chart-1..5), three semantic status tokens, and the avatar palette are defined and AA-verified, yet ~95% unused. There is zero elevation language (every Card is flat ring-1, shadow-none), zero authored @keyframes, zero prefers-reduced-motion handling, and three confirmed raw-Tailwind token breaks (dashboard TONE map bg-amber-500/bg-rose-500; activity-feed ENTITY_TONE sky/violet/amber; asset-history EVENT_TONE). The "no onda" the CEO feels is the absence of motion, depth, and color *identity* — not a need to repaint.

Recommendation: ship **Refined Restraint as the structural spine** (the only direction fully shippable today — zero new deps, zero primitive hand-edits, AA-safe by construction, smallest verification surface), grafting **Vibrant Pillars' per-pillar color identity** (the literal answer to "too neutral," the single highest first-glance win) delivered through **Warm & Human's @theme-registered token mechanism** (real bg-pillar-*/text-pillar-* utilities, NOT the JIT-fragile bg-[var(--pillar)]/10 arbitrary-var path the visions lean on), plus **Warm & Human's personality layer** (empty states, dignified offboard, warm microcopy) so the calm reads "cared-for workshop," not "austere SaaS." Signal Dense's sparklines/deltas are deferred as an ADR-gated fast-follow (DashboardSummary is a verified point-in-time snapshot with no time-series); its operational-health ratio bar ships now because it needs no new data.

The whole program is gated behind ONE foundational commit — a motion vocabulary + warm elevation scale + reduced-motion guard + the token de-hardcoding sweep + an eslint guard against raw palette colors — landed file-by-file before any surface moves. This delivers visible color and dynamism immediately with Linear/Vercel-grade finish, never violates an ADR, and stays WCAG-AA everywhere. Six CEO decisions follow; the load-bearing one is ratifying that we read "some buttons / more life" as energy-through-motion-color-depth, not louder/more CTAs.

## Diagnóstico — por qué se siente "neutro / sin onda"

The UI feels "too neutral / no onda" for five concrete, file-verified reasons — and none of them is "the colors are wrong."

1) **The color system is built but switched off.** globals.css defines --chart-1..5 (indigo/teal/green/amber/rose), --success/--warning/--info, and the avatar ramp, all AA-verified with full dark-mode parity. A repo grep confirms the categorical hues appear as identity *nowhere* on the marquee surfaces — every dashboard PillarCard icon chip is the same generic `bg-primary/10 text-primary` (page.tsx:267), so four different pillars look identical. The five-hue scannability device the system was designed for is dormant.

2) **There is no depth — literally.** Card is `ring-1 ring-foreground/10` with `shadow-none` (card.tsx:15); DetailPanel duplicates that flat look. The page canvas (--background 0.985) and the card surface (--card 0.995) sit a hair apart with no shadow, so on light mode cards are visually coplanar with the page. Nothing lifts, nothing floats, nothing reads as an object you can act on.

3) **Nothing moves with intention.** globals.css has **0 authored @keyframes and 0 prefers-reduced-motion handling** (grep-confirmed). All motion is borrowed from Radix primitives. Content snaps in after skeletons; numbers appear instantly; hover does a flat bg swap; route changes hard-cut (no template.tsx exists). There is no named motion vocabulary, so even the motion that exists speaks no shared dialect.

4) **Token discipline has already drifted, and the drift looks cheap.** Three confirmed raw-Tailwind breaks bypass the token system and break dark-mode correctness: the dashboard "Needs attention" TONE map (`bg-amber-500`/`bg-rose-500`/`ring-amber-500/20`), the activity feed ENTITY_TONE (`bg-sky-500/10 text-sky-600 dark:text-sky-400` — sky/violet aren't even lazyit hues, and Access is brand indigo not violet), and the asset-history EVENT_TONE (9 hand-written emerald/sky/violet/amber pairs). These off-system colors are exactly what makes a surface read as un-designed.

5) **The first impressions are entirely untreated.** login/page.tsx and the public marketing landing are the first surfaces a CEO/prospect sees, and **no vision or sweep item touches them** — so even after the dashboard comes alive, the front door stays flat.

The root cause is consistent: the design system specified expression (color identity, depth, motion) but only the neutral *foundation* was implemented. "No onda" is the gap between the spec and the build — closable by activation and craft, not by relighting the dial ADR-0011 deliberately kept low.

## Dirección visual recomendada

## The synthesized direction: "Activated Restraint"

**Refined Restraint is the spine** (judge scores 9/9/8 — the consensus winner on feasibility and CEO-alignment). We graft Vibrant Pillars' color identity (Impact judge's 9, the literal answer to "too neutral"), Warm & Human's token-delivery mechanism + personality, and Signal Dense's ratio bar. We add expression *on top of* the warm-bone + single-indigo system; we trash nothing. Every move below is AA-safe and grounded in a verified file.

### 1. Color — activate, never repaint (5% of pixels, as seasoning)
Keep `--background` bone, `--foreground` warm-gray, `--primary` indigo oklch(0.55 0.18 275) **byte-for-byte**. Three moves:

**(a) Per-pillar identity, registered as real Tailwind utilities.** Add a `--color-pillar-*` family in `@theme inline` mirroring the existing `--color-avatar-*`/`--color-chart-*` registration (globals.css already does this) so Tailwind emits scanner-safe `bg-pillar-inventory`, `text-pillar-access`, etc. **Do NOT use `bg-[var(--pillar)]/10` arbitrary-var-with-opacity** — a repo grep confirms zero such usage today and avatar-color.ts explicitly warns the JIT scanner needs "full, non-interpolated class strings." Map (locked): Inventory/Assets=`--chart-2` teal; Access/Applications=`--chart-1` indigo (brand stays Access's color, resolving the Access-vs-Applications split); Knowledge=`--chart-3` green; Manage/Users=`--chart-5` rose; Consumables shares Inventory teal (it *is* Inventory — differentiate by icon, never invent a 5th hue). Deliver the per-route value via a single `<PillarScope pillar>` wrapper (Vibrant's idea) with a **brand-indigo fallback** so a missing wrapper degrades to today's neutral look, not uncolored chrome.

**(b) Pillar shows ONLY as tint/border/dot/chip — NEVER as small text on bone.** This is the AA blocker the feasibility audit flagged: amber chart-4 (L0.74) and teal chart-2 (L0.62) cannot clear 4.5:1 as text on the 0.985 bone. Rule: pillar hue = a 3px left/top accent bar, a tinted icon chip (`bg-pillar-* /10` background behind a `text-pillar-*` 24px+ glyph or the chip's own token — large/decorative glyphs are exempt from text-AA), and the active-nav left rule. Body text always stays on `--foreground`/`--card-foreground`. This makes the whole color program structurally AA-safe.

**(c) De-hardcode the three confirmed breaks in the SAME change** (consensus across all four judges): dashboard TONE map → `bg-warning`/`bg-destructive` + `ring-warning/25`/`ring-destructive/30`; ENTITY_TONE → `bg-pillar-inventory/10 text-pillar-inventory` (asset/consumable), `bg-pillar-access/10 text-pillar-access` (application) — the hand-written `dark:` variants disappear because tokens carry parity; asset-history EVENT_TONE → semantic + chart tokens. Then add an **eslint/grep guard** flagging raw `bg-{emerald,sky,violet,amber,rose}-NNN` in feature code so the drift can't recur.

**Avoid `color-mix(in oklch)` and `oklch(from …)` relative-color** (Vibrant/Signal Dense lean on them): grep-confirmed unused in app source, modern-browser-only, unknown self-hosted baseline, and a fallback breaks AA. **Precompute any derived tint/strong token as a static oklch literal** instead.

### 2. Depth — a named, warm elevation scale (the codebase has none)
Add three elevation tokens, warm-tinted with the foreground hue so shadows sit in the bone system (paper on a warm desk, Warm & Human's register — the truest extension of "hueso"):
- `--elevation-1: 0 1px 2px oklch(0.21 0.006 75 / .06), 0 1px 1px oklch(0.21 0.006 75 / .04)` — resting cards/DetailPanel (replaces today's flat look).
- `--elevation-2: 0 4px 12px -2px oklch(0.21 0.006 75 / .10), 0 2px 4px -2px oklch(0.21 0.006 75 / .06)` — hover/focus card.
- `--elevation-3: 0 12px 28px -6px oklch(0.21 0.006 75 / .14)` — dialogs, dropdowns, sticky batch bar.
**Dark mode (Signal Dense's refinement — the canonical fix both Refined Restraint and Warm & Human point to):** shadows on pure black at ~2x alpha PLUS a 1px inset top highlight `inset 0 1px 0 oklch(0.97 0.004 95 / .04)` so raised surfaces catch light on the near-black canvas where warm shadows are invisible. Expose as `--shadow-e1/e2/e3` via `@theme inline` so `shadow-e1/e2/e3` are real utilities.

**The coordinated hover triad** (Refined Restraint's signature "crafted, not a flat swap"): on interactive cards, hover does THREE things at once — `-translate-y-0.5` + elevation 1→2 + ring `foreground/10`→`foreground/15`. Apply at the **composition layer** (call sites) or via a `lift` className recipe in lib/utils and a new `<EmptyState>`/`<LiftCard>` component — **never hand-edit card.tsx** (vendored shadcn; ADR-locked). If a primitive truly needs a default shadow, regenerate via the shadcn CLI and flag it.

### 3. Motion — one named CSS vocabulary, reduced-motion-safe, zero JS lib
Add to globals.css (`@layer utilities`), since tw-animate-css ships only enter/exit/accordion/collapsible — confirmed it does NOT supply surface-level keyframes:
- Easing/duration tokens: `--ease-out-quad: cubic-bezier(.25,.46,.45,.94)` (workhorse), `--ease-spring: cubic-bezier(.34,1.3,.64,1)` (reserved ONLY for the success checkmark's single gentle overshoot), `--dur-fast:120ms / --dur-base:180ms / --dur-slow:220ms`.
- `@keyframes rise-in` (translateY 12px + fade), `pulse-soft` (opacity 1↔.55 over 2.4s — the ONE calm attention heartbeat, danger dots only), `shimmer` (skeleton sweep), `check-draw` (stroke-dasharray success check).
- **ONE consolidated `@media (prefers-reduced-motion: reduce)` block** that sets animation/transition to ~0.01ms and kills hover translate — surfaces still get the instant elevation/tone change. This is the FIRST gate; nothing animates until it lands.
- Add `app/(app)/template.tsx` (remounts per navigation) wrapping children in `rise-in` for a ~200ms cross-route settle — the cheapest highest-perceived-polish change, zero per-page wiring.

### 4. Personality & light data-viz (Warm & Human + Signal Dense grafts)
- **Reusable `<EmptyState>`** (new component, composes Card/Button/heroicon): 3x icon on a fully-rounded `bg-pillar-*/10` circle + warm one-line invitation ("Nothing here yet — add your first asset and it shows up here") + primary action, `rise-in` on mount. Replaces today's dashed-border boxes across all lists; each pillar wears its own color.
- **Dignified offboard:** impact-preview line with bold tabular-nums counts read from the already-loaded grant/assignment arrays ("Releases 4 assets · revokes 6 grants · authored 3 articles, kept"), then on success a `check-draw` and "User archived — access revoked, history is safe." Delight ≠ whimsy in destructive flows; this is a confident, respectful "done."
- **Operational-health ratio bar** (Signal Dense, ships NOW — reads existing `assets.byStatus`, plain divs + `--success`/`--warning`/`--muted-foreground`, no backend): one stacked track answering "is my fleet healthy?" at a glance.
- **Metrics that arrive:** big pillar counts mount with `rise-in` (mono, tabular-nums, weight 600) staggered ~40ms via `--i`, capped at first ~8 items. Prefer CSS `rise-in` over a rAF count-up hook unless real value-tweening is wanted (avoids net-new render JS); if used, the hook must be SSR-safe, matchMedia-short-circuit under reduced-motion, and not re-tween on TanStack refetch.
- **Activity feed:** date-group dividers ("Today/Yesterday/Earlier") + avatar settle-in (no-data-required, no "Live" label — keep honest "Updated Ns ago").
- **Finish avatarColorFor() coverage** on every people surface still missing it (asset owner chips, grantee rows, assignee lists, settings user list) so identity color (WHO) is universal and coexists with pillar color (WHERE).

### 5. Type & numerics
Named type tokens (`--text-display/--text-section/--text-label`) in `@theme` and universal `tabular-nums` on metrics so headline numbers read instrument-grade — no font change, AA untouched (foreground on card unchanged).

### Net
Color identity (Vibrant) + craft/motion/depth (Refined Restraint) + warmth/personality (Warm & Human) + one honest data-viz moment (Signal Dense), all on the existing warm-neutral + single-indigo system, AA-safe by construction, zero new runtime deps.

## Roadmap

All work is file-by-file commits (CLAUDE.md), front/back split to subagents, docs updated in the same change. Effort: S=≤0.5d, M=0.5–1.5d, L=2–4d.

## WAVE 0 — Foundation (the gate; nothing moves until this lands) — ~M total
**Must be ONE cohesive "design-system activation" series, committed file-by-file, before any surface work.**
- [S] globals.css: reduced-motion guard + reusable `@keyframes` (rise-in, pulse-soft, shimmer, check-draw) + easing/duration tokens. **This is the FIRST commit** — makes all later motion opt-out-safe by construction.
- [S] globals.css: warm elevation scale (`--elevation-1/2/3` + dark pure-black-2x-alpha + inset top highlight) exposed as `shadow-e1/e2/e3` utilities.
- [S] globals.css `@theme inline`: register `--color-pillar-*` (mirroring `--color-avatar-*`) → real `bg-pillar-*`/`text-pillar-*` utilities. Add named type tokens.
- [S] **De-hardcode the 3 confirmed breaks** (dashboard TONE map, activity ENTITY_TONE, asset-history EVENT_TONE) → tokens. Highest-confidence, unblocks dark-mode correctness.
- [S] eslint/grep guard against raw `bg-{emerald,sky,violet,amber,rose}-NNN` in feature code (anti-rot).
- [S] `<PillarScope>` wrapper (indigo fallback) + `lib/utils` `lift` recipe + new `<EmptyState>` component scaffold.
- [S] **Both-themes visual-QA pass on a real panel** to freeze elevation/tint alphas (the visions call the numbers "a starting point, not gospel") — gating step before tokens are locked.

## WAVE 1 — Quick wins (visible "onda" the day Wave 0 merges) — ~M
- [S] Dashboard PillarCards: per-pillar icon chip + 3px accent + coordinated `lift` hover + staggered `rise-in` metrics. **Single highest-visibility change** (landing screen).
- [S] `app/(app)/template.tsx` cross-route `rise-in` settle.
- [S] Sidebar active-item pillar left-rule + section-heading pillar tint (quiet wayfinding at restrained volume).
- [S] Needs-attention: token tones + `pulse-soft` on danger dot only + hover lift + "all clear" success moment.
- [M] Activity feed: date-group dividers + avatar settle-in + staggered row `rise-in` (capped, initial-mount only).
- [S] Skeleton `shimmer` at composition sites (NOT editing vendored ui/skeleton.tsx).

## WAVE 2 — Foundational reach (system consistency) — ~M–L
- [M] PageHeader: optional pillar icon-chip + eyebrow slot — carries identity from card → full page across all lists.
- [M] EmptyState rollout across Assets/KB/Applications/Consumables/Users/Locations + settings managers.
- [M] Finish avatarColorFor() coverage (audit breadth, not change complexity).
- [S] Operational-health ratio bar on the Assets tile (zero-backend Signal Dense graft).
- [M] **Login + marketing surfaces** (completeness gap — first impressions): apply lift/elevation/rise-in + per-pillar color to the landing's existing pillar cards; friendly-state treatment on login error states.
- [M] Table-row ergonomics: clickable rows, hover-reveal actions (always-visible on `@media (hover:none)` + focus-within — hard a11y rule), inline status edit.

## WAVE 3 — The 4 CEO features (sequenced; backend debt gated) — ~L each
1. **Dashboard 2-col + Pulse rail** (M, frontend-only): slim feed + status donut (CSS conic-gradient) + access-health counts + all-clear tile. Ships on existing DashboardSummary. Mobile reflow is acceptance criteria.
2. **Offboarding & Return Act** (M, 2–3d frontend): full-height Sheet + printable act + dignified completion. v1: localStorage message, client-resolved asset fields. Backend follow-ups (GET /users/:id/offboarding manifest; writable InstanceSettings) deferred — CEO decision.
3. **Informes/Reports** (M frontend v1 on existing GET /dashboard/activity; client-side filter, entity tabs, CSV of visible rows; server-param controls disabled-with-tooltip). Full vision needs DEBT-1 (filter endpoint), DEBT-2 (UserHistory model + ADR — the Page<T>-unwrap breaking-for-web trap; must land WITH its consumer), DEBT-3/4/5 sequenced.
4. **Multi-language (Spanish)** (next-intl, cookie-mode, no route restructure). Phase 0–1 (~1.5d) = bilingual chrome + dashboard + working switcher. Full coverage ~6–9 incremental dev-days. **Rule: all new redesign copy lands as catalog keys, OR i18n Phase 0 ships first** — otherwise the redesign manufactures extraction debt. Coordinate next.config.ts wrap with DevOps (ADR-0025).

## WAVE 4 — Polish & deferred data-viz — ~M
- [M] Sparklines + week-over-week deltas (ADR-gated fast-follow: new /dashboard/summary/stats time-series endpoint; DashboardSummary is a verified snapshot — must not block earlier waves).
- [S] 404 personality, ErrorState entrances, toast success flourish, copy-to-clipboard on identifiers.
- [M] Saved/pinned list views (localStorage), command-palette Actions group, global hotkeys.
- [S] Spanish translation value pass (parallelizable content work).

## Decisiones que tenés que tomar

### Decisión 1: Visual direction & the single token contract: ratify ONE globals.css contract before parallel agents build.

**Opciones:** Activated Restraint = Refined Restraint spine + Vibrant pillar identity (via @theme-registered bg-pillar-* utilities) + Warm & Human personality/warm-paper shadows + Signal Dense ratio bar; pillar map LOCKED as Inventory=teal/Access=indigo/Knowledge=green/Manage=rose, Consumables shares Inventory teal; static oklch literals (no color-mix/relative-color) · Pure Refined Restraint (craft/motion/depth only, minimal per-pillar color) — safest but may under-deliver visible spark · Vibrant Pillars lead (louder color-forward) — strongest first-glance but risks 'flood not seasoning' against ADR-0011

**Recomendación:** Activated Restraint. It is the only synthesis the judges converge on (9/9/8), is fully shippable today with zero new deps and zero primitive hand-edits, is AA-safe by construction (pillar hue never small text), and resolves the four visions' conflicting token names/pillar maps into one canonical contract so subagents don't diverge.

### Decisión 2: 'Some buttons / more life' interpretation — we read this as energy-through-motion/color/depth, not louder/more CTAs. Confirm?

**Opciones:** Confirm: motion + pillar color + elevation + delightful states satisfy 'onda' (current plan) · CEO actually wants more prominent action buttons / bolder primary / quick-create everywhere — re-weight toward visible CTAs (command-palette-as-create, inline-create, bolder buttons) · Both — add a modest CTA-prominence pass on top of the motion/color program

**Recomendación:** Confirm the motion/color/depth reading, but ALSO ship the command-palette-as-create-surface + inline-create-from-empty-states as a hedge (partially covers 'more ways to act'). This is the one explicit CEO phrase being reinterpreted, so it must be ratified, not assumed.

### Decisión 3: i18n / Spanish — new dependency + new capability (translating UI values), and sequencing vs the redesign.

**Opciones:** Approve next-intl (cookie-mode, no /es/ URLs) + new UI-i18n ADR; Phase 0–1 now (~1.5d, bilingual chrome+dashboard), rest incremental; ALL new redesign copy authored as catalog keys · Defer i18n entirely until the visual redesign lands — accept that the redesign hardcodes ~300–500 English strings that become extraction debt · English-only product permanently — drop Spanish

**Recomendación:** Approve next-intl Phase 0 BEFORE/ALONGSIDE the visual waves and require new copy to land as keys. For a 5–20-person internal tool cookie-mode is right (no route restructure, no middleware). Deferring forces the redesign to manufacture extraction debt it then has to chase. Coordinate the next.config.ts wrap with DevOps (ADR-0025).

### Decisión 4: Backend contract debt — which ADR-gated endpoints to greenlight now vs defer (the full vision needs these; frontend ships honestly without them).

**Opciones:** Greenlight only DEBT-1 (filterable activity endpoint, ~S–M, high-value, no schema change) now; defer the rest · Greenlight DEBT-1 + DEBT-2 (new UserHistory model + widen ActivityEntityTypeSchema — the largest piece, an ADR + the Page<T>-unwrap breaking-for-web trap that must land WITH its web consumer) · Greenlight none now — ship every frontend feature on the existing contract; revisit backend after the visual program lands

**Recomendación:** Greenlight DEBT-1 only now (unblocks real Informes filtering cheaply, parameterized WHERE on the existing view, no schema change). Defer DEBT-2/3/5 and the sparkline/delta time-series endpoint until the frontend proves demand — they each need their own ADR and DEBT-2 carries a breaking-for-web sequencing risk. Sparklines/deltas stay a Wave-4 fast-follow.

### Decisión 5: Dashboard right-rail composition (CEO feature #1).

**Opciones:** Recommended trio: Assets-by-status donut (CSS conic-gradient) + Access-health count panel + All-clear/Quick-actions tile — keeps the happy-path 'all clear' moment, zero backend · Swap the third tile for relocated Needs Attention — shorter page, loses the 'all clear' win · Defer the rail; just slim the feed + add pillar color to existing cards

**Recomendación:** Recommended trio. Every number comes from the existing GET /dashboard/summary (zero backend), the donut consumes the status tokens on the marquee surface, and the all-clear tile is a genuine delight beat. Keep Needs Attention + pillar cards full-width above the feed/rail split. Defer KPI deltas/sparklines/true expiring-timeline (all need the ADR-gated stats endpoint).

### Decisión 6: Offboarding message persistence + letterhead source (CEO feature #2).

**Opciones:** v1: inline-editable message + typed org name in localStorage (per-browser); proper org-level InstanceSettings.offboardingMessage/orgName/logo as a fast-follow · Wait for writable InstanceSettings first (new table + migration + settings:manage endpoint + ADR) before shipping the Act · Paper-only act with a fixed hardcoded message, no configurability

**Recomendación:** localStorage now, InstanceSettings as a fast-follow. The offboard ACTION needs zero backend (POST /users/:id/offboard already soft-deletes + revokes + releases transactionally); only the configurable message/letterhead needs the new store, and that's a data-model change requiring its own ADR + CEO sign-off — don't block the dignified-offboard win on it. Default flow: print-then-confirm (employee signs paper, then you confirm).

---

## Reconciliación con impeccable

> La dirección «Activated Restraint» de arriba sigue siendo la síntesis canónica. Esta nota
> **no la reescribe**: solo fija cuatro reconciliaciones (decisiones de CTO, issue #160 / epic
> #157) entre la síntesis y el sistema visual ahora documentado en la raíz como `DESIGN.md`
> (formato Google-Stitch) + `PRODUCT.md` + `.impeccable/design.json`, consumibles por la skill
> `impeccable` (`/impeccable <command>`). Donde la síntesis y estas reglas difieran, **mandan
> estas** (y el `DESIGN.md`).

1. **Acento de pilar = tinte / chip / dot, no barra.** La idea de **«3px accent bar»** que
   aparece en la síntesis (y la regla AA de ADR-0049) queda **superada** por la regla
   tint/chip/dot: prohibido un `border-left`/`border-right` **> 1px** de color de pilar en
   cards, filas, callouts o alerts. La identidad de pilar se expresa con un **icon chip tintado**
   (`bg-pillar-*/10` + glyph `aria-hidden`), un **dot** o un **tinte de fondo**. Única excepción:
   una regla de selección de **≤2px** en el nav activo como indicador de estado (pero preferir
   bg-tint + peso + color de icono).
2. **Motion solo en CSS.** Nada de librerías JS de animación (framer-motion, gsap, anime,
   lenis). Todo el movimiento vive en CSS + tw-animate-css, 150–250ms, conviendo estado y
   reduced-motion-safe. Sin coreografía de carga de página: el settle de ruta es un fade de
   opacidad sutil y el stagger de métricas es mínimo y solo en el mount inicial.
3. **El `--bone` es decisión de marca, no «AI cream default».** El canvas cálido es una
   decisión deliberada y comprometida (ADR-0011); la calidez también la cargan el motion, la
   identidad de color y la personalidad — no solo el fondo.
4. **El hue de pilar/chart nunca es texto legible.** Ni sobre bone ni sobre un tinte `/10`. El
   texto legible se queda en `--foreground` / `--card-foreground`, o se usa un `StatusBadge`
   semántico de relleno sólido con su `*-foreground` verificado AA. Las métricas llevan
   sustancia real (breakdowns deep-linked), no el hollow hero-metric template.

Detalle completo de tokens, reglas nombradas (One Voice · Pillar-as-Decoration · One-Family ·
Warm-Paper) y do's/don'ts: **`DESIGN.md`** en la raíz del repo.
