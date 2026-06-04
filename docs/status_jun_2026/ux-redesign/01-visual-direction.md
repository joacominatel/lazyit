# 01 · Dirección visual — las 4 visiones

## Puntajes de los jueces (1–10)

| Visión | Technical feasibility | CEO alignment | Impact & delight | Prom |
| --- | --- | --- | --- | --- |
| Refined Restraint (Linear/Vercel-grade craft) | 9 | 9 | 8 | **8.7** |
| Vibrant Pillars (bold categorical color) | 6 | 6 | 9 | **7.0** |
| Warm & Human | 6 | 8 | 7 | **7.0** |
| Signal Dense | 5 | 5 | 7 | **5.7** |

**Recomendaciones de los jueces:**

- **Technical feasibility (Tailwind v4 + vendored shadcn + heroicons-only + AA + tw-animate-only + effort)** → Ship Refined Restraint as the spine — the only vision whose full scope is shippable today with zero new dependencies, zero vendored-primitive hand-edits, structurally-guaranteed AA, and the smallest verification surface. Lead with the globals.css foundation all four visions share and which carries no AA or data risk: (1) the named motion vocabulary (--ease-*/--dur-* + hand-authored @keyframes in @layer utilities, since tw-animate-css ships only enter/exit/accordion/collapsible/caret-blink — confirmed), (2) the warm-tinted oklch elevation scale with the dark-mode 2x-alpha + inset top-highlight, (3) the named type tokens, and (4) the token de-hardcoding pass that kills the three confirmed raw-Tailwind breaks (dashboard/page.tsx:409-410 amber-500/rose-500 -> --warning/--destructive; recent-activity-panel.tsx:131-133 sky/violet/amber -> chart tokens). That bundle is pure-token + pure-composition, AA-safe, reduced-motion-safe, and is the literal common denominator of every vision. THEN add per-pillar identity as a small, bounded follow-up, and resolve the one cross-cutting decision the whole field punts on: how --pillar is delivered. Do NOT default to bg-[var(--pillar)]/10 arbitrary-var-with-opacity that Visions 1/2/4 lean on — the repo has ZERO arbitrary-var color usage and avatar-color.ts explicitly warns the JIT scanner needs full non-interpolated class strings. Adopt Warm & Human's mechanism: register --color-pillar-* in @theme inline exactly as --color-avatar-* / --color-chart-* already are, so Tailwind emits real, scanner-safe bg-pillar-*/text-pillar-* utilities, and set the per-pillar value via a single <PillarScope> wrapper (Vibrant's idea) with a sane indigo fallback so a missing wrapper degrades gracefully. Keep pillar color as tint/border/chip only (Refined Restraint's AA rule), never as small text on bone — that sidesteps the amber-on-bone / amber-on-tint AA fragility that drags down Warm & Human and Vibrant. Avoid, for now, color-mix(in oklch) and oklch(from ...) relative-color (Vibrant/Signal Dense): both are unused in the repo and add a browser-baseline question for a self-hosted install — precompute any derived tints/strong-tokens as static oklch values instead. Treat Signal Dense's sparklines and week-over-week deltas as a separate, ADR-gated initiative: DashboardSummary is a point-in-time snapshot with no per-day series, so those need a @lazyit/shared + NestJS contract change and must not block the visual win. Net: Refined Restraint's discipline + Warm & Human's @theme-registration JIT mechanism + Vibrant's PillarScope fallback is the lowest-risk, highest-craft shippable path.
  - Injertar: From Warm & Human: register --color-pillar-* in @theme inline (mirroring the existing --color-avatar-* / --color-chart-* registration) so Tailwind emits REAL bg-pillar-*/text-pillar-* utilities. This is the single most important technical graft — it avoids the unproven bg-[var(--pillar)]/10 arbitrary-var path that Visions 1/2/4 rely on, and which avatar-color.ts already warns is JIT-scanner-fragile. Use it as THE delivery mechanism for Refined Restraint's pillar identity.; From Vibrant Pillars: the <PillarScope> wrapper component with a graceful indigo fallback. Since only one (app)/layout.tsx exists today, per-segment --pillar plumbing is otherwise N new layout files with a hard-fail if one is forgotten; a single wrapper with a default makes a missing pillar degrade to today's neutral look instead of uncolored chrome.; From Vibrant Pillars: ship the --pillar tokens AND the de-hardcoding sweep in the SAME change, then add an eslint/grep guard flagging raw bg-emerald/sky/violet/amber/rose-NNN in feature code. The only proposal that prevents token-discipline rot from recurring (the exact regression that produced the current activity-panel break) — pure tooling, zero AA/runtime risk.; From Signal Dense: the operational-health stacked ratio bar built from EXISTING byStatus data + --success/--warning/--muted tokens (plain divs, no chart lib, no backend change). Delivers real 'is my fleet healthy?' signal with the same feasibility profile as Refined Restraint — unlike its sparklines/deltas, it needs no new data contract, so it's the one data-viz moment safe to ship now.; From Signal Dense: the dark-mode elevation refinement — shadows on pure-black (not warm-bone hue) at higher alpha PLUS a 1px inset top highlight (inset 0 1px 0 oklch(0.97 0.004 95 / 0.04)) so raised surfaces catch light on the near-black canvas. Both Refined Restraint and Warm & Human note warm shadows muddy/disappear in dark; this is the cleanest fix and should be the canonical dark elevation recipe.; From Signal Dense / Refined Restraint: gate sparklines and week-over-week deltas as an explicit ADR-gated fast-follow, NOT part of the visual PR. DashboardSummary is a verified point-in-time snapshot with no per-day series — surfacing this as a separate workstream protects the shippable visual win from the slower backend contract change in @lazyit/shared + NestJS.; From Warm & Human: build EmptyState and the 'lift' recipe as NEW composable components (components/empty-state.tsx, a lift className in lib/utils), never as edits to vendored components/ui/card.tsx. The cleanest ADR-compliant pattern for adding elevation/lift app-wide without a shadcn CLI regenerate of the Card primitive.
- **CEO alignment (warm, calm-but-with-onda, evolves ADR-0011 not trashes it, not flashy)** → WINNER: Refined Restraint, with a deliberate warmth graft from Warm & Human. Through the CEO-alignment lens this is not close on first principles: the brief has two halves in tension — 'add spark/life/onda' AND (ADR-0011, his own prior direction) 'warm, calm, ONE disciplined accent, never #fff/#000, color is seasoning ~5% of pixels, not flashy.' The winner is the one that adds onda WITHOUT relighting the very dial the CEO told us to keep low. Refined Restraint is the only direction whose core thesis correctly diagnoses this ('not too little color — too little craft') and delivers energy through motion, elevation and finish rather than louder color. It is also safest on the two hard constraints: it never puts pillar color into TEXT (tints are /10 backgrounds only, text stays on --foreground), structurally dodging the amber-on-bone AA trap the ADR was written to avoid; and it uses plain alpha shorthand + precomputed oklch shadows rather than runtime color-mix/relative-color (which appears nowhere in app source today and is real risk for self-hosted installs). Zero new dependencies, one reduced-motion block, a file-by-file activation series. Its ONE weakness against the mandate is that its restraint may under-deliver VISIBLE spark — a CEO who said 'no onda, give me some buttons' might look at barely-there warm shadows and quiet 3px accents and still feel it's too subtle. That gap is exactly what Warm & Human fills: its WARM paper-shadow language and the genuine emotional warmth of its empty-state/success-toast personality are the most on-brand expression of the 'hueso y gris' anchor of any vision. So: ship Refined Restraint's craft/motion/elevation/token-activation SKELETON, but warm its shadow tint toward Warm & Human's paper register and adopt Warm & Human's microcopy/empty-state warmth so the calm reads as 'cared-for workshop,' not 'austere SaaS.' Reject Signal Dense as a direction (aesthetic pivot + data it can't ship); treat Vibrant Pillars as a graft source only — its wayfinding concept is the best single idea in the set but its VOLUME violates 'seasoning not flood.' Sequence per ADR-0011's own precedent: land the token layer first (motion vocabulary, warm elevation scale, --pillar var, de-hardcoding the verified breaks at page.tsx 409-410 and recent-activity 131-133), then the per-surface composition waves — exactly how amendments 1-3 rolled out.
  - Injertar: From Warm & Human — the WARM paper-shadow tint (--shadow-color 30 25 20, warm brown-black) is a more on-brand elevation than Refined Restraint's subtler warm-oklch shadow; graft it so the depth language reads explicitly 'paper on a warm desk,' the truest extension of the CEO's 'hueso' warmth and the cheapest way to make the calm feel alive rather than austere.; From Warm & Human — the personality/microcopy layer (empty states that invite: 'No assets yet. Add the first one and it will show up here'; success toasts that reassure: 'User archived — their access is revoked, history is safe'; the reusable EmptyState with a tinted rounded icon circle). Refined Restraint's copy register is correct but thin; this is where visible human warmth lives without a single saturated pixel — directly serves the onda the CEO wants.; From Vibrant Pillars / Signal Dense — the single inherited --pillar CSS variable set once per route group (data-pillar + style on the (app) sub-section wrapper) with a graceful brand-indigo fallback. The cleanest mechanism of the four (zero per-component color literals); use it as the implementation substrate for Refined Restraint's quieter per-pillar accents.; From Vibrant Pillars — the per-pillar NAV wayfinding (active item gets a soft --pillar tint + 2px left accent bar; section headings get a pillar-tinted left rule). The strongest single 'you are here' idea in the set; adopt it at Refined Restraint's restrained volume (the 3px rule, not a full tinted highlight) so it reads as quiet compass, not color flood.; From Signal Dense / Warm & Human — date-group dividers in the activity feed ('Today / Yesterday / Earlier') plus the avatar settle-in. A calm, no-data-required upgrade that makes the feed feel like a living story without implying real-time streaming (keep honest 'Updated Ns ago' copy, NOT a 'Live' label) — energy from structure, not animation overload.; From Signal Dense — the operational-health ratio bar (stacked --success/--warning/--muted-foreground track) on the Assets tile. Unlike its sparklines/deltas it needs NO new backend data (reads existing byStatus), is pure divs + existing tokens, and answers 'is my fleet healthy at a glance' — a legitimate light-data-viz win fully inside the calm/warm/AA rails.; From ALL four (consensus, mandatory regardless of winner) — fix the verified token-discipline breaks as the first commit of any wave: re-tone dashboard/page.tsx TONE map lines 409-410 (bg-amber-500/bg-rose-500 -> bg-warning/bg-destructive) and recent-activity-panel.tsx ENTITY_TONE lines 131-133 (sky/violet/amber -> --chart-*/pillar tokens). Cheapest, highest-confidence move; unblocks theme-correct dark mode.
- **Impact & delight (does it truly add the life/dynamism/practicality the CEO asked for)** → Through the Impact & delight lens, VIBRANT PILLARS (9) is the recommended primary direction: the most direct, highest-leverage, lowest-dependency answer to the CEO's literal complaint ('too neutral, no color, no onda'). Its core move — promoting the five already-defined-but-dead chart hues into one inherited --pillar variable that turns the dashboard into a color-coded map of the estate — is a first-GLANCE win (the CEO sees it the instant the dashboard loads, not just on hover) that ships with no backend change and no new dependency, and its orthogonal indigo=ACTION / pillar=PLACE / status=STATE framing is the discipline that keeps 'colorful' from becoming 'noisy.' Crucially the four visions are NOT mutually exclusive — they share one identical technical spine, verified as real gaps in the code: the --pillar inheritance var + a warm-tinted 3-4 step elevation scale + a CSS-first @keyframes motion vocabulary + de-hardcoding the TONE/ENTITY_TONE maps. The right build: take Vibrant Pillars' color system and engineering rigor (the eslint guard against raw palette colors is essential) as the backbone, graft REFINED RESTRAINT's superior motion craft and AA-by-construction discipline so the color never reads loud, add WARM & HUMAN's personality layer (empty states, microcopy, the dignified offboard) so it has soul, and stage SIGNAL DENSE's data-viz moments as a fast-follow phase-2 once a sparkline/delta backend contract is agreed (it is ADR-gated and must not block the phase-1 visual win). Sequence it exactly as every vision independently advises: a tokens-first PR (globals.css: --pillar-*, tints, elevation, keyframes, one reduced-motion block) that everything builds on, then per-surface PRs (PillarCard, sidebar-nav, recent-activity-panel, attention rows), one file per commit per CLAUDE.md, each AA-checked. This delivers visible color/dynamism immediately with Linear-grade finish and a clear runway to the cockpit-grade payoff without smuggling in a backend dependency or a motion library.
  - Injertar: From Vibrant Pillars (the backbone): the single --pillar inheritance variable set once per (app) route segment, mapped onto the existing --chart-1..5 hues, read everywhere via var(--pillar) — zero per-component color literals. Highest-leverage mechanism across all four visions and the literal answer to 'too neutral.'; From Vibrant Pillars: the orthogonal three-color-language discipline — indigo=ACTION, pillar hue=PLACE, semantic token=STATE, never mixed on the same element — plus the explicit guard against the green-Knowledge-pillar vs green-success-status collision. The conceptual rule that makes 'colorful but not noisy' actually hold.; From Vibrant Pillars: ship the --pillar/--tint/--pillar-* tokens AND the raw-Tailwind de-hardcoding sweep (fixing the real bg-amber-500/bg-rose-500 TONE map and the sky/violet/amber ENTITY_TONE) in the same change, then add an eslint/grep guard flagging raw bg-{emerald,sky,violet,amber,rose}-NNN in feature code so the system can't rot back to the drift that exists today.; From Refined Restraint: the coordinated hover triad (lift -translate-y-0.5 + shadow elevation 1->2 + ring 10->15 doing THREE things at once) — the most reliable 'crafted, not a flat bg swap' tell — plus its AA-by-construction rule that a /10 tint background NEVER carries text (text always on --foreground/--card-foreground), which makes the whole color program structurally AA-safe.; From Refined Restraint: the named motion vocabulary as tokens (--ease-out-quad workhorse, --ease-spring reserved ONLY for the success checkmark's single gentle overshoot, --dur-fast/base/slow) and the single consolidated @media (prefers-reduced-motion: reduce) block — so every surface speaks one motion dialect and degrades to instant in one place.; From Refined Restraint + Signal Dense (convergent): the warm-tinted oklch elevation scale using the foreground hue (oklch 0.21 0.006 75 / a) for light, and black-at-higher-alpha + a 1px inset top highlight for dark so raised surfaces catch light against the near-black canvas where neutral shadows are invisible. The dark-mode inset hairline is the detail that sells 'premium console.'; From Warm & Human: the reusable EmptyState component (3x heroicon on a fully-rounded bg-[var(--pillar)]/10 circle + warm one-line invitation + primary action, rise-in on mount) replacing today's utilitarian dashed-border boxes — the most ships-tomorrow, cross-pillar delight deliverable of any vision.; From Warm & Human: the dignified destructive-completion pattern — the offboard fade-and-collapse with a self-drawing success check and 'History is safe' microcopy — establishing that delight does NOT extend to whimsy in destructive flows; those get a confident, respectful 'done.'; From Signal Dense: the offboard/delete success toast as a DATA report — 'Revoked 4 grants, released 2 assets' — reporting impact as numbers. The single most satisfying micro-moment proposed, on-brand for a data app, and it needs no new backend (the counts already exist at delete time).; From Signal Dense (phase-2, ADR-gated): inline SVG sparklines (var(--pillar) stroke + 10% area fill, draw-on-mount, no chart lib) and tinted week-over-week delta chips on KPI tiles — explicitly deferred as a fast-follow once a counts-by-day / prior-period DashboardSummary contract is agreed, so the phase-1 visual win is never blocked on backend data work.; From Signal Dense + all (convergent): universal tabular-nums + named numeric type tokens (--text-metric/-display) and a count-up arrival on big metrics so headline numbers feel instrument-grade and 'boot up' on load — the cheapest high-impact 'alive' moment. Prefer Refined Restraint's CSS-only .rise-in mount over a rAF hook unless real value-tweening is needed, to avoid net-new render JS.; From Vibrant Pillars + Warm & Human (convergent): finish avatarColorFor() coverage on every people surface still missing it (asset owner chips, application grantee rows, assignee lists, settings user list) so identity color (WHO) is universal and coexists with pillar color (WHERE) — finishing the categorical system on both the people and the area axis.

---

## Refined Restraint (Linear/Vercel-grade craft)

**Tesis:** The base is already right — warm bone canvas, warm-gray ink, one disciplined indigo. The problem is not too little color; it's too little *craft*. "Onda" arrives the moment every surface starts behaving with intention: cards lift a hair on hover, focus rings snap crisp, sections settle in with a 12px rise, numbers tick, the five categorical hues finally do their job as quiet per-pillar identity (a 3px accent bar, a tinted icon chip — never a flood). This direction is Linear/Vercel-grade restraint: zero new dependencies, CSS/tw-animate only, AA preserved everywhere. We add an elevation scale (the codebase has none — Card is flat ring-1), a named motion vocabulary (~140-220ms, ease-out, reduced-motion-safe), and 5-6 signature moments. The result reads expensive and alive without ever reading loud. We evolve the system by *activating* tokens that already exist (--chart-1..5, --success/--warning/--info) and adding three small token families (--elevation-*, --ease-*, --pillar) — we trash nothing.

- **Color:** EVOLVE, don't repaint. Keep --background bone, --foreground warm-gray, --primary indigo oklch(0.55 0.18 275) exactly as-is. Three concrete moves, all AA-verified:

1) PER-PILLAR IDENTITY via a --pillar variable bound at route level, sourced from the EXISTING chart ramp — no new hues. Map: Dashboard/Access = --chart-1 indigo 275 (the brand stays Access's color, resolving the Access-vs-Applications split); Inventory/Assets = --chart-2 teal oklch(0.62 0.14 200); Knowledge = --chart-3 green oklch(0.65 0.15 150); Consumables = --chart-4 amber oklch(0.74 0.16 75); Manage/Users = --chart-5 rose oklch(0.62 0.2 15). The pillar shows ONLY as: a 3px left accent bar, a tinted icon chip (bg `--pillar`/10, text `--pillar`), and the active-nav left rule. Body text, surfaces and structure stay warm-neutral. Color is seasoning, ~5% of pixels.

2) Add a TINTED elevation tone so cards aren't pure flat fill. New --card-elevated = oklch(0.998 0.003 95) light / oklch(0.275 0.008 75) dark — a half-step above --card, paired with the new shadow scale so a raised surface reads via tone AND shadow, not opacity tricks.

3) Activate semantic-status discipline: the dashboard's hardcoded TONE map (bg-amber-500 / ring-rose-500/30 in dashboard/page.tsx lines 408-411) and the activity feed's hardcoded sky/violet/amber (recent-activity-panel.tsx lines 130-134) both move to tokens — warning→`--warning`, danger→`--destructive`, and pillar chips→`--chart-*`. One refactor kills the raw-Tailwind drift. Dark-mode parity is already defined for every token used, and the chart ramp / status tokens are AA-verified at the lightnesses cited in globals.css (success 4.74:1, warning 8.58:1, info 4.69:1 light; 8.08/10.99/7.16 dark). A tint at /10 background never carries text — text always sits on --foreground or --card-foreground — so AA is structurally guaranteed.
- **Motion:** CSS-and-tw-animate-FIRST, zero JS motion lib. Define a named easing + duration vocabulary as tokens in globals.css so every surface speaks the same dialect:
--ease-out-quad: cubic-bezier(0.25, 0.46, 0.45, 0.94) (the workhorse — settles, never bounces); --ease-spring: cubic-bezier(0.34, 1.3, 0.64, 1) (one gentle overshoot, reserved for success/check only); --dur-fast: 120ms; --dur-base: 180ms; --dur-slow: 220ms.

Four motion classes, all built on @keyframes inside @layer utilities (tw-animate-css supplies fade/zoom/slide we already use for Radix; we add the surface-level ones):
- .lift — hover transition on cards/rows: transition-[transform,box-shadow,ring] duration-[--dur-base] ease-[--ease-out-quad]; hover:-translate-y-0.5 + elevation step-up. The signature "this is interactive" tell.
- .rise-in — section/card entrance: @keyframes from { opacity:0; translateY(12px) } to { opacity:1; translateY(0) }, --dur-slow ease-out. Staggered via inline --i*40ms delay on grids (pillar cards, activity rows).
- .press — active state: active:scale-[0.98] (replaces the bare active:translate-y-px on plain surfaces; Button keeps its existing translate-y-px so primitives aren't hand-edited).
- .count-up — handled in JS-free CSS where possible; the metric number gets a .rise-in on mount so the count "arrives."

Press feedback: Button already has transition-all + focus-visible:ring-3 — we DON'T touch the primitive, we just adopt its language on composed surfaces. Crisp focus is non-negotiable: focus-visible:ring-2 ring-ring ring-offset-2 ring-offset-background on every interactive composed element.

prefers-reduced-motion: a single @media (prefers-reduced-motion: reduce) block sets animation:none and transition-duration:0.01ms on .rise-in/.lift/.count-up, and disables translate on hover — surfaces still get the elevation/tone change, just instantly. This ships in the same globals.css change.
- **Profundidad/elevación:** The codebase has NO elevation language — Card is flat (ring-1 ring-foreground/10, shadow-none), DetailPanel duplicates it, and shadow-md/lg appear only ad-hoc on Radix popovers and the sticky batch bar. Introduce a 4-step scale as tokens so depth is named, not pixel-guessed. Warm-tinted shadows (hue ~75, never neutral black) so they sit in the warm system:
--elevation-0: none — table rows, inline list items (flat, ring-foreground/10 only).
--elevation-1: 0 1px 2px oklch(0.21 0.006 75 / 0.06), 0 1px 1px oklch(0.21 0.006 75 / 0.04) — resting cards (PillarCard, DetailPanel). Replaces today's flat look with a barely-there grounding.
--elevation-2: 0 4px 12px -2px oklch(0.21 0.006 75 / 0.10), 0 2px 4px -2px oklch(0.21 0.006 75 / 0.06) — hover/active card state, detail panels in focus.
--elevation-3: 0 12px 28px -6px oklch(0.21 0.006 75 / 0.14) — floating: dialogs, dropdowns, sticky batch bar, command palette.
Dark mode: same scale but shadows at ~2x alpha plus a 1px top inner highlight (inset 0 1px 0 oklch(0.97 0.004 95 / 0.04)) so raised surfaces catch light against the near-black canvas — shadow alone is invisible on dark.
Hierarchy rule: ring intensity tracks elevation. Resting = ring-foreground/10; raised/focused = ring-foreground/15; floating = elevation-3 + no ring. So a card hover does THREE coordinated things — lift 2px, shadow 1→2, ring 10→15 — which is what makes it feel crafted rather than a flat bg swap. Sticky surfaces (batch bar, sub-nav) get elevation-3 + bg-background/85 + backdrop-blur-sm so scrolled content reads clearly beneath.
- **Tipografía:** Keep Geist + Geist Mono and the disciplined single-title scale (PageHeader's fixed text-2xl is sacred — don't reintroduce drift). Refine, don't expand wildly. Add a named semantic scale as tokens so "big number" vs "small label" is intentional:
--text-display: 1.875rem / 2.25rem / -0.02em (dashboard hero metrics — the pillar counts, currently a bare text-2xl tabular-nums; bump weight to 600 and tighten tracking so big numbers feel engineered).
--text-title: 1.5rem / 2rem / -0.015em (PageHeader h1 — codifies the existing text-2xl).
--text-body: 0.875rem / 1.25rem / 0 (the app's text-sm default, unchanged).
--text-label: 0.75rem / 1rem / 0.02em UPPERCASE (section eyebrows like "Needs attention", nav headings — the existing tracking-wide uppercase pattern, now tokenized).
--text-mono-num: Geist Mono, tabular, -0.01em for all metric/count surfaces — the app already uses tabular-nums; make mono the rule for stat numbers so they align in columns and feel instrument-grade.
Weights: alias --fw-normal 400 / --fw-medium 500 / --fw-semibold 600. The one real change: metric numbers go 600 + mono + tighter tracking (currently 600 sans). Everything else is codifying what's already there so it stops being pixel-guessed. No heroic size jumps — restraint means the type scale stays tight; craft comes from tracking + tabular alignment + weight discipline, not size theatrics.
- **Personalidad:** Quietly excellent. The voice of a senior IT lead who has their estate handled — calm, precise, never shouty, with dry warmth. Microcopy is plain and human: empty states say "Nothing needs attention right now" (already good — keep that register), success toasts are brief and confident ("Asset released. History updated."), errors are honest and actionable ("The API may be down" + request id — already the pattern). No exclamation marks, no emoji, no "Oops!" Delight is earned through craft, not cuteness: the satisfying snap of a focus ring, the 2px lift, the count that arrives, the checkmark that draws itself. Personality lives in the *motion and finish*, not in copy gimmicks. Think Linear's restraint, Vercel's crispness, Stripe's confidence — a tool that respects a small IT team's time and makes the boring durable work feel a little bit premium. The "some buttons" the CEO wants are there, but they're disciplined: one primary action per surface, outline for secondary, and they reward the press.

**Momentos signature:**
- Pillar accent + lift on dashboard cards: each PillarCard gets a 3px top (or left) accent bar in its --pillar hue, the icon chip recolors from bg-primary/10 to bg-[--pillar]/10 text-[--pillar], and on hover the whole card does the coordinated .lift (–translate-y-0.5, elevation 1→2, ring 10→15). The five-hue identity finally reads — Assets teal, Access indigo, Knowledge green, Consumables amber — at a glance, calmly.
- Metrics that arrive: the big pillar counts and 'Needs attention' numbers mount with .rise-in (12px rise + fade, mono tabular, weight 600, tight tracking) staggered ~40ms across the grid via --i. On a fresh dashboard load the numbers settle into place like an instrument booting — the single most 'alive' moment, costs nothing, AA-safe.
- Self-drawing success checkmark: replace the bare spinner-then-toast on delete/offboard/grant success with an SVG check that draws via stroke-dasharray + the --ease-spring's single gentle overshoot, in --success green, then the toast slides in. Turns a destructive/heavy operation's completion into a reassuring beat. Reduced-motion: check appears instantly filled.
- Crisp focus + row-reveal on lists: ResourceTable rows get .lift-lite (bg + ring on hover, no translate to keep tables steady) and reveal their trailing action affordance (the ArrowRight / actions menu) on hover/focus via opacity 0→100 transition. Focus-visible draws the ring-2 ring-ring ring-offset-2 instantly and sharply — the keyboard-nav experience suddenly feels first-class.
- Pulsing attention dot, tokenized: the 'Needs attention' rows currently hardcode bg-amber-500/bg-rose-500. Move to --warning/--destructive AND give the danger dot a slow, calm .pulse-soft (opacity 1↔0.55 over 2.4s, ease-in-out) — it breathes, it doesn't alarm. A lost asset gently asks for attention instead of screaming.
- Section settle on route change: the page content wrapper plays one .rise-in (12px, --dur-slow) on mount so navigating between Inventory/Access/Knowledge feels composed rather than a hard cut — the whole app gains a consistent 'settling' rhythm. Sidebar active item gets a --pillar left-rule that slides to the new item, tying the pillar color to navigation.

**Movimientos concretos de token/CSS:**
- globals.css :root — add motion vocabulary: --ease-out-quad: cubic-bezier(0.25,0.46,0.45,0.94); --ease-spring: cubic-bezier(0.34,1.3,0.64,1); --dur-fast: 120ms; --dur-base: 180ms; --dur-slow: 220ms;
- globals.css :root — add warm-tinted elevation scale: --elevation-1: 0 1px 2px oklch(0.21 0.006 75 / .06), 0 1px 1px oklch(0.21 0.006 75 / .04); --elevation-2: 0 4px 12px -2px oklch(0.21 0.006 75 / .10), 0 2px 4px -2px oklch(0.21 0.006 75 / .06); --elevation-3: 0 12px 28px -6px oklch(0.21 0.006 75 / .14);  then in .dark redefine each at ~2x alpha + add inset 0 1px 0 oklch(0.97 0.004 95 / .04).
- globals.css :root — add --card-elevated: oklch(0.998 0.003 95); .dark --card-elevated: oklch(0.275 0.008 75); and @theme inline { --color-card-elevated: var(--card-elevated); } so a raised surface tone exists.
- globals.css @theme inline — expose elevation as utilities: --shadow-e1: var(--elevation-1); --shadow-e2: var(--elevation-2); --shadow-e3: var(--elevation-3); (enables shadow-e1/e2/e3). Add named type tokens --text-display/--text-title/--text-label and --fw-* aliases.
- globals.css @layer utilities — add @keyframes rise-in { from { opacity:0; transform:translateY(12px) } to { opacity:1; transform:none } } and .rise-in { animation: rise-in var(--dur-slow) var(--ease-out-quad) both; } plus .pulse-soft { animation: pulse-soft 2.4s ease-in-out infinite } with @keyframes pulse-soft { 0%,100%{opacity:1} 50%{opacity:.55} }.
- globals.css — add @media (prefers-reduced-motion: reduce) { .rise-in,.pulse-soft,.lift { animation:none !important; transition-duration:.01ms !important } .lift:hover{transform:none} } so all signature motion degrades to instant.
- Per-pillar var: set --pillar on each route segment layout, e.g. app/(app)/assets/layout.tsx wrapper style={{['--pillar' as string]: 'var(--chart-2)'}}; Access=--chart-1, Knowledge=--chart-3, Consumables=--chart-4, Manage=--chart-5. Components consume via className like 'text-[var(--pillar)]' / 'bg-[var(--pillar)]/10' / accent bar 'bg-[var(--pillar)]'.
- dashboard/page.tsx PillarCard: pass a pillar prop; recolor icon chip from 'bg-primary/10 text-primary' to 'bg-[var(--pillar)]/10 text-[var(--pillar)]', add accent bar <div className='h-0.5 -mt-4 -mx-px mb-3 rounded-full bg-[var(--pillar)]/70'/>, add className 'shadow-e1 transition-[transform,box-shadow] duration-[--dur-base] ease-[--ease-out-quad] hover:-translate-y-0.5 hover:shadow-e2 hover:ring-foreground/15'. Bump metric span to mono: 'font-mono text-[length:var(--text-display)] font-semibold tabular-nums tracking-tight'.
- dashboard/page.tsx TONE map (lines 408-411): replace { dot:'bg-amber-500', ring:'ring-amber-500/20' } → { dot:'bg-warning', ring:'ring-warning/25' } and danger → { dot:'bg-destructive', ring:'ring-destructive/30' }; add 'group-data-[tone=danger]:[&_.dot]:pulse-soft' or apply .pulse-soft to the danger dot span.
- recent-activity-panel.tsx ENTITY_TONE (lines 130-134): replace hardcoded sky/violet/amber with token chips — asset:'bg-[var(--chart-2)]/12 text-[var(--chart-2)]', application:'bg-[var(--chart-1)]/12 text-[var(--chart-1)]', consumable:'bg-[var(--chart-4)]/12 text-[var(--chart-4)]'; add .rise-in with style={{['--i']:index}} and animation-delay:calc(var(--i)*40ms) on each ActivityRow.
- detail-panel.tsx + card.tsx CONSUMERS (not the primitives): apply 'shadow-e1' to resting DetailPanel sections and add the .lift hover triad on interactive cards at the call site (composition, per ADR — primitives in components/ui/* stay untouched; if Card needs a default shadow, regenerate via shadcn CLI, do not hand-edit).
- sidebar-nav.tsx active item (lines 110-117): keep bg-sidebar-accent but add a 3px left rule in pillar color: when active, prepend <span className='absolute left-0 inset-y-1 w-0.5 rounded-full bg-[var(--pillar)]'/> (set --pillar per section heading: Inventory chart-2, Access chart-1, Knowledge chart-3, Manage chart-5) — quiet pillar wayfinding without a loud highlight.
- list/detail page wrappers: add className='rise-in' to the top-level content div of (app) pages so each route settles in on mount (the (app)/layout.tsx main element or per-page root).

**Mockup del dashboard:**

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  lazyit         Dashboard                          Updated 2m ago  [⟳ Refresh] │  ← h1 text-title, tracking-tight
│  ─────────                                                                     │
│  ░ Dashboard    [+ New asset] [+ Add stock] [Grant access]   ← outline, .press │
│  INVENTORY                                                                     │
│  │▌Assets       NEEDS ATTENTION                          ← --text-label eyebrow │
│  │ Consumables  ┌────────────────────────────┐ ┌────────────────────────────┐ │
│  ACCESS         │ ⚠ 3 grants expiring ≤30d ●│ │ ⚠ 2 low-stock consumables ●│ │  ← ● dot = --warning
│  │▌Applications │   (warning ring/25)      →│ │   (warning ring/25)      → │ │
│  KNOWLEDGE      └────────────────────────────┘ └────────────────────────────┘ │
│  │ Knowledge    ┌────────────────────────────┐                                │
│  MANAGE         │ ⛔ 1 asset marked lost  (●)│  ← (●) danger dot .pulse-soft   │
│  │ Users        │   (destructive ring/30) → │     breathing 2.4s, not alarming│
│  │ Locations    └────────────────────────────┘                                │
│  │ Settings                                                                    │
│                 ▔▔▔ teal   ▔▔▔ indigo   ▔▔▔ green   ▔▔▔ amber  ← 3px pillar bar│
│                 ┌──────────┐┌──────────┐┌──────────┐┌──────────┐              │
│                 │▢ teal    ││▢ indigo  ││▢ green   ││▢ amber   │ ← icon chip   │
│                 │ Assets   ││ Access   ││ Knowledge││Consumable│   bg-pillar/10│
│                 │          ││          ││          ││          │              │
│                 │  142     ││   38     ││   27     ││   15     │ ← mono tabular│
│                 │  assets  ││ grants   ││ articles ││  items   │   display,.rise│
│                 │ ─────────││ ─────────││ ─────────││ ─────────│   stagger 40ms│
│                 │ Oper. 120││ Crit.  4 ││ Pub.  22 ││ Low    2 │              │
│                 │ Maint. 8 ││ Exp.   3 ││ Draft  5 ││          │ ← rows reveal │
│                 │ 96 assigned →        ││ Browse → ││ Browse → │   action on   │
│                 │ Browse →  ││ Manage → │└──────────┘└──────────┘   hover      │
│                 └──────────┘└──────────┘                                      │
│        ↑ hover = .lift: -translate-y-0.5 + shadow-e1→e2 + ring/10→/15          │
│                                                                                │
│                 RECENT ACTIVITY                          ← --text-label eyebrow │
│                 ┌────────────────────────────────────────────────────────────┐│
│                 │ ▢teal  Asset MBP-14 released by      (JM) Joaquin    2m ago ││  ← chip --chart-2
│                 │  │     ▢indigo  Grant revoked on Figma  (AS) Ana   18m ago  ││     avatar = avatar-*
│                 │  │     ▢amber   Stock -5 USB-C cables   (sys) System 1h ago ││     rows .rise-in
│                 │              [ Load more ]  ← outline .press                 ││     stagger 40ms
│                 └────────────────────────────────────────────────────────────┘│
│                   card: shadow-e1 resting · backdrop layers read via tone+shadow│
└──────────────────────────────────────────────────────────────────────────────┘
 Legend: ▌=pillar left-rule on active nav · ▔=3px pillar accent bar · ●=token dot
 All motion ≤220ms ease-out · reduced-motion → instant · AA preserved on every fill
```

**Riesgos:** Per-pillar --pillar via route-level layouts adds a layout file (or wrapper) per pillar segment — low risk but touches routing; must verify nested routes (e.g. /assets/[id]) inherit the var. Mitigate by setting it on the (app) segment with a data-attr the CSS reads, or on each pillar's layout.tsx.; Tailwind v4 JIT must keep dynamic-looking classes. bg-[var(--pillar)]/10 and arbitrary shadow-e* utilities need the @theme inline aliases and full non-interpolated strings (the avatar-color.ts comment already flags this scanner constraint) — anything built from a variable must be a complete class string, not concatenated.; Card/StatusBadge/Button are vendored shadcn primitives that must NOT be hand-edited. The elevation/lift/pillar work lives at composition (call sites) or in globals.css tokens; if a primitive truly needs a default shadow, it must be regenerated via the shadcn CLI — flag any such need rather than editing components/ui/*.; Staggered .rise-in on long lists (activity feed, ResourceTable with 50 rows) could feel sluggish if every row animates on every paginate. Mitigate: cap stagger to first ~8 items, animate only on initial mount (not on 'Load more' appends), and gate behind prefers-reduced-motion.; No motion library is installed and none is proposed — but the self-drawing checkmark + count-arrival are the limit of what CSS does cleanly. If product later wants spring physics or shared-element transitions, that's a NEW-DEPENDENCY decision (framer-motion) requiring an ADR; do not smuggle it in.; Warm-tinted oklch shadows are subtle by design and can disappear on cheap displays / in dark mode — hence the dark-mode 2x-alpha + inset top highlight. Must visually QA both themes on a real panel before locking the elevation alphas; numbers given are a strong starting point, not gospel.; Scope creep: activating tokens touches many files (dashboard, activity, sidebar, detail-panel, list wrappers). Keep to the file-by-file commit discipline and land it as a cohesive 'design-system activation' series, not one mega-commit, so review and rollback stay clean.

---

## Vibrant Pillars (bold categorical color)

**Tesis:** Wake up the five dormant categorical hues by binding each pillar to one identity color that flows, automatically, through nav, page headers, cards, badges and the activity feed. The warm bone canvas and the single deep-indigo brand stay exactly as ADR-0011 set them — indigo remains the action color (buttons, focus rings, active nav). The evolution is that *area* (which pillar you're in) gets color where today everything is neutral: Inventory=teal (chart-2), Access=indigo (chart-1, reusing the brand hue as the pillar hue), Knowledge=green (chart-3), Manage/People=amber (chart-4), with rose (chart-5) reserved for danger/lost. The mechanism is a single inherited CSS variable, --pillar, set once per route group, that downstream chrome reads via var(--pillar) instead of hardcoding emerald/sky/violet. This turns the five-hue system from 95% unused into the app's primary scannability device: you always know what area you're in by its accent, the dashboard becomes a color-coded map of the estate, and the activity feed's hardcoded sky/violet/amber (the literal token-discipline break in recent-activity-panel.tsx) gets replaced by pillar tokens. Color is applied as TINTED chrome (10-18% accent backgrounds, accent left-borders, accent icon chips, accent top-rules on cards) — never as text that must hit AA on the bone canvas, so the existing solid-fill StatusBadge discipline is untouched and nothing AA-fragile is introduced. Energetic and colorful, but disciplined: five hues, one role each, all derived from tokens already in globals.css.

- **Color:** EVOLVE, don't repaint. Keep every existing token value (--background bone, --foreground warm gray, --primary/--brand indigo 275, the chart/avatar/status ramps). ADD a thin layer that promotes the chart hues to PILLAR identities and makes them inheritable.

1) New semantic alias tokens in globals.css :root (map names→existing chart hues, zero new colors invented):
   --pillar-inventory: var(--chart-2);   /* teal 200 */
   --pillar-access:    var(--chart-1);   /* indigo 275 — same hue as brand, intentional */
   --pillar-knowledge: var(--chart-3);   /* green 150 */
   --pillar-manage:    var(--chart-4);   /* amber 75 */
   --pillar-danger:    var(--chart-5);   /* rose 15 — reserved for lost/critical */
   Mirror under .dark using the dark chart-* values already defined (lines 173-177). No new oklch literals needed; AA is inherited from the existing ramp.

2) The inheritance primitive — one variable, set per route group, read everywhere:
   In each (app) sub-section's layout/wrapper, set a data attribute and CSS var on the page root, e.g. <div data-pillar="inventory" style={{['--pillar' as string]: 'var(--pillar-inventory)'}}>. Then chrome reads var(--pillar) with NO per-pillar copy-paste:
   - icon chips: bg-[color-mix(in_oklch,var(--pillar)_12%,transparent)] text-[var(--pillar)] — BUT only use text-[var(--pillar)] on chips/borders/large-glyph contexts, never on small body text (the chart hues at 0.55-0.74 L don't all clear 4.5:1 on bone). For icon glyphs (decorative, aria-hidden) and 24px+ marks, AA text rules don't apply, so this is safe.
   - card top-rule: a 2px accent bar via border-t-2 border-[var(--pillar)] OR a ::before with bg-[var(--pillar)].
   - nav section left-border: border-l-2 border-[color-mix(in_oklch,var(--pillar)_55%,transparent)] on the section heading block.

3) color-mix() for tints (Tailwind v4 + oklch native): standardize four accent intensities so tints are consistent and theme-aware:
   --tint-soft:  color-mix(in oklch, var(--pillar) 8%,  transparent);   /* card wash */
   --tint-chip:  color-mix(in oklch, var(--pillar) 14%, transparent);   /* icon chip bg */
   --tint-ring:  color-mix(in oklch, var(--pillar) 35%, transparent);   /* hairline ring */
   --tint-bar:   var(--pillar);                                         /* solid 2px rule */
   These read correctly in dark because var(--pillar) already resolves to the dark chart value. color-mix in oklch keeps the warm canvas showing through (no muddy sRGB blend).

4) Status stays solid-fill via the EXISTING StatusBadge tones — do NOT route status through --pillar. Map asset/article/grant state enums to the existing --success/--warning/--info/--destructive (replace any raw emerald/amber/sky/rose in feature code with StatusBadge tone props). Pillar color is for AREA; status color is for STATE — keep the two systems orthogonal so a green "operational" badge never collides with the green Knowledge pillar.

5) avatarColorFor stays the canonical identity palette (people get a stable per-seed hue independent of pillar). Finish its coverage (asset owners, grantees, assignees, settings user list) so identity color is everywhere — this is separate from pillar color and the two are designed to coexist (avatar = WHO, pillar accent = WHERE).

AA guardrail (non-negotiable): --pillar is used ONLY for (a) decorative icon glyphs/chips, (b) borders/rings/2px bars, (c) ≥18px semibold display numerals where the contrast clears, and (d) tint backgrounds behind foreground/muted-foreground text (the text color is unchanged so its AA is preserved). It is NEVER used as the color of small body text on the bone canvas. This keeps every existing AA verification valid.
- **Motion:** CSS-and-tw-animate-first; NO new motion dependency. framer-motion stays uninstalled — if any moment below genuinely needs JS spring physics, it is flagged as a new-dependency decision, but none here do. Everything respects prefers-reduced-motion (reduced → opacity-only crossfades, no transforms).

1) Reuse what exists: the button already has transition-all + active:translate-y-px (button.tsx line 8) and Radix content already slides/zooms via tw-animate-css. Extend that vocabulary, don't replace it.

2) New @layer utilities keyframes in globals.css (tw-animate-css is imported line 2; add 4 named keyframes):
   - @keyframes pillar-rise: from { opacity:0; transform: translateY(6px) scale(.985) } to { opacity:1; transform:none } — 320ms cubic-bezier(.22,1,.36,1). Applied to pillar cards / list rows on first paint, STAGGERED via inline style={{animationDelay: `${i*45}ms`}} (cap at ~6 rows so a long list doesn't ripple forever).
   - @keyframes count-pop: 0%{transform:scale(.8);opacity:0} 60%{transform:scale(1.06)} 100%{transform:scale(1);opacity:1} — 260ms, on the big tabular-nums metric in PillarCard when data lands (the headline count "arrives").
   - @keyframes attention-throb: 0%,100%{opacity:1} 50%{opacity:.45} — 1.8s ease-in-out infinite, ONLY on the danger dot in AttentionRow (tone=danger), and ONLY when prefers-reduced-motion is no-preference. Warning dots stay static (throb is reserved for the one thing that's actually urgent).
   - @keyframes success-check: a stroke-dasharray draw (0→100) over 420ms for the delete/offboard success checkmark.

3) Hover/press microinteractions (pure CSS, no keyframes):
   - Pillar cards & attention rows: hover:-translate-y-0.5 hover:shadow-[var(--elevation-2)] transition-[transform,box-shadow] duration-200 ease-out + the accent top-rule brightens (border-[var(--pillar)] at full vs 70% at rest). A real "lift".
   - Breakdown rows (PillarCard dl links): the existing hover:bg-accent/50 stays, ADD a left accent wipe — a 2px ::before bar in var(--pillar) that scales scaleY(0)→scaleY(1) on hover, transform-origin bottom, 160ms. Quiet but alive.
   - Nav items: active item gets the pillar tint already; ADD transition-colors duration-150 and on hover a subtle border-l accent grow.
   - Inputs/selects: border-color transition duration-150 (kills the glitchy instant snap noted in the audit).

4) Section reveals on route change: wrap page content in a div with animate-[pillar-rise] so navigating between areas feels like the new area "settles in" with its color. Cheap, no router instrumentation needed.

5) Reduced-motion contract (one media query block): @media (prefers-reduced-motion: reduce){ * { animation-duration:.01ms!important; animation-iteration-count:1!important } [data-throb]{animation:none} .pillar-rise{transform:none} } — transforms drop, opacity crossfades remain, the throb stops entirely. Verified-safe and a single source of truth.
- **Profundidad/elevación:** Today the Card is dead flat: ring-1 ring-foreground/10, shadow-none (card.tsx line 15). Introduce a 3-step elevation scale as tokens so depth is a named language, not ad-hoc shadow utilities — and tint the shadow warm so it sits on the bone canvas instead of looking like a gray sticker.

Elevation tokens (globals.css :root, warm-tinted via the foreground hue so shadows read as warm not chromaless-gray):
  --elevation-1: 0 1px 2px -1px oklch(0.21 0.006 75 / 0.10), 0 1px 3px oklch(0.21 0.006 75 / 0.06);  /* resting cards */
  --elevation-2: 0 4px 12px -2px oklch(0.21 0.006 75 / 0.12), 0 2px 6px oklch(0.21 0.006 75 / 0.07); /* hover / detail panel */
  --elevation-3: 0 12px 32px -6px oklch(0.21 0.006 75 / 0.18);                                       /* sheets, sticky batch bar, popovers */
.dark overrides: use pure black at higher alpha (dark UIs need denser shadow): --elevation-1: 0 1px 2px oklch(0 0 0 / 0.4) ... etc.

Surface stratification by INTENT (depth communicates role, not decoration):
  - List ROW (in a table): no shadow, keep ring-foreground/10. Rows are content, not objects.
  - Pillar CARD / list-as-cards: --elevation-1 at rest + the accent top-rule; hover → --elevation-2 + -translate-y-0.5. Cards are liftable objects.
  - Detail PANEL: --elevation-1 always (slightly more present than a row) + ring-foreground/15 (the audit's suggested bump from /10) + an accent left-border in var(--pillar) so the panel announces its pillar.
  - Sticky batch bar / sheet / dialog: --elevation-3 + bg-background/95 + backdrop-blur-sm (already present on the batch bar — formalize it). These float above everything.
  - Dialog/sheet overlay: a semi-transparent warm scrim (bg-foreground/40 in light via the warm fg hue, bg-black/60 in dark) + backdrop-blur-xs so floating content reads as elevated — already partially there, make it consistent.

Card primitive change (regenerate via shadcn CLI, then compose — do NOT hand-edit the primitive): add an optional data-elevation attribute driving shadow via the tokens, defaulting to elevation-1 for standalone cards and shadow-none for table-embedded cards. The accent top-rule is added at the COMPOSITION layer (a wrapper className border-t-2 border-[var(--pillar)]), keeping the vendored primitive clean.

The net effect: the dashboard reads as four colored, liftable tiles floating a hair above a warm bone field, with floating chrome (sheets, sticky bars) clearly above them — a real z-axis where today there is none.
- **Tipografía:** Keep Geist + Geist Mono and the disciplined no-heroic-jumps scale — PageHeader's fixed text-2xl title (page-header.tsx line 50) stays the single source of truth; do NOT reintroduce title drift. The evolution is about giving the type scale NAMES and making numerals sing, since this is a data app.

1) Named semantic type tokens (globals.css @theme, so 'large number' and 'small label' are named not pixel-guessed):
   --text-metric: 1.875rem/1 600 -0.02em;   /* the big dashboard counts — tabular-nums, tighter tracking so 4-digit counts feel engineered */
   --text-display: 1.5rem/1.2 600 -0.015em;  /* = current text-2xl page title, formalized */
   --text-section: 1.125rem/1.4 600 -0.01em; /* the 'Needs attention' / 'Recent activity' h2 */
   --text-body: .875rem/1.45 400 0;
   --text-label: .75rem/1.3 500 .04em;       /* uppercase nav section headings + field labels — the tracking is what makes ALL-CAPS labels read as 'system chrome' */
   --text-mono: Geist Mono, for IDs / cuids / counts in tables.

2) Numerals are first-class: every count, total, metric and tabular column uses tabular-nums (already partly done — make it universal) so columns align and the count-pop animation lands on a stable glyph box. The dashboard metric goes from text-2xl to --text-metric (a hair bigger + tighter) so the headline number is unambiguously THE focal point of each pillar card, paired with its pillar-tinted icon chip.

3) Weight aliases for consistency: --fw-regular:400 --fw-medium:500 --fw-semibold:600. No 700+ (would fight the calm warmth). Pillar headings use --fw-semibold + the pillar accent left-border, never a bold colored heading-text (keeps AA + calm).

4) Letter-spacing discipline: tighten display/metric (-0.015 to -0.02em) so big text feels crafted; loosen labels (+0.04em) so small uppercase reads as chrome. This single move makes the hierarchy feel intentional rather than just 'different sizes'. Nothing else about the type changes — same fonts, same restraint, just named and tuned.
- **Personalidad:** Voice: a sharp, friendly senior sysadmin who color-codes their rack and labels everything — competent, fast, never shouty. The product should feel like a well-run estate, not a toy. Calm-but-alive: warmth from the bone canvas + warm shadows, energy from the five pillar hues doing real wayfinding work, delight in small earned moments (a count that pops in, an all-clear state that actually feels like relief, a successful offboard that visibly completes).

Color personality: indigo = ACTION (do this), pillar hues = PLACE (you are here), status = STATE (this is how it is). Three orthogonal color languages, never mixed — that discipline is what keeps 'colorful' from becoming 'noisy'. The CEO wants 'onda'; the onda is that the app is legibly mapped by color, so a glance tells you where you are and what's hot.

Copy voice (evolve, don't rewrite): empty/success states get one degree more human and specific. 'No activity recorded yet' → keep informative but warm; the all-clear NeedsAttention state ('Nothing needs attention right now') becomes a genuine win moment with a green (Knowledge/success-toned) check and a calm line. Destructive/offboard copy stays serious and precise (it's soft-delete of a person) — delight does NOT extend to destructive flows; those get clarity and a confident completion, not whimsy.

Restraint rules that keep it tasteful: max one throb on screen (danger only); pillar tints never exceed ~18% so the canvas always wins; animations are short (≤320ms) and never block interaction; no gradients on text, no glow on everything (glow is reserved as a single signature moment, see below); icons stay heroicons two-weight only. The personality is 'opinionated and energetic within tight rails' — exactly the ADR-0011 'calm, not flashy' intent, now with a pulse.

**Momentos signature:**
- PILLAR-MAPPED DASHBOARD: the four PillarCards (assets.dashboard/page.tsx PillarCard) each gain their pillar's identity — a 2px accent top-rule in var(--pillar), the icon chip recolored from generic bg-primary/10 to bg-[--tint-chip] text-[var(--pillar)], and on data-load the headline metric count-pops while the four cards pillar-rise in a 45ms stagger. The dashboard stops being four gray boxes and becomes a color-coded map of the estate (teal/indigo/green/amber, left-to-right). This is the single highest-leverage change — one PillarCard edit, visible immediately.
- WAYFINDING NAV: each sidebar section heading (sidebar-nav.tsx, the <p> at line 98) gets a left-border tint in its pillar hue (Inventory teal, Access indigo, Knowledge green, Manage amber) and the ACTIVE item's bg-sidebar-accent is overlaid with --tint-soft of the current pillar + a 2px left accent bar. You always know which area you're in from the rail color alone — the nav becomes the app's compass.
- ACTIVITY FEED FIXED & ALIVE: recent-activity-panel.tsx's hardcoded ENTITY_TONE (bg-sky-500/violet/amber — the literal token-discipline break) is replaced by per-pillar tokens (asset→inventory teal, application→access indigo, consumable→inventory teal or its own). Each new row fades+rises in, the actor avatar (already avatarColorFor-seeded) gets a tiny scale-in, and rows gain grouped-by-date dividers ('Today' / 'Yesterday'). The feed reads as a living, color-keyed stream instead of a flat list with off-system colors.
- NEEDS-ATTENTION WITH A PULSE: AttentionRow's TONE map (page.tsx lines 408-411, currently raw amber-500/rose-500) moves to --warning/--destructive tokens; the danger dot gets the attention-throb (the ONE throb allowed on screen), the row lifts on hover with --elevation-2, and the all-clear empty state becomes a real win — a success-toned check, a calm 'All clear across the estate' line, gentle slide-up. Urgency you can feel, relief you can feel.
- CONFIDENT OFFBOARD COMPLETION: the user offboard flow (users/[id]/page.tsx + DeleteConfirmDialog) gets an impact-preview line with the counts boldfaced and a --warning ring on the dialog; on success the user card does a brief fade-to-muted 'archived' transition and the toast carries a success-check draw animation. Not whimsy (it's a person being offboarded) — a clear, dignified 'done'. The delete dialog opening also uses the existing Radix fade/zoom, now with the destructive button label gently pulsing while pending to signal a heavy op.
- DEPTH ON LIFT: every liftable surface (pillar cards, attention rows, list-as-cards) goes from flat to --elevation-1 at rest and lifts to --elevation-2 with -translate-y-0.5 on hover, the accent top-rule brightening to full pillar color as it rises. Warm-tinted shadows mean the lift reads as the card floating off the bone field, not a gray drop-shadow pasted on. A whole-app tactile upgrade from one elevation-token + one hover utility.

**Movimientos concretos de token/CSS:**
- globals.css :root — add pillar alias tokens mapping to existing chart hues (no new colors): --pillar-inventory:var(--chart-2); --pillar-access:var(--chart-1); --pillar-knowledge:var(--chart-3); --pillar-manage:var(--chart-4); --pillar-danger:var(--chart-5); mirror in .dark using the dark --chart-* values already defined (lines 173-177).
- globals.css :root + .dark — add the tint scale as tokens: --tint-soft:color-mix(in oklch,var(--pillar) 8%,transparent); --tint-chip:color-mix(in oklch,var(--pillar) 14%,transparent); --tint-ring:color-mix(in oklch,var(--pillar) 35%,transparent). These resolve per-route because --pillar is set on the page wrapper.
- globals.css :root — add warm-tinted elevation tokens: --elevation-1/2/3 using oklch(0.21 0.006 75 / a) (the warm foreground hue) for light; .dark overrides with oklch(0 0 0 / a) at higher alpha. Wire shadow-[var(--elevation-1)] etc. at composition layer.
- globals.css @theme — add named type tokens: --text-metric (1.875rem/1, 600, -0.02em), --text-display, --text-section, --text-label (+0.04em tracking) and weight aliases --fw-regular/medium/semibold (400/500/600). No font change.
- globals.css @layer utilities — add 4 keyframes (pillar-rise, count-pop, attention-throb, success-check) + a single @media (prefers-reduced-motion: reduce) block that nukes transforms/iteration and disables the throb.
- Per-route wrappers — in each (app)/<pillar> layout (or a shared <PillarScope pillar=...> wrapper), set data-pillar and style={{'--pillar':'var(--pillar-inventory)'}} so all descendant chrome reads var(--pillar) with zero per-pillar copy-paste. Dashboard sets --pillar per PillarCard via a prop.
- dashboard/page.tsx PillarCard — pass a pillar prop; replace the icon chip 'bg-primary/10 text-primary' (line 267) with 'bg-[var(--tint-chip)] text-[var(--pillar)]', add wrapper 'border-t-2 border-[var(--pillar)]/70 hover:border-[var(--pillar)] shadow-[var(--elevation-1)] hover:shadow-[var(--elevation-2)] hover:-translate-y-0.5 transition-[transform,box-shadow] animate-[pillar-rise]' with staggered animationDelay; metric span gets animate-[count-pop] + var(--text-metric).
- dashboard/page.tsx — replace the TONE map (lines 408-411) raw 'bg-amber-500'/'bg-rose-500'/'ring-amber-500/20'/'ring-rose-500/30' with token-driven 'bg-warning'/'bg-destructive' and 'ring-warning/25'/'ring-destructive/30'; add data-throb to the danger dot only; make the all-clear state a success-toned win card.
- recent-activity-panel.tsx — replace ENTITY_TONE (lines 130-134) hardcoded sky/violet/amber with per-pillar token classes: asset/consumable→'bg-[var(--tint-chip)] text-[--pillar-inventory]' style, application→access indigo; set each row's --pillar inline by entityType. Add row pillar-rise on append + date-group dividers.
- sidebar-nav.tsx — give each NavSection a pillar; the heading <p> (line 98) gets 'border-l-2 pl-2.5 border-[color-mix(in_oklch,var(--section-pillar)_55%,transparent)]'; active Link (line 115) overlays '--tint-soft' bg + 'border-l-2 border-[var(--section-pillar)]' while keeping indigo focus-ring (brand=action stays).
- Card primitive (regenerate via shadcn CLI, not hand-edit) — add optional data-elevation prop → shadow token; default standalone=elevation-1, table-embedded=none. Accent top-rule stays at composition layer so the vendored primitive remains clean.
- Status de-hardcoding pass — sweep feature code (asset-status-badge, article-status, settings permissions, BYOI/mode banner) replacing raw emerald/amber/sky/rose+dark: variants with StatusBadge tone props / --success|--warning|--info|--destructive tokens. Status (state) stays orthogonal to --pillar (place).
- avatarColorFor coverage finish — wire it into asset owner chips, application grantee rows, assignee lists and the settings user list (lib/avatar-color.ts is already the canonical source) so identity color is universal and consistent with the activity feed.

**Mockup del dashboard:**

```text
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ lazyit                                          [⌕ search]            ☀/☾   (JM ▾)          │
├────────────┬─────────────────────────────────────────────────────────────────────────────┤
│            │  Dashboard                                        Updated 2m ago  [↻ Refresh]  │
│ ▦ Dashboard│  Your IT estate at a glance — Inventory, Access and Knowledge.                 │
│            │  [+ New asset] [+ Add stock] [+ Grant access]                                  │
│ ┃INVENTORY │                                                                                │
│ ▸ Assets   │  Needs attention                                                               │
│ ▸Consumab. │  ┌───────────────────────────────┐ ┌───────────────────────────────┐          │
│  (teal ┃)  │  │◆ ⚿  3 grants expiring ≤30d  →│ │◆ ▣  2 consumables low stock →│  ← amber ◆ │
│ ┃ACCESS    │  └───────────────────────────────┘ └───────────────────────────────┘          │
│ ▸Applic.   │  ┌───────────────────────────────┐                                             │
│ (indigo ┃) │  │● ⚠  1 asset marked lost     →│   ← rose ● THROBS (the one urgent pulse)    │
│ ┃KNOWLEDGE │  └───────────────────────────────┘                                             │
│ ▸ KB       │                                                                                │
│ (green ┃)  │  ┏━━━━━━━━━━━━━━┓ ┏━━━━━━━━━━━━━━┓ ┏━━━━━━━━━━━━━━┓ ┏━━━━━━━━━━━━━━┓             │
│ ┃MANAGE    │  ┃ teal top-rule┃ ┃indigo  rule ┃ ┃green   rule ┃ ┃ teal  rule  ┃  ← per-pillar│
│ ▸ Users    │  │ ▦teal  Assets│ │ ⚿ind  Access│ │ 📖grn  Know.│ │ ▣teal Consum.│   accent bar │
│ ▸Locations │  │   142  ◀pops │ │   38        │ │   27        │ │   64        │             │
│ ▸Settings  │  │ assets       │ │ active grnts│ │ articles    │ │ items       │             │
│ (amber ┃)  │  │ Operational118│ │ Critical   4│ │ Published 21│ │ Low stock  2│  ← hover:   │
│            │  │ Maint.      3│ │ Expiring   3│ │ Drafts     6│ │             │   lift +     │
│            │  │ 96 assigned →│ │             │ │             │ │             │   elevation-2│
│            │  │ Browse →     │ │ Manage →    │ │ Open KB →   │ │ Browse →    │             │
│            │  └──────────────┘ └─────────────┘ └────────────-┘ └─────────────┘             │
│            │   ↑ cards fade+rise in, staggered 45ms; warm shadow = float over bone canvas   │
│            │                                                                                │
│            │  Recent activity                                                               │
│            │  ┌────────────────────────────────────────────────────────────────────────┐  │
│            │  │ Across the estate — newest first.                                        │  │
│            │  │ ── Today ──────────────────────────────────────────────────────────────│  │
│            │  │ ▦teal  MacBook Pro #A-1042 assigned to R. Díaz          (RD) Rae · 8m   │  │
│            │  │ ⚿indigo Grant on Figma revoked for J. Soto             (JS) Joa · 41m   │  │
│            │  │ ── Yesterday ──────────────────────────────────────────────────────────│  │
│            │  │ ▣teal  USB-C cable ×12 stock-out (consumed)            (MT) Mia · 1d    │  │
│            │  │   ↑ pillar-token icon chips (no more hardcoded sky/violet); rows rise in │  │
│            │  │ [ Load more ]                                                            │  │
│            │  └────────────────────────────────────────────────────────────────────────┘  │
│            │                                                                                │
│            │  (all-clear variant of Needs attention, when empty:)                           │
│            │  ┌──────────────────────────────────────────────────────────┐                 │
│            │  │  ✓ (green draw-in)  All clear across the estate.          │  ← a real win   │
│            │  │     No expiring grants, low stock or lost assets.         │     moment      │
│            │  └──────────────────────────────────────────────────────────┘                 │
└────────────┴─────────────────────────────────────────────────────────────────────────────┘
Legend: ┃ = pillar-tinted nav section left-border · ┏━┓ = card accent top-rule in var(--pillar) ·
◆=warning(amber) ●=danger(rose, throbs) ✓=success(green) · indigo stays the ACTION color (buttons/
focus rings/active-nav bar) while pillar hues do WAYFINDING. AA preserved: color is on chips/borders/
big numerals/tints behind unchanged text — never on small body text over the bone canvas.
```

**Riesgos:** Token-discipline regression: contributors may slip back to hardcoding Tailwind palette colors (the exact emerald/sky/violet break that exists today in recent-activity-panel.tsx). Mitigation: ship the --pillar/--tint/--pillar-* tokens AND do the de-hardcoding sweep in the same change, then add an eslint/grep guard flagging raw bg-emerald/sky/violet/amber/rose-NNN in feature code so the system can't rot back.; AA on tinted glyphs: text-[var(--pillar)] on the lighter chart hues (amber chart-4 at 0.74 L, teal chart-2 at 0.62 L) will NOT clear 4.5:1 as small body text on bone. Strictly confine var(--pillar)-as-text to decorative icon glyphs (aria-hidden), borders, and ≥18px semibold numerals; never small labels. Mitigation: codify the rule in the direction + verify each pillar's chip glyph and any large numeral with an oklch contrast check before merge.; color-mix browser support: color-mix(in oklch,...) needs a modern engine. It's well-supported in current evergreen browsers and Tailwind v4 already targets them, but a self-hosted small-team install on an old browser could degrade. Mitigation: confirm the deploy's browser baseline; if risky, precompute the tints as static oklch token values per pillar instead of runtime color-mix (more tokens, zero runtime risk).; Motion overload / the throb: too many animations or more than one throb reads as a toy, not a tool — and an infinite throb can annoy. Mitigation: hard rules — one throb max (danger only), all entrances ≤320ms one-shot, staggers capped at ~6 items, full prefers-reduced-motion honoring; review the dashboard with reduced-motion ON to confirm it's fully calm.; Green Knowledge pillar vs green success status colliding: a green pillar accent next to a green 'operational/published' StatusBadge could read as the same signal. Mitigation: keep them orthogonal by ROLE and FORM — pillar green only appears as borders/chips/top-rules (area), success green only as solid pills (state); they never occupy the same element. Verify on the KB list where both co-occur.; Per-route --pillar plumbing: setting --pillar via a wrapper per (app) sub-section adds a small structural requirement; if a page forgets the wrapper, var(--pillar) falls back to nothing and chips render uncolored. Mitigation: provide a single <PillarScope> wrapper component with a sane default (brand indigo) so a missing pillar degrades gracefully to today's neutral-indigo look rather than breaking.; Scope creep vs ADR-locked primitives: the Card elevation change must go through the shadcn CLI regenerate, not a hand-edit of components/ui/card.tsx (ADR-locked vendored primitives). Mitigation: keep the accent top-rule and pillar tint at the COMPOSITION layer; only the elevation/data-elevation hook touches the primitive, and that lands via CLI regenerate + review.

---

## Warm & Human

**Tesis:** Lazyit already lives on a warm "bone" canvas and warm dark-gray ink the CEO loves (ADR-0011). "Warm & Human" doesn't add a new aesthetic — it finishes the one we started, leaning all the way into warmth as personality. The app should feel like a well-kept workshop owned by people who care: soft shadows that suggest paper resting on a desk (never floating glass), generously rounded corners, friendly first-person microcopy ("Nothing here yet — let's add your first asset"), and gentle, physical motion (things settle and breathe, nothing snaps or flashes). The five categorical hues stop being dead tokens and become a quiet per-pillar identity — Inventory teal, Access indigo, Knowledge green, Manage amber — applied as warm tints and accent threads, never as loud fills. Delight comes from craft and restraint: an empty state that smiles, a success toast that lands like a soft "done," an avatar that gently fades in. The CEO asked for life and onda; we deliver it through human warmth, not neon. Everything stays AA, every color comes from a token, primitives stay vendored. This is the warm-neutral system, fully expressed instead of half-built.

- **Color:** Evolve the existing warm-neutral + single-indigo system; no hue gets louder, the warm bone canvas and indigo brand stay exactly as ADR-0011 set them. The moves are (1) ACTIVATE the categorical ramp as a per-pillar identity and (2) warm the elevation/tint layer.

PER-PILLAR TINT TOKENS (new, derived from existing --chart-* hues, very low chroma so they read as "warm paper with a memory of color," not bands): add a --pillar-* family that names the four pillars to existing chart hues, plus matching ultra-soft surface tints.
  Light:
    --pillar-inventory: var(--chart-2);            /* teal 200 */
    --pillar-access: var(--chart-1);               /* indigo 275 = brand */
    --pillar-knowledge: var(--chart-3);            /* green 150 */
    --pillar-manage: var(--chart-4);               /* amber 75 */
    --pillar-inventory-soft: oklch(0.965 0.018 200);   /* ~AA bg for dark teal text */
    --pillar-access-soft:    oklch(0.965 0.020 275);
    --pillar-knowledge-soft: oklch(0.965 0.020 150);
    --pillar-manage-soft:    oklch(0.967 0.024 75);
  Dark (raise lightness of the tint, keep chroma tiny so it stays warm-gray-with-a-tint, not a colored block):
    --pillar-*-soft: oklch(0.30 0.02 <hue>);  per hue (teal 200 / indigo 275 / green 150 / amber 75)
  Pillar text on its soft tint must clear AA: use the existing --avatar-* lightness (~0.50) for the on-tint text color, which is AA-verified for white but here used as DARK text on the light soft tint — verify each pair at build (teal/green/indigo text ~0.45–0.50 L on a 0.965 L tint clears 4.5:1; amber text must darken to ~0.42 L to clear AA on its tint).

WARM ELEVATION TOKENS (new — the depth language, intentionally warm, never neutral gray): shadows carry a trace of the foreground's warm hue so cards look like paper on a warm desk, not floating on black.
  Light:
    --shadow-color: 30 25 20;   /* warm brown-black rgb, used in rgba() */
    --elev-1: 0 1px 2px rgb(var(--shadow-color) / 0.06), 0 1px 3px rgb(var(--shadow-color) / 0.05);
    --elev-2: 0 2px 4px rgb(var(--shadow-color) / 0.06), 0 4px 12px rgb(var(--shadow-color) / 0.08);
    --elev-3: 0 8px 24px rgb(var(--shadow-color) / 0.12);
  Dark: --shadow-color: 0 0 0; bump alphas (0.25/0.35/0.5) since shadows read as deepening, not casting.
  Ring intensity ladder reusing the existing warm border hue: resting cards keep ring-foreground/10; hovered/active surfaces step to ring-foreground/15; pillar-scoped surfaces use ring-[var(--pillar)]/15.

STATUS / SUBTLE VARIANT (evolves StatusBadge, keeps solid pills as canonical): add ONE "subtle" tone variant for low-priority contexts — a soft tint bg + AA-dark text, mirroring the destructive Badge pattern that already exists. Tokens reuse --success/--warning/--info hues at the pillar-soft lightness. This is additive; the solid AA pills stay the default per the StatusBadge doc.

NO new brand hue, no second blue, no saturated fills on surfaces. The bone canvas, indigo --primary, and --avatar palette are untouched. AA is preserved because every new color is either (a) an existing AA-verified token reused, or (b) a soft tint paired with explicitly-darkened text verified ≥4.5:1 at build.
- **Motion:** Physical, gentle, "settling" motion — CSS-first via tw-animate-css (already imported in globals.css) and @layer utilities keyframes. The metaphor is paper and breath: things ease in and settle, they never bounce hard, flash, or spin gratuitously. No JS motion lib. framer-motion stays OUT (flag as a new-dependency decision only if a future shared-element transition truly needs it — not for this direction). Everything wrapped in @media (prefers-reduced-motion: no-preference); reduced-motion users get the final state instantly, plus opacity-only fades at most.

Timing system (named tokens so motion is consistent, not pixel-guessed):
  --ease-settle: cubic-bezier(0.22, 1, 0.36, 1);   /* soft overshoot-free settle */
  --ease-soft:   cubic-bezier(0.4, 0, 0.2, 1);
  --dur-fast: 140ms; --dur-base: 220ms; --dur-slow: 360ms;

Keyframes (new @layer utilities):
  - settle-in: opacity 0→1, translateY 6px→0, scale 0.99→1 over --dur-base/--ease-settle. The signature entrance for cards, list rows, panels.
  - breathe: a 2.4s ease-in-out infinite opacity 0.55↔1 on attention DOTS only (the throb on danger/warning), low amplitude so it's a heartbeat, not an alarm. Pauses on reduced-motion.
  - rise: translateY 8px→0 + opacity for empty/success states (slightly longer travel = "arriving").
  - check-draw: stroke-dashoffset animation for an SVG success checkmark (offboard/delete success), ~--dur-slow.
  - underline-grow: scaleX 0→1 transform-origin-left on pillar breakdown rows and link-like surfaces on hover.

Interaction motion (composable on primitives via className, NOT edits to vendored files):
  - Cards: hover adds --elev-2 + translateY(-2px) over --dur-fast/--ease-soft; this is the "lift." Resting state --elev-1.
  - Buttons already do active:translate-y-px (keep). Add a subtle hover brightness on the icon chip, not the whole button.
  - List rows: stagger settle-in with nth-child animation-delay (40ms steps, capped at ~6 rows) on first paint / page change.
  - Avatars in the activity feed: settle-in on appear (gentle fade + 0.99 scale).
  - Section reveal: dashboard sections (NeedsAttention, pillar grid, activity) each settle-in with a small stagger so the page "assembles" rather than blinks in.
  - Toasts (Sonner, already installed): use its built-in slide+fade; extend success dwell slightly for the "soft done" feeling.

Discipline: motion only on (a) entrances, (b) hover affordances, (c) success moments, (d) the single attention heartbeat. No motion on scroll, no parallax, no looping background animation. Total added CSS is keyframes + a handful of utility classes — no runtime cost beyond compositor transforms (transform/opacity only, never layout-animating properties).
- **Profundidad/elevación:** A three-step warm elevation ladder replaces today's flat "everything is ring-1 ring-foreground/10." Shadows are warm (tinted with the foreground hue, never neutral gray-on-white) so surfaces read as paper resting on a warm desk — the core of the "human" feel. Elevation communicates intent, not decoration:

  Layer 0 — Canvas: --background bone (unchanged). The desk.
  Layer 1 — Resting surfaces (list rows, table, inert cards): --elev-1 + ring-foreground/10. Barely-there lift; they sit on the desk.
  Layer 2 — Interactive / focal cards (pillar cards, dashboard cards, detail-panel, attention rows): rest at --elev-1, hover to --elev-2 + translateY(-2px) + ring steps to /15. This is where the "lift on hover" delight lives.
  Layer 3 — Floating chrome (dialogs, sheets, dropdowns, the sticky batch bar): --elev-3 + bg-background/95 + backdrop-blur-sm + a semi-transparent warm overlay behind modals (rgb(var(--shadow-color)/0.4)) so floating content reads as clearly elevated and the canvas recedes.

Pillar surfaces get a SOFT TINT instead of pure card bg: a pillar card's icon chip uses bg-[var(--pillar)]/10 + text-[var(--pillar)] (replacing today's uniform bg-primary/10), and the card can carry a 1px top accent border in var(--pillar) at low opacity — a "color thread" identifying the area without shouting. Detail panels for a pillar inherit the same thread.

Radius warmth: the system's generous --radius scale (already up to 4xl) is leaned into for friendliness — cards rounded-xl (keep), icon chips rounded-xl (up from lg) so they feel soft, status pills already rounded-4xl (keep), empty-state illustration circles fully rounded. Nothing gets sharper; a few things get rounder.

The warm overlay + backdrop-blur on modals, plus the warm shadow tint, are the two moves that most cheaply convert "flat and clinical" into "soft and layered" without touching a single hue's saturation.
- **Tipografía:** Keep Geist + Geist Mono (already wired to --font-sans / --font-mono); no new fonts. The current scale is sound but unnamed and a little timid for "life." Add a semantic, named type scale as tokens so big numbers feel confident and small labels feel intentional — warmth comes partly from comfortable line-height and a hair more letter-spacing on small caps labels.

New @theme type tokens (size / line-height / tracking):
  --text-display: 1.875rem / 2.25rem / -0.02em   (dashboard hero metrics, the big pillar counts — today they're text-2xl/font-semibold; bump the headline count to display so "142 assets" lands with confidence)
  --text-title:   1.25rem  / 1.75rem  / -0.01em   (page H1, section "Needs attention")
  --text-lg:      1.0625rem/ 1.5rem   / -0.005em
  --text-base:    0.875rem / 1.375rem / 0          (body — slightly taller line-height than default for breathing room)
  --text-label:   0.75rem  / 1rem     / 0.04em uppercase  (the nav section headings, breakdown labels — warmer than today's tight uppercase)
  --text-mono-num:tabular-nums everywhere counts appear (already used; formalize)

Weight aliases for consistency: --fw-regular 400, --fw-medium 500, --fw-semibold 600. Metrics use --fw-semibold + --text-display + tabular-nums. Pillar titles stay --fw-medium (CardTitle already font-medium). Headings use --font-heading (= sans) per existing @theme.

Voice in type: the only "louder" move is the dashboard metric jumping to --text-display — a single confident focal number per card. Everything else stays calm. Mono is reserved for IDs, counts in dense tables, and the "Updated <relative>" stamp (tabular). No heroic 5xl hero text — that would break the calm intent; confidence comes from one well-placed display number, not giant headlines.
- **Personalidad:** Voice: a competent, friendly colleague who keeps the place tidy — warm but never cute, helpful but never chatty. First-person-plural and second-person where it invites action ("Let's add your first asset"), plain and reassuring where stakes are real (delete/offboard stays calm and precise, never jokey). Spanish "onda" delivered as quiet craft, not slang.

Microcopy principles:
  - Empty states invite, not apologize: "Nothing here yet" + a warm one-liner + a clear primary action. (e.g. Assets empty: "No assets yet. Add the first one and it'll show up here." Activity empty already reads well — keep its tone.)
  - Success is acknowledged warmly and briefly: toast "User archived — their history is safe." (ties to the soft-delete reassurance that already exists in copy).
  - Destructive copy stays sober and human: the delete dialog's existing "archived — a soft delete that hides it from the list without erasing its history" is already perfect Warm & Human voice; extend that tone, don't make delete playful.
  - Attention zone speaks plainly: "3 grants expiring within 30 days" (already good) — keep counts bold, keep it factual; warmth here = clarity, not exclamation marks.
  - Loading: skeletons stay quiet; no "Loading…" spinners with text. The warmth is the gentle settle-in when content arrives.
  - No emoji in product UI, no exclamation-mark inflation, no "Oops!" error voice — errors stay respectful and actionable ("The API may be down or unreachable." + request id, as today).

Personality in pixels: rounded soft chips, warm shadows, the pillar color-thread, a smiling-but-minimal empty illustration (a simple line-art box/shelf in muted pillar tint, not a mascot). The product feels owned and cared-for. It should make a 6-person IT team feel the tool is on their side.

**Momentos signature:**
- Pillar cards that breathe and belong: each dashboard pillar card carries its color-thread (1px top border + tinted icon chip in var(--pillar)) and the headline count renders at --text-display. On hover the card lifts (--elev-2 + translateY(-2px), --dur-fast). Breakdown rows get an underline-grow on hover. The four cards settle-in with a 40ms stagger so the dashboard assembles instead of blinking — the first thing the CEO sees, now alive.
- The warm offboard moment: when a user is successfully archived, the user card does a gentle fade-and-collapse (opacity→0 + max-height→0 over --dur-slow) while an SVG check-draw plays in the success toast, and the toast reads 'User archived — their access is revoked and their assets are released. History is safe.' The heavy operation feels handled with care, not just dismissed. (Composed around the existing DeleteConfirmDialog + onDeleted redirect — no primitive edits.)
- Friendly empty states as moments: a reusable EmptyState composes a 3x heroicon (24/outline) on a fully-rounded bg-[var(--pillar)]/10 circle, a warm one-line invitation, and the primary 'New …' button — sliding up via 'rise' on mount. Replaces today's dashed-border utilitarian boxes across Assets/KB/Applications/Consumables. Each pillar's empty state wears its own color, so the app feels color-coded and welcoming even when there's no data.
- The attention heartbeat: in 'Needs attention,' danger/warning dots get the low-amplitude 'breathe' animation (2.4s, opacity 0.55↔1) and the row tints with the semantic token at low alpha (ring-warning/20, ring-destructive/30 — moved off hardcoded amber/rose to tokens). It draws the eye to what's wrong without alarming — a calm pulse, paused entirely under reduced-motion.
- Per-pillar nav identity: each sidebar section heading gets a 2px left color-thread in var(--pillar) (Inventory teal / Access indigo / Knowledge green / Manage amber) and the ACTIVE item's background shifts from generic --sidebar-accent to a soft var(--pillar)/10 with var(--pillar) text. Navigating the app now has a sense of place — you feel which pillar you're in.
- Activity feed warmed up: the timeline icon chips move from hardcoded sky/violet/amber to the pillar tints (bg-[var(--pillar)]/10 text-[var(--pillar)]), actor avatars settle-in as rows load, and rows group under soft date headers ('Today' / 'Yesterday' / 'Earlier'). The feed becomes a warm, legible story of the estate instead of a flat log — and it finally uses the categorical system end-to-end.

**Movimientos concretos de token/CSS:**
- globals.css — add the pillar identity family in :root and .dark: --pillar-inventory:var(--chart-2); --pillar-access:var(--chart-1); --pillar-knowledge:var(--chart-3); --pillar-manage:var(--chart-4); plus matching --pillar-*-soft tints (light ~oklch(0.965 0.02 <hue>), dark ~oklch(0.30 0.02 <hue>)). Register them in @theme inline as --color-pillar-* so Tailwind emits bg-pillar-* / text-pillar-* utilities (mirrors how --color-chart-* and --color-avatar-* are already registered).
- globals.css — add warm elevation tokens: --shadow-color (light '30 25 20', dark '0 0 0') and --elev-1/2/3 box-shadow strings using rgb(var(--shadow-color)/<a>). Expose as @theme --shadow-elev-1/2/3 so shadow-elev-1 etc. are real utilities. This is the depth language; replaces ad-hoc shadow-xs/md/lg usage with intentional layers.
- globals.css @layer utilities — add keyframes settle-in, rise, breathe, check-draw, underline-grow with --ease-settle/--ease-soft/--dur-* custom props, all gated under @media (prefers-reduced-motion: no-preference); provide reduced-motion fallbacks (final state, opacity-only).
- Dashboard PillarCard (apps/web/app/(app)/dashboard/page.tsx) — accept a pillar prop ('inventory'|'access'|'knowledge'|'manage'); swap the icon chip from bg-primary/10 text-primary to bg-[var(--pillar)]/10 text-[var(--pillar)] via a data attribute, add a 1px top accent (border-t-2 border-[var(--pillar)]/30), promote the metric span from text-2xl to text-display (tabular-nums font-semibold), and add hover:shadow-elev-2 hover:-translate-y-0.5 transition-all + settle-in stagger on the grid. Assets→inventory, Access→access, Knowledge→knowledge, Consumables→inventory(teal) [note: only 4 pillar hues — Consumables shares Inventory teal as it is Inventory].
- dashboard AttentionRow TONE map — replace hardcoded {dot:'bg-amber-500',ring:'ring-amber-500/20'} / rose with token-driven {warning:{dot:'bg-warning',ring:'ring-warning/25'},danger:{dot:'bg-destructive',ring:'ring-destructive/30'}}; add the 'breathe' class to the dot span. Removes the last hardcoded Tailwind status colors on the dashboard, wiring it to --warning/--destructive.
- recent-activity-panel.tsx ENTITY_TONE — replace the hardcoded sky/violet/amber strings with pillar tints: asset → 'bg-pillar-inventory/10 text-pillar-inventory', application → 'bg-pillar-access/10 text-pillar-access', consumable → 'bg-pillar-inventory/10 text-pillar-inventory'. Add settle-in to ActorAvatar and rows; add date-group headers. (Pure className/logic composition — no vendored primitive touched.)
- sidebar-nav.tsx — map each NavSection.heading to a pillar var; render the heading <p> with a 2px left border in border-[var(--pillar)] and, for the active item, swap 'bg-sidebar-accent text-sidebar-accent-foreground' to 'bg-[var(--pillar)]/10 text-[var(--pillar)] font-medium'. Dashboard (null heading) stays neutral/primary.
- New composable component apps/web/components/empty-state.tsx (composes Card/Button/heroicon — NOT a ui/ primitive edit): props {icon, title, body, action?, pillar?}; renders the rounded tinted icon circle + warm copy + primary action with the 'rise' animation. Adopt across assets/kb/applications/consumables list empty states, replacing the dashed-border blocks.
- New composable apps/web/components/lift-card.tsx OR a 'lift' className recipe in lib/utils — encapsulate shadow-elev-1 + hover:shadow-elev-2 + hover:-translate-y-0.5 + transition-all + ring step so 'interactive card' is one class, applied to DetailPanel, dashboard cards, attention rows. Avoids editing vendored Card; layers via className.
- StatusBadge usage layer (compose, do NOT hand-edit components/ui/status-badge.tsx) — if a 'subtle' tone is wanted, regenerate via shadcn CLI per the ADR constraint, or introduce a sibling SubtleBadge in components/ that tints --success/--warning/--info at the pillar-soft lightness with AA-dark text. Default solid pills stay canonical.
- avatar-color.ts — no token change needed; instead AUDIT-and-WIRE avatarColorFor() (already canonical) into every people surface still missing it (asset owner chip, application grantee rows, assignee lists, settings user list) so identity color is consistent app-wide. This 'finishes' the categorical system on the people axis the same way pillar tints finish it on the area axis.
- globals.css @theme — add the named type scale tokens --text-display/title/lg/base/label and weight aliases --fw-*, and expose --text-* so the dashboard metric and section headings consume named sizes instead of raw text-2xl/text-lg.

**Mockup del dashboard:**

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  lazyit                                              ☀/☾   ⌘K Search   ◍ Ana   │
├────────────┬─────────────────────────────────────────────────────────────────┤
│            │  Dashboard                                  Updated 2m ago  ↻ Ref │
│ ◧ Dashboard│  Your IT estate at a glance.                                      │
│            │                                                                   │
│ ┃INVENTORY │  ╭── Needs attention ──────────────────────────────────────────╮ │
│  ▣ Assets  │  │ ┌───────────────────────────┐ ┌──────────────────────────┐  │ │
│  ▤ Consum. │  │ │ ⚠•breathe  3 grants expiring│ │ ⚠•breathe 2 low on stock │  │ │
│            │  │ │   within 30 days        3 →│ │            at reorder  2 →│  │ │
│ ┃ACCESS    │  │ │  ring-warning/25 · elev-1  │ │  ring-warning/25         │  │ │
│  ⚷ Applic. │  │ └───────────────────────────┘ └──────────────────────────┘  │ │
│            │  │ ┌───────────────────────────┐                               │ │
│ ┃KNOWLEDGE │  │ │ ◭•breathe  1 asset marked   │   tokens: --warning/--dest. │ │
│  ▭ KB      │  │ │   lost                  1 →│   (no hardcoded amber/rose) │ │
│            │  │ │  ring-destructive/30       │                             │ │
│ ┃MANAGE    │  │ └───────────────────────────┘                               │ │
│  ◍ Users   │  ╰──────────────────────────────────────────────────────────────╯ │
│  ⚐ Locat.  │                                                                   │
│  ⚙ Settings│  ╭ teal thread ─╮ ╭ indigo thread╮ ╭ green thread ╮ ╭ teal ─────╮ │
│            │  │▣ bg-teal/10  │ │⚷ bg-indigo/10│ │▭ bg-green/10 │ │▤ bg-teal/10│ │
│ active item│  │ Assets       │ │ Access       │ │ Knowledge    │ │ Consum.    │ │
│ = pillar/10│  │              │ │              │ │              │ │            │ │
│            │  │   142        │ │    37        │ │    24        │ │    58      │ │
│            │  │  ▔▔▔ display │ │  ▔▔▔ display │ │  articles    │ │  items     │ │
│            │  │  assets      │ │ active grants│ │              │ │            │ │
│            │  │ ───────────  │ │ ───────────  │ │ ───────────  │ │ ────────── │ │
│            │  │ Operational 120│ On critical 4│ │ Published  18│ │ Low stock 2│ │
│            │  │ ↑underline-grow│ Expiring ≤30 3│ │ Drafts      6│ │            │ │
│            │  │ Maintenance  18│              │ │              │ │            │ │
│            │  │ 120 assigned → │              │ │              │ │            │ │
│            │  │ Browse assets →│ Manage acc. →│ │ Open KB     →│ │ Browse    →│ │
│            │  │ hover: lift -2px+elev-2       │ settle-in stagger 0/40/80/120ms│ │
│            │  ╰──────────────╯ ╰──────────────╯ ╰──────────────╯ ╰────────────╯ │
│            │                                                                   │
│            │  Recent activity                                                  │
│            │  ╭──────────────────────────────────────────────────────────────╮ │
│            │  │ Across the estate · newest first                  elev-1      │ │
│            │  │ ── Today ──────────────────────────────────────────────────  │ │
│            │  │ ▣ teal  Laptop #A-204 assigned to Marcos        2m ·  (MR)    │ │
│            │  │ │       avatar settle-in ↑                       avatar-color │ │
│            │  │ ⚷ indigo Access granted to Figma · Ana          1h ·  (AL)    │ │
│            │  │ ── Yesterday ──────────────────────────────────────────────  │ │
│            │  │ ▤ teal  Stock −5 · USB-C cables                 1d ·  System  │ │
│            │  │ [ Load more ]                                                 │ │
│            │  ╰──────────────────────────────────────────────────────────────╯ │
└────────────┴─────────────────────────────────────────────────────────────────┘
  Warm desk canvas (bone) · warm-tinted soft shadows · pillar color-threads ·
  one confident display metric per card · token-driven status · gentle settle-in.
```

**Riesgos:** AA on the soft pillar tints is the sharpest risk: dark colored text on a 0.965-L tint passes for teal/green/indigo but AMBER text struggles (amber is light by nature). Mitigation: pillar text on amber-soft must darken to ~0.42 L, and where any tinted text can't clear 4.5:1, fall back to the solid StatusBadge pattern. Every new tint/text pair must be contrast-checked at build, not assumed.; Consumables has no dedicated hue — only four pillar hues exist and Consumables lives under Inventory, so it shares teal. This is defensible (it IS Inventory) but could read as 'two cards the same color.' Mitigation: differentiate by icon, not color; do NOT invent a fifth pillar hue (that would break the 5-categorical discipline and the single-accent intent).; Motion overuse can tip 'calm' into 'busy.' Stagger + lift + breathe + settle on one screen risks fidgetiness. Mitigation: hard budget — entrances once per mount (not per re-render), the breathe heartbeat ONLY on danger/warning dots, hover-lift only on genuinely interactive cards. Re-check that React re-renders don't re-trigger settle-in (use CSS animation on mount, key stability).; Warm shadows can muddy in dark mode — a brown-tinted shadow on a dark warm-gray canvas may look like a smudge. Mitigation: dark mode switches --shadow-color to neutral 0 0 0 and leans on alpha/ring rather than colored shadow; verify cards still read as layered without looking dirty.; Scope creep: 'wire avatarColorFor everywhere' + pillar tints on nav/cards/activity/empty states touches many files. Mitigation: ship as a tokens-first PR (globals.css + theme + keyframes) the whole team builds on, THEN per-surface PRs — each independently AA-checked. Don't land it as one giant diff (and per CLAUDE.md, one file per commit).; Hard constraint: do NOT hand-edit components/ui/* primitives (button/card/status-badge). All elevation, lift, pillar tint and subtle-badge work must be composed via className/new components or regenerated via the shadcn CLI. A subtle StatusBadge tone, if wanted, needs CLI regen or a sibling component — editing the vendored primitive violates the ADR.; tw-animate-css keyframe coverage: some named keyframes (check-draw via stroke-dashoffset, breathe) may not exist in tw-animate-css and must be hand-authored in @layer utilities. Confirm what tw-animate-css already provides before assuming a utility class exists; otherwise author the keyframes ourselves (still CSS, still no JS dep).

---

## Signal Dense

**Tesis:** Energy from DATA, not decoration. lazyit becomes a premium observability console for the IT estate: tight rhythm, KPI tiles with deltas, inline sparklines, and a live-feeling activity feed — the Datadog/Retool feeling where a glance answers "is my estate healthy and what just changed?". We do NOT add a new accent or repaint the warm-neutral canvas; we keep the bone/dark-gray + single-indigo system exactly as ADR-0011 specifies and instead ACTIVATE the already-defined but dormant categorical (--chart-1..5) and semantic (--success/--warning/--info) tokens as signal carriers. The spark comes from three currently-missing layers: (1) per-pillar color identity wired through one --pillar inheritance variable, (2) a real elevation scale so cards/panels/sticky bars read as a stratified surface stack, and (3) a CSS-first motion vocabulary (count-up, delta-flash, feed-row enter, live-pulse) that makes data feel alive without a motion library. Density is the personality: more answers per screen, every number earning a delta or a sparkline, nothing flashy — the dashboard should feel like a cockpit, calm but instrumented.

- **Color:** EVOLVE, don't replace. The neutral ramp (--background bone oklch(0.985 0.004 95), --foreground oklch(0.21 0.006 75), dark canvas oklch(0.205 0.006 75)) and the single indigo brand (--primary oklch(0.55 0.18 275) / dark 0.62 0.17 275) stay byte-for-byte. The move is to finally CONSUME the existing categorical and status tokens as signal.

PILLAR IDENTITY (new --pillar inheritance var, mapped onto existing --chart tokens — no new hues):
- Inventory/Assets → --pillar: var(--chart-1) (indigo 275) — the estate's spine shares the brand hue, reinforcing discipline.
- Access → --pillar: var(--chart-2) (teal oklch(0.62 0.14 200)).
- Knowledge → --pillar: var(--chart-3) (green oklch(0.65 0.15 150)).
- Consumables → --pillar: var(--chart-4) (amber oklch(0.74 0.16 75)).
- (--chart-5 rose oklch(0.62 0.2 15) reserved for the 5th categorical series in charts/legends, not a pillar.)
Each route segment sets --pillar on its <main>; PageHeader icon chip, sparkline stroke, KPI accent rule, and active-tab underline all read var(--pillar) via currentColor. One line per route, zero per-component color literals.

DELTA SEMANTICS (reuse status tokens, never raw Tailwind): a positive/healthy delta uses --success, a negative/at-risk delta uses --destructive, a watch delta uses --warning. Deltas render as TINTED chips, not solid — and to stay AA on the bone canvas (a tinted amber-on-bone pill cannot reach AA, the exact reason StatusBadge fills solid), delta text uses a darkened, on-surface variant. Add three new derived tokens computed from the existing hues so we don't invent color:
  --success-strong: oklch(from var(--success) 0.42 c h) (light) / oklch(from var(--success) 0.82 c h) (dark) — AA text on a --success/12% tint.
  --warning-strong: oklch(from var(--warning) 0.45 c h) (light) / oklch(from var(--warning) 0.86 c h) (dark).
  --destructive-strong: oklch(from var(--destructive) 0.50 c h) (light) / oklch(from var(--destructive) 0.78 c h) (dark).
These use oklch relative-color syntax off tokens that already ship, so hue stays locked to the system and only lightness shifts to clear 4.5:1 on the 10–14% tint backgrounds.

SPARKLINE / DATA-VIZ INK: sparkline stroke = var(--pillar) at full token chroma; its area fill = the same hue at 10% (color-mix(in oklch, var(--pillar) 10%, transparent)). Gridlines/axis = --border. Threshold lines (e.g. reorder level) = --warning at 40%. No chart library required for sparklines (inline SVG polyline), so this needs no new dependency — flagged below only if richer charts are wanted.

GAUGE / RATIO BARS: the operational-ratio bar (operational vs maintenance vs retired) is a single stacked track using --success / --warning / --muted-foreground/40, all existing tokens.

NEUTRAL DEPTH TINT: card backgrounds gain a barely-there pillar wash — color-mix(in oklch, var(--pillar) 3%, var(--card)) on KPI tiles only — so a pillar's tiles feel subtly "warm to their hue" while the global canvas stays neutral. 3% is below the AA-relevant threshold (text contrast measured against --card; the wash never touches text legibility).
- **Motion:** CSS-first, tw-animate-css + a small @layer utilities block in globals.css. NO motion library. framer-motion is explicitly NOT proposed; the one place JS is unavoidable (the count-up number tween) is flagged as a tiny ~30-line hook, not a dependency. Everything wraps in @media (prefers-reduced-motion: no-preference) so reduced-motion users get the final state instantly.

Vocabulary (named keyframes):
- sig-count-up: KPI metrics tween from a lower value to the real number over 600ms ease-out on first paint / on data change. Implemented with a useCountUp hook (requestAnimationFrame, ~30 LOC, no dep) feeding a tabular-nums span; under reduced-motion the hook short-circuits to the final value.
- sig-delta-flash: when a delta chip mounts or updates, a 1-cycle background flash (from var(--pillar)/20 → transparent, 700ms) draws the eye to "this changed" — the live-feeling cue. Pure @keyframes, applied via a data-[changed=true] attribute.
- sig-row-in: activity-feed rows enter with translateY(4px)+opacity 0→1, 220ms ease-out, STAGGERED by --row-index (animation-delay: calc(var(--row-index) * 28ms)) capped at ~8 rows so a "Load more" batch cascades in like a live tail.
- sig-live-pulse: a 2px dot beside "Recent activity" / "Updated 12s ago" does a slow 2.4s opacity 1→0.4→1 pulse to imply liveness (it is still snapshot data, ADR — the pulse is honest "fresh", not "streaming"). Uses --success at rest, --warning if the snapshot is stale (>5 min).
- sig-spark-draw: sparkline polyline draws left-to-right via stroke-dasharray/dashoffset animation, 500ms ease-out, once on mount. Reduced-motion → drawn instantly.
- sig-attention-throb: the danger dot on "Needs attention" rows gets a 2s box-shadow throb (0 0 0 0 var(--destructive)/40 → 0 0 0 6px transparent) — a calm radar ping, only on tone=danger, never on warning (warning stays static so danger reads as the louder signal).

Interaction feedback (composed onto existing primitives, no primitive hand-edits):
- KPI tile + pillar card: hover:-translate-y-0.5 + shadow step (surface-1 → surface-2) over 150ms; this is the only "lift".
- Breakdown/feed rows: existing hover:bg-accent/50 stays; add transition-colors duration-150 and a 2px left border that grows from 0 → full in var(--pillar) on hover (an underline-expand analog for rows).
- Buttons: keep the primitive's active:translate-y-px; the CEO's "some buttons" want is satisfied by the count-up + delta-flash energy, not by louder buttons (discipline preserved).
- Sonner toasts already animate; on successful destructive ops (offboard/delete) extend dwell to ~5s and add a single success-check draw (stroke-dasharray on a heroicons CheckCircleIcon path) so the moment lands.
- **Profundidad/elevación:** Today every surface is flat (ring-1 ring-foreground/10, shadow-none). Signal Dense introduces a 4-step elevation scale as utility classes in @layer utilities, so depth communicates hierarchy instead of opacity tricks. All shadows use the warm-neutral foreground hue at low alpha (never chromaless black), matching the bone system.

--shadow-1: 0 1px 2px oklch(0.21 0.006 75 / 0.06), 0 1px 1px oklch(0.21 0.006 75 / 0.04)  → resting KPI tiles & cards (replaces shadow-none).
--shadow-2: 0 2px 8px oklch(0.21 0.006 75 / 0.08), 0 1px 2px oklch(0.21 0.006 75 / 0.05) → hover/active card, detail-panel.
--shadow-3: 0 8px 24px oklch(0.21 0.006 75 / 0.12) → popovers/dropdowns (already shadow-md, upgrade), sheets.
--shadow-4: 0 12px 32px oklch(0.21 0.006 75 / 0.16) → sticky batch bar / command palette (floating-most).
Dark mode swaps the shadow hue to oklch(0 0 0 / …) at slightly higher alpha (dark surfaces need black, not bone, to read as shadow) plus a top inset hairline (inset 0 1px 0 oklch(0.97 0.004 95 / 0.04)) so dark cards get a "lit top edge" — the premium-console look.

Surface stack (intent → token):
- L0 canvas: --background (bone / dark-gray). 
- L1 panel: --card + ring-foreground/10 + --shadow-1. The new default for cards/tiles.
- L2 raised: --card + ring-foreground/15 + --shadow-2 — detail-panel, hovered tile, the KPI hero tile.
- L3 floating: --popover + --shadow-3 — dropdowns, selects, detail-panel sheet.
- L4 sticky/overlay: --background/95 + backdrop-blur-sm + --shadow-4 — batch action bar, command palette, dialog content.
Ring opacity steps with elevation (10 → 15 → transparent-once-shadowed), so the eye reads layering even in dark mode where shadows are subtle.

Density-specific depth: the dashboard KPI strip uses a single shared L1 plane with hairline dividers between tiles (border-foreground/8) rather than 4 separate floating cards — the "instrument cluster" read. The hero/primary tile (the estate health summary) steps to L2 to anchor the eye. This is the Datadog move: one dense panel, internal dividers, not a scatter of disconnected cards.
- **Tipografía:** Keep Geist + Geist Mono (already wired to --font-sans / --font-mono). The system has no heroic size jumps today; Signal Dense formalizes a NUMERIC-FORWARD scale via named --text-* tokens so metrics, deltas, and labels are typed by role, not pixel-guessed.

--text-metric: 1.875rem / 2rem, font-weight 600, letter-spacing -0.02em, font-feature-settings "tnum" 1 (tabular). The big KPI number. Geist sans (it has excellent figures); Geist Mono reserved for IDs/code.
--text-metric-sm: 1.25rem / 1.5rem, 600, tnum — secondary tile numbers, breakdown values.
--text-delta: 0.75rem / 1rem, 600, tnum — the +3/-12% delta chips; always tabular so columns of deltas align.
--text-label: 0.6875rem (11px) / 1rem, 500, letter-spacing 0.04em, uppercase — the small caps "ASSETS · OPERATIONAL" tile labels that give the observability/console read. This is the one new typographic gesture: tracked uppercase micro-labels, used ONLY on KPI tile captions and section eyebrows, never in body/prose.
--text-base / --text-sm / --text-xs: bind the existing 0.875/0.8/0.75rem usages to names so they stop being ad-hoc.

Rules: every number that represents a count, total, delta, or time gets tabular-nums (the codebase already does this in spots — make it universal via the token). Sparkline/feed timestamps use --font-mono at --text-xs for the "machine telemetry" feel. Prose (KB articles) is untouched — @tailwindcss/typography stays; the dense numeric type is a DASHBOARD/LIST dialect, not a global change.
- **Personalidad:** Voice: instrumented, precise, quietly confident — a senior SRE's console, not a consumer app. It states facts with numbers and trends, never exclaims. "23 assets operational · +2 this week" reads like telemetry, not marketing. Microcopy is terse and scannable: "Updated 12s ago", "3 expiring ≤30d", "Stock at 8 — reorder at 10". Empty states are honest and instrument-themed: instead of a sad illustration, "No signal yet — changes to assets, access and stock will stream here" beside a faint sparkline-on-zero baseline (a flat line with a single pulsing dot), which doubles as a delightful, on-brand moment. Success after an offboard: "Offboarded. Revoked 4 grants, released 2 assets." — the system reports impact as data, which is more satisfying than a generic toast. Errors stay calm and actionable with the request-id (ADR-0031). The personality is density-as-respect: it assumes a competent operator who wants more answers per glance, and it rewards them with trends and deltas rather than hand-holding. Calm, not flashy — but never inert.

**Momentos signature:**
- Live KPI strip with count-up + delta: on dashboard load, the four pillar metrics tween up (sig-count-up) and a tinted delta chip (+2 this week / -1) flashes once (sig-delta-flash) in the pillar's hue. The estate goes from 'static cards' to 'instruments spinning up' in 600ms — the single biggest 'onda' win, all CSS+30-line hook.
- Inline sparklines on every pillar tile: a 7-day trend polyline (inline SVG, var(--pillar) stroke, sig-spark-draw left-to-right) under each metric — Assets total trend, active grants trend, stock level, published articles. Needs one tiny new endpoint (GET /dashboard/sparklines or a counts-by-day array on DashboardSummary) — flagged as a backend contract add. The dashboard instantly reads Datadog-grade.
- Live-tail activity feed: the existing RecentActivityPanel gets a pulsing 'live' dot (sig-live-pulse, --success→--warning if stale), date-group headers ('Today / Yesterday / Earlier'), and staggered row-enter (sig-row-in) so a 'Load more' batch cascades in like a tail -f. Pillar icon chips switch from hardcoded sky/violet/amber to var(--chart-*) tokens — fixing the token-discipline break AND adding life.
- Operational-health ratio bar: a single stacked horizontal gauge on the Assets hero tile (operational/maintenance/retired via --success/--warning/--muted) with the dominant segment's percentage in --text-metric-sm — one glance answers 'is my fleet healthy?'. Pure divs + tokens, no chart lib.
- Needs-attention radar ping: danger rows get sig-attention-throb (a calm 2s box-shadow ping on the dot) while warning rows stay static — so the eye is pulled to the one thing that's actually on fire, not to everything. Re-tones the hardcoded amber-500/rose-500 to --warning/--destructive tokens.
- Offboard impact report: the user offboard success toast becomes a data report ('Revoked 4 grants · released 2 assets') with a one-shot success-check draw, and the user card does a brief sig-delta-flash in --destructive before the redirect — the heavy operation lands as a satisfying, legible moment instead of a silent navigation.

**Movimientos concretos de token/CSS:**
- In globals.css :root and .dark, add derived AA-safe delta text tokens using oklch relative color off existing tokens: --success-strong / --warning-strong / --destructive-strong (light ≈ L0.42–0.50, dark ≈ L0.78–0.86, same c/h as the base token). Verify each clears 4.5:1 on its 12% tint background before shipping.
- Add a 4-step elevation scale as CSS custom props: --shadow-1..4 using oklch(0.21 0.006 75 / a) in light and oklch(0 0 0 / a) + a top inset hairline in dark; expose as @layer utilities .elev-1..4 (box-shadow) so cards compose them without hand-editing the Card primitive.
- Introduce a --pillar inheritance variable: set it per route on the (app) segment wrappers — /assets & /dashboard-assets-tile → var(--chart-1), /applications → var(--chart-2), /kb → var(--chart-3), /consumables → var(--chart-4). Components read var(--pillar) (with --chart-1 fallback) for icon chips, sparkline stroke, active underline.
- Replace the hardcoded ENTITY_TONE map in recent-activity-panel.tsx (bg-sky-500/10 text-sky-600 / violet / amber) with token-driven classes: asset→chart-1, application→chart-2, consumable→chart-4 via bg-[color-mix(in_oklch,var(--chart-N)_12%,transparent)] text-[var(--chart-N)] — killing the raw-Tailwind break.
- Replace the TONE map in dashboard/page.tsx ({dot:'bg-amber-500',ring:'ring-amber-500/20'} / rose) with semantic tokens: warning→{dot:'bg-warning',ring:'ring-warning/25'}, danger→{dot:'bg-destructive',ring:'ring-destructive/30'} — same look, now token-disciplined and theme-correct.
- Add named typography tokens in @theme inline: --text-metric, --text-metric-sm, --text-delta, --text-label (uppercase tracked micro-label), each as font-size/line-height/weight/letter-spacing, plus a .tabular utility aliasing font-variant-numeric: tabular-nums for universal number alignment.
- Add @keyframes sig-count-up (n/a — JS hook), sig-delta-flash, sig-row-in (uses animation-delay: calc(var(--row-index)*28ms)), sig-live-pulse, sig-spark-draw, sig-attention-throb in @layer utilities, all wrapped in @media (prefers-reduced-motion: no-preference); provide a useCountUp(target) hook (~30 LOC, rAF, reduced-motion-aware) in lib/hooks — flag as net-new util, NOT a dependency.
- Upgrade Card default elevation from shadow-none to .elev-1 via a composed wrapper class on feature cards (not the primitive); add hover:.elev-2 hover:-translate-y-0.5 transition-[box-shadow,transform] duration-150 on interactive KPI/pillar cards. Detail-panel → .elev-2 + ring-foreground/15; sticky batch bar → .elev-4 + backdrop-blur-sm (already partial).
- Add a KPI tile pillar wash: bg-[color-mix(in_oklch,var(--pillar)_3%,var(--card))] on dashboard tiles only, keeping global --card neutral; verify text-on-wash contrast unchanged (3% wash does not move the measured ratio meaningfully).
- Wire sparklines: add an inline <Sparkline points={number[]} /> presentational component (SVG polyline, var(--pillar) stroke + 10% area fill, sig-spark-draw) — requires a backend add of per-day counts on DashboardSummary (e.g. assets.trend: number[]). Flag the contract change for ADR/data discussion before building.

**Mockup del dashboard:**

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│  Dashboard                                       Updated 12s ago ●   [⟳ Refresh]    │  ● = live-pulse dot
│  Your IT estate at a glance — Inventory · Access · Knowledge.                       │
├──────────────────────────────────────────────────────────────────────────────────┤
│  ⚠ NEEDS ATTENTION                                                                  │
│  ┌────────────────────────────────────┐ ┌────────────────────────────────────┐    │
│  │ 🔑 3 grants expiring ≤30d      3  →│ │ 📦 2 consumables below reorder  2 →│    │  warning: static dot
│  └────────────────────────────────────┘ └────────────────────────────────────┘    │
│  ┌────────────────────────────────────┐                                            │
│  │ ⚠ 1 asset marked lost      ◉   1  →│   ◉ = radar-ping (sig-attention-throb)    │  danger: throbbing dot
│  └────────────────────────────────────┘                                            │
├──────────────────────────────────────────────────────────────────────────────────┤
│  KPI STRIP  (one L1 plane · hairline dividers · per-tile pillar hue + 3% wash)      │
│ ┌───────────────┬───────────────┬───────────────┬───────────────┐                  │
│ │ ▣ ASSETS      │ ⚷ ACCESS      │ ▤ KNOWLEDGE   │ ▦ CONSUMABLES │   indigo│teal│green│amber
│ │               │               │               │               │                  │
│ │   128         │    47         │    62         │    19         │  ← count-up      │
│ │   assets  ▲+2 │ grants  ▲+5   │ articles ▼-1  │ items   ▲+3   │  ← delta-flash   │
│ │  ╱╲    ╱╲╱    │   ╱╲╱╲╱╲      │ ─╲╱──╲──      │  ╱──╲╱╲       │  ← sparkline     │
│ │ ╱  ╲__╱       │  ╱      ╲     │               │ ╱      ╲      │    (sig-spark-draw)
│ │ ▰▰▰▰▰▰▱▱ 84%  │ 41 active     │ 53 published  │ 2 low stock   │  ← ratio gauge   │
│ │ operational   │ 6 expiring    │ 9 drafts      │ reorder soon  │                  │
│ │ Browse →      │ Manage →      │ Open KB →     │ Browse →      │                  │
│ └───────────────┴───────────────┴───────────────┴───────────────┘                  │
│   (hero tile = Assets, steps to L2 elevation; ratio gauge = success/warning/muted) │
├──────────────────────────────────────────────────────────────────────────────────┤
│  RECENT ACTIVITY  ● live                                    [stale>5m → ⚠ amber]    │
│  ── Today ──────────────────────────────────────────────────────────────────────  │
│  │ ▣  MacBook Pro 14" assigned to Ana Ruiz          (AR) Ana Ruiz       2m ago │ ←─ sig-row-in
│  │ ⚷  Grant on Figma (CRITICAL) revoked             (JM) J. Minatel     14m ago│    staggered 28ms
│  │ ▦  Toner HP 26X — stock out (−1)                 (sys) System        31m ago│
│  ── Yesterday ───────────────────────────────────────────────────────────────  │
│  │ ▣  Dell Dock retired                             (LM) Lia M.         18h ago│
│  │                                              [ Load more ]                  │    cascade-in batch
└──────────────────────────────────────────────────────────────────────────────────┘
  icon chips use var(--chart-*) tokens (▣=indigo ⚷=teal ▦=amber) — NOT raw sky/violet
  every number tabular-nums · deltas tinted (--success/--destructive-strong) · AA verified
```

**Riesgos:** Sparklines and deltas need data that doesn't exist yet: DashboardSummary today is a point-in-time snapshot with no per-day series and no week-over-week deltas. Shipping sparklines/deltas requires a backend contract change (counts-by-day arrays + prior-period values), which is ADR-gated (data contract is locked). Mitigation: phase it — ship the visual system (count-up, elevation, pillar color, token cleanup, motion, ratio gauge from existing byStatus) with NO new data first; treat sparklines/deltas as a fast-follow once the endpoint lands. Do not block the visual win on the data work.; Density can tip into noise: KPI strip + sparklines + deltas + ratio gauge + live feed is a lot per viewport. On small/tablet widths the single-plane strip must reflow to stacked tiles and sparklines should drop before deltas. Risk of clutter if every tile screams — enforce that only ONE hero tile is L2 and deltas stay tinted/quiet, not solid.; Motion budget & reduced-motion: count-up + delta-flash + row stagger + spark-draw + live-pulse + radar-throb is six animations potentially firing near-simultaneously on dashboard load. Must cap stagger, ensure all are GPU-cheap (transform/opacity/box-shadow only), and rigorously gate behind prefers-reduced-motion — otherwise it reads busy and harms a11y. The live-pulse must not imply real-time streaming when data is snapshot (honest copy: 'Updated 12s ago', not 'Live').; The useCountUp hook is net-new JS (not a dependency, but a custom util touching render) — must be SSR-safe (Next App Router), purity-clean (the codebase already snapshots now once for this reason), and must short-circuit under reduced-motion and on re-renders so numbers don't re-tween on every cache refetch (only on actual value change).; oklch relative-color syntax (oklch(from var(--token) L c h)) for the -strong delta tokens has good but not universal browser support; if the target self-hosted user base includes older browsers, hardcode the computed oklch values instead (still token-derived, just precomputed) to avoid a fallback to inherited color. Verify against the deployment's browser baseline.; Scope creep into a Reports/Informes pillar: Signal Dense's KPI/sparkline energy invites building a full analytics page (the CEO hotspot #4). Keep this direction scoped to evolving the EXISTING dashboard/lists/feed; a dedicated /reports route with CSV export + date-range is a separate, larger initiative needing its own issue, endpoints, and possibly a charts-lib decision — don't smuggle it in here.

---

