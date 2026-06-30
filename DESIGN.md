---
name: lazyit
description: The calm, crafted, IT-native system of record — pure paper-and-ink surfaces, one oxblood stamp, a security-green verify seal, activated through depth and motion.
colors:
  background: "oklch(0.985 0 0)"
  foreground: "oklch(0.18 0 0)"
  card: "oklch(0.965 0 0)"
  card-foreground: "oklch(0.18 0 0)"
  primary: "oklch(0.52 0.2 25)"
  primary-foreground: "oklch(0.985 0 0)"
  success: "oklch(0.53 0.14 150)"
  success-foreground: "oklch(0.985 0 0)"
  verify: "oklch(0.5 0.105 162)"
  verify-foreground: "oklch(0.985 0 0)"
  warning: "oklch(0.82 0.15 85)"
  warning-foreground: "oklch(0.27 0 0)"
  info: "oklch(0.52 0.115 240)"
  info-foreground: "oklch(0.985 0 0)"
  destructive: "oklch(0.55 0.21 30)"
  destructive-foreground: "oklch(0.985 0 0)"
  chart-1: "oklch(0.55 0.17 255)"
  chart-2: "oklch(0.76 0.14 80)"
  chart-3: "oklch(0.52 0.18 300)"
  chart-4: "oklch(0.68 0.11 200)"
  chart-5: "oklch(0.6 0.2 335)"
  pillar-inventory: "oklch(0.68 0.11 200)"
  pillar-access: "oklch(0.55 0.17 255)"
  pillar-knowledge: "oklch(0.76 0.14 80)"
  pillar-manage: "oklch(0.52 0.18 300)"
  muted: "oklch(0.945 0 0)"
  muted-foreground: "oklch(0.45 0 0)"
  border: "oklch(0.88 0 0)"
  sidebar: "oklch(0.97 0 0)"
typography:
  display:
    fontFamily: "Hanken Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.875rem"
    fontWeight: 600
    lineHeight: "2.25rem"
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Hanken Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: "2rem"
    letterSpacing: "-0.015em"
  title:
    fontFamily: "Hanken Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: "1.5rem"
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Hanken Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: "1.25rem"
    letterSpacing: "normal"
  label:
    fontFamily: "Hanken Grotesk, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: "1rem"
    letterSpacing: "0.04em"
  mono:
    fontFamily: "Commit Mono, ui-monospace, SFMono-Regular, monospace"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: "1.25rem"
    letterSpacing: "normal"
rounded:
  sm: "0.375rem"
  md: "0.5rem"
  lg: "0.625rem"
  xl: "0.875rem"
  2xl: "1.125rem"
spacing:
  xs: "0.25rem"
  sm: "0.5rem"
  md: "0.75rem"
  lg: "1rem"
  xl: "1.5rem"
  2xl: "2rem"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
  button-primary-hover:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
  button-secondary:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
  button-secondary-hover:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
  button-ghost-hover:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
  button-destructive:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.destructive-foreground}"
    rounded: "{rounded.md}"
    padding: "0.5rem 1rem"
  button-destructive-hover:
    backgroundColor: "{colors.destructive}"
    textColor: "{colors.destructive-foreground}"
  card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.card-foreground}"
    rounded: "{rounded.xl}"
    padding: "1.5rem"
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.75rem"
  input-focus:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
  badge:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.sm}"
    padding: "0.125rem 0.5rem"
  status-chip:
    backgroundColor: "{colors.success}"
    textColor: "{colors.success-foreground}"
    rounded: "{rounded.sm}"
    padding: "0.125rem 0.5rem"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.foreground}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.75rem"
  nav-item-active:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.primary}"
    rounded: "{rounded.md}"
    padding: "0.5rem 0.75rem"
---

# Design System: lazyit

## 1. Overview: The Ledger

**Creative North Star: "The Ledger"**

lazyit is a system of record kept by an operator who trusts the page. The canvas is pure
**paper white** — chroma-zero, near-white but never `#fff` — and the surfaces on it are
entries you can act on: cards are the recessed **tape** just below the paper, read by a
hairline rule, lifting when you reach for them under neutral **ink** shadows. A single
disciplined **oxblood stamp** marks the one action you're taking — a registration mark, not
a wall. Color is the labelled column (blue for Access, amber for Knowledge, violet for
Manage, cyan for Inventory), never wallpaper, and a cooler security-**green** seal is
reserved for the zero-knowledge verify mark. Data reads in **Commit Mono** with tabular
numerics so identifiers, timestamps and ledger lines are instrument-grade. The system is
calm because the operator is mid-task and the **record**, not the chrome, deserves their
attention — but it is **alive**: things move, settle, and layer with intention. This is the
difference between a *cared-for ledger* and an *austere SaaS*.

Density is earned, not feared. This is the **product** register: when an operator needs a
table of 200 assets or a panel of forty labels, the system gives it to them densely and
legibly — tabular numerics, a tight type scale, consistent affordances screen to screen.
The energy never comes from louder buttons or more CTAs; it comes from **motion, depth,
and color identity** layered onto an otherwise quiet surface. Restraint is the floor;
craft is how we activate it.

The Ledger explicitly rejects the things that make internal tools feel un-cared-for: the
**generic AI-slop dashboard**, the **AI-cream tell**, **heavy/dated ServiceNow**, **SaaS
landing-page clichés**, **glassmorphism**, **gradient text**, **tiny uppercase eyebrows
on every section**, the **hollow hero-metric template**, and **"austere SaaS" coldness**.
It does not chase delight on every page — delight is saved for moments (a success
checkmark, an empty state that invites), never sprayed across the surface.

**Key Characteristics:**

- **Pure-neutral paper/carbon canvas, chroma 0** — near-white paper, near-black carbon,
  never `#fff`/`#000` or the warm "bone"/AI-cream tell (ADR-0077).
- **One disciplined oxblood stamp** for action, selection, and state — ≤10% of any screen.
- **Five categorical/pillar hues, decoupled from the brand** — tint/chip/dot/border only,
  never as readable text.
- **A security-green verify seal** (`--verify`) reserved for the zero-knowledge mark,
  distinct from the everyday emerald `--success`.
- **A neutral, named elevation scale** — chroma-0 ink shadows; objects rest at e1 and lift.
- **A single CSS motion vocabulary** — 120–220ms, state-conveying, reduced-motion-safe, zero JS lib.
- **A type trio (Hanken Grotesk + Commit Mono + Redaction)** on a fixed rem scale — dense when the task is dense.
- **WCAG-AA by construction** in both themes; color never carries meaning alone.

## 2. Colors: The Paper, Ink & Oxblood Palette

A pure-neutral (chroma 0) paper canvas carrying one disciplined oxblood accent, with five
categorical hues reserved as a labelling layer for the product's pillars and a security-green
seal for the zero-knowledge mark — color is seasoning, never flood.

### Primary
- **Brand Oxblood** (`oklch(0.52 0.2 25)`, lifted to `oklch(0.62 0.19 25)` in dark): the
  single accent. Wired to `--primary` / `--ring` / `--sidebar-primary`, so it drives primary
  buttons, focus rings, and the active nav item — and nothing decorative. The dark value is
  lifted so `text-primary` links clear AA on the carbon canvas (4.90:1). Oxblood is the
  brand's **registration stamp**, decoupled from the categorical data ramp.

### Neutral
- **Paper** (`oklch(0.985 0 0)`): the light canvas — pure chroma-0 paper white, never the
  warm "bone" it replaced. In dark it becomes the foreground; the dark canvas is a near-black
  carbon (`oklch(0.155 0 0)`), never pure black.
- **Ink** (`oklch(0.18 0 0)`): foreground / body text. Foreground-on-background clears ~18:1
  (light) / ~17:1 (dark).
- **Tape** (`--card` `oklch(0.965 0 0)` light / `oklch(0.195 0 0)` dark): in light it sits a
  hair *below* the paper, read by its hairline ring; in dark it steps *up* from the carbon
  canvas. `--popover` floats on the paper white (`oklch(0.985 0 0)` light / `oklch(0.195 0 0)`
  dark). Surfaces stay layered, not coplanar.
- **Quiet Gray** (`--muted` / `--secondary` / `--accent` `oklch(0.945 0 0)`,
  `--muted-foreground` `oklch(0.45 0 0)`): secondary surfaces and de-emphasized text (≥4.5:1).
- **Hairline** (`--border` / `--input` `oklch(0.88 0 0)` light / `oklch(0.32 0 0)` dark): the
  ledger rule — borders and dividers, neutral so they never read warm or clinical.
- **Rail** (`--sidebar` `oklch(0.97 0 0)`): a hair deeper than the canvas so the sidebar reads
  as a distinct surface.

### Categorical (the pillar & chart layer — decoupled from the brand)
Five hues on a brand-decoupled ramp. The ramp deliberately vacates the red band (oxblood ~25)
and the green band (`--verify` ~162) so no data color reads as "brand" or "verified", and
carries a lightness ladder so series stay separable under deuteranopia/protanopia/tritanopia
(no categorical red↔green pair). They are the **categorical identity layer**: charts,
avatar/initials chips, and the four product pillars — *not* a decorative secondary palette.
- **Access Blue** (`--pillar-access` = `--chart-1` `oklch(0.55 0.17 255)`): Applications & access.
- **Knowledge Amber** (`--pillar-knowledge` = `--chart-2` `oklch(0.76 0.14 80)`): the KB.
- **Manage Violet** (`--pillar-manage` = `--chart-3` `oklch(0.52 0.18 300)`): Users & Locations.
- **Inventory Cyan** (`--pillar-inventory` = `--chart-4` `oklch(0.68 0.11 200)`): Assets &
  Consumables (Consumables shares cyan — differentiate by icon, never a fifth hue).
- **Series Magenta** (`--chart-5` `oklch(0.6 0.2 335)`): the remaining categorical series hue.

### Semantic status (solid-fill tones, AA-verified)
Each pairs with an AA-clearing foreground so a **solid** status pill is always readable on the
paper (a tinted-text pill cannot reach AA on the neutral canvas).
- **Success** (`oklch(0.53 0.14 150)`, fg `oklch(0.985 0 0)` — 4.74:1 light / 8.08:1 dark):
  the everyday "good/operational" emerald.
- **Verify** (`oklch(0.5 0.105 162)`, fg `oklch(0.985 0 0)` light / `oklch(0.66 0.14 162)`,
  fg `oklch(0.18 0 0)` dark): the security-green zero-knowledge **seal** — a cooler, deeper
  green kept distinct from `--success`.
- **Warning** (`oklch(0.82 0.15 85)`, fg `oklch(0.27 0 0)` — 8.55:1 light / 10.98:1 dark).
- **Info** (`oklch(0.52 0.115 240)`, fg `oklch(0.985 0 0)` — 5.20:1 light / 7.16:1 dark).
- **Destructive** (`oklch(0.55 0.21 30)` light / `oklch(0.7 0.19 32)` dark, with its own
  `--destructive-foreground`): delete and danger only. Shifted to hue ~30 — a hotter scarlet —
  so "danger" never reads as the oxblood brand (hue 25).

### Named Rules
**The One Voice Rule.** The oxblood stamp is reserved for **action, selection, and state** —
primary buttons, focus rings, the active nav item — and used on **≤10%** of any given screen.
Its rarity is the point: it is a registration mark, not a wall. Oxblood is never decoration,
never a section background, never a "let's add some color here" flourish.

**The Pillar-as-Decoration Rule.** A pillar or chart hue may be a **tint, a border, a dot,
or a chip background** — never readable text on the paper or on a `/10` tint. The categorical
ramp is decoupled from the brand and from verify; each pillar token aliases a `--chart-*` hue
(which `.dark` redefines *lighter*), so it cannot clear 4.5:1 as body text. Decorative glyphs
≥24px inside a `bg-pillar-*/10` chip are exempt (glyphs aren't text-AA-bound); everything
readable stays on `--foreground` / `--card-foreground` or a semantic `*-foreground`.

**The Verify-Seal Rule.** The security-green `--verify` seal is reserved for the **Secret
Manager / zero-knowledge mark** — the cryptographic "VERIFIED" seal — and kept distinct from
the everyday emerald `--success`, so "operational" never reads as "cryptographically
verified". Like every semantic token it fills solid with its AA-cleared `--verify-foreground`;
it is never a decorative green.

## 3. Typography

**Body / UI / Heading Font:** Hanken Grotesk (with `ui-sans-serif, system-ui, sans-serif`)
**Data / Mono Font:** Commit Mono (with `ui-monospace, SFMono-Regular, monospace`)
**Display Font:** Redaction — login + empty-states **ONLY**

**Character:** Hanken Grotesk is a warm, legible humanist grotesque tuned for small sizes and
data-dense tables — exactly the IT-native register. Commit Mono carries identifiers, serials,
timestamps, audit lines and tabular numerics (`font-variant-numeric: tabular-nums`) so ledger
data reads instrument-grade. Redaction is the **one display face** — a "redacted record"
voice reserved for the sparse, brand-register moments (login, empty states), and **never** for
product-register UI. Together the trio is the product register: the body face carries headings,
buttons, labels, body and data; the display face is the rare exception.

### Hierarchy
A **fixed rem scale** (not fluid `clamp()`), ratio ~1.125–1.2 — product UI is viewed at
consistent DPI, and a heading that shrinks in a sidebar looks worse, not better.
- **Display** (600, `1.875rem` / `2.25rem` lh, `-0.02em`): dashboard hero metrics — the
  `text-display` token, on the **body face** (Hanken Grotesk), paired with mono tabular
  numerics. (Not the Redaction display *face* — that is login/empty-states only.)
- **Headline** (600, `1.5rem` / `2rem` lh): page titles via the `PageHeader` primitive.
- **Section** (600, `1.125rem` / `1.5rem` lh, `-0.01em`): the `text-section` token —
  "Needs attention" / "Recent activity" panel headings.
- **Body** (400, `0.875rem` / `1.25rem` lh): the workhorse — table cells, form fields,
  copy. Prose still respects 65–75ch; dense tables may run to 120ch+.
- **Label** (500, `0.75rem` / `1rem` lh, `+0.04em`): the `text-label` token — uppercase
  eyebrows and nav section headings, used sparingly (not on every section).

### Named Rules
**The Body-Carries-Everything Rule.** The body face — Hanken Grotesk, with Commit Mono for
numerics/identifiers — carries the entire UI: headings, buttons, labels, body, tables, dense
data. **Redaction is the ONE display face, used sparingly on login + empty-states ONLY** —
never in a label, button, data cell, or any product-register surface. The rare display face
is the exception that proves the discipline, not a free-for-all. The IT-native voice holds.

## 4. Elevation

The system was born flat and was given depth deliberately: a **neutral, named elevation
scale** in chroma-0 **ink** so shadows sit *in* the paper-and-ink system — paper on a desk
under even light, not a warm or gray sticker. Surfaces rest at e1 and respond to interaction;
depth is structural (it tells you what's an entry you can act on), not ambient decoration.

### Shadow Vocabulary
- **e1 — Resting** (`shadow-e1`: `0 1px 2px oklch(0.21 0 0 / 0.06), 0 1px 1px oklch(0.21 0 0 / 0.04)`):
  cards, panels, the DetailPanel at rest. Replaces the old flat `ring-1 shadow-none` look.
- **e2 — Engaged** (`shadow-e2`: `0 4px 12px -2px oklch(0.21 0 0 / 0.1), 0 2px 4px -2px oklch(0.21 0 0 / 0.06)`):
  hover and focus on interactive cards.
- **e3 — Floating** (`shadow-e3`: `0 12px 28px -6px oklch(0.21 0 0 / 0.14)`): dialogs,
  dropdowns, sticky batch bars.

In **dark** mode the same shapes run at ~2x alpha **plus** a `inset 0 1px 0 oklch(0.97 0 0 / 0.04)`
top-highlight — a faint neutral line so a raised surface catches light on the near-black
carbon canvas, where shadows alone would vanish. Depth via highlight, not just shadow.

### Named Rules
**The Paper-and-Ink Rule.** Shadows are **neutral chroma-0 ink** (`oklch(0.21 0 0)`), never
warm-tinted or clinical gray — paper on a desk under even light. Surfaces rest at **e1** and
**lift on interaction**. The signature is the `lift` recipe: the coordinated hover triad
`-translate-y-0.5` + `e1`→`e2` + ring `/10`→`/15`, fired together, so a card hover feels
*crafted*, not a flat background swap. Never apply `lift` to static table rows (vertical
jitter hurts scanning). Audit test: if a card looks like a 2014 app, the shadow is too dark,
too tight, and too heavy — neutralize it and spread it.

## 5. Components

Every interactive component ships the full state set — default, hover, focus, active,
disabled, loading — and the same vocabulary screen to screen. Lead with the feel, then
the spec.

### Buttons
Confident and quiet — they state the action without shouting.
- **Shape:** gently curved (`rounded-md`, `0.5rem`), padding `0.5rem 1rem`.
- **Primary:** `--primary` oxblood fill, `--primary-foreground` text. The One Voice Rule
  applies — one primary per view.
- **Secondary:** `--muted` fill, `--foreground` text. **Ghost:** transparent, `--muted`
  fill on hover. **Destructive:** `--destructive` fill, `--destructive-foreground` text —
  delete flows only.
- **Hover / Focus:** background shift under `--dur-fast` (120ms); focus shows the oxblood
  `--ring` (`outline-ring/50`). Never a translate on buttons (that's for cards).

### Status Chips
Solid-fill, always readable — the StatusBadge primitive.
- **Style:** a **solid** semantic fill (`--success` / `--verify` / `--warning` / `--info` /
  `--destructive` / `--secondary` for neutral) with its AA-verified `*-foreground` label,
  `rounded-sm`, `0.125rem 0.5rem` padding, optional leading dot.
- **Why solid, not tint:** a tinted-text-on-tint pill cannot clear AA on the paper, so status
  fills solid. Status color is **never** expressed as a pillar/chart hue.

### Cards / Containers
Entries on the page — flat-spec but lifting.
- **Corner Style:** `rounded-xl` (`0.875rem`).
- **Background:** `--card` — the **tape** surface (light: a hair below the paper, read by its
  hairline ring; dark: a step above the carbon). **Border:** neutral `--border` hairline.
- **Shadow Strategy:** rest at `shadow-e1`; interactive cards take the `lift` recipe to
  `shadow-e2` on hover (see Elevation). **No nested cards** — a card inside a card muddies
  the depth language; use a divider or a muted inset instead.
- **Internal Padding:** `1.5rem` (`2xl` spacing).

### Inputs / Fields
Calm fields that come alive on focus.
- **Style:** `--card` background, neutral `--border` stroke, `rounded-md`, `0.5rem 0.75rem`
  padding.
- **Focus:** the oxblood `--ring` appears (border shift + ring), under `--dur-fast`. No glow,
  no glassmorphism.
- **Error / Disabled:** error uses the `--destructive` ring + an icon/message (never color
  alone); disabled drops to `--muted` with reduced opacity.

### Navigation
The sidebar carries the IA; wayfinding is quiet.
- **IA:** three pillars + Manage — **Inventory** (Assets, Consumables) · **Access**
  (Applications) · **Knowledge** (Knowledge Base) · **Manage** (Users, Locations), with
  Dashboard ungrouped on top.
- **Default / Hover / Active:** label on `--foreground`; hover takes a `--sidebar-accent`
  tint; **active** uses a `--muted` tint + oxblood icon/weight (prefer bg-tint + weight +
  icon color over a hard rule). A `≤2px` active selection rule is permitted as a *state*
  indicator only.
- **Mobile:** the mobile nav reuses `SidebarNav`, inheriting the grouping.

### Signature Components
- **`<PillarScope pillar>`** — sets an inherited `--pillar` var for route chrome (oxblood
  fallback when omitted). **Decorative only**: it tints chips, dots, and borders for the
  route's pillar; it never colors readable text.
- **`<EmptyState>`** — the "nothing here yet" surface: a pillar-tinted icon chip
  (`bg-pillar-*/10` + ≥24px glyph) + a one-line invitation ("Nothing here yet — add your
  first asset and it shows up here") + an optional primary action, `rise-in` on mount. One of
  the two sparse moments where the Redaction display face is permitted. Replaces dashed-border
  boxes; teaches the interface instead of saying "nothing here."
- **Recent-activity timeline** — date-group dividers ("Today / Yesterday / Earlier") +
  avatar settle-in + staggered row `rise-in` (capped, initial-mount only), with timestamps and
  IDs in Commit Mono. Honest "Updated Ns ago," never a fake "Live" label.

## 6. Do's and Don'ts

Concrete, forceful guardrails. The anti-references from PRODUCT.md are carried here
verbatim, and the CTO reconciliations below are **hard rules**.

### Do:
- **Do** keep the oxblood stamp to **≤10%** of a screen — action, selection, and state only
  (The One Voice Rule).
- **Do** express pillar identity via a **tinted icon chip** (`bg-pillar-*/10` + an
  `aria-hidden` glyph), a **dot**, or a subtle background **tint** — on the brand-decoupled
  categorical ramp.
- **Do** rest surfaces at `shadow-e1` and **lift on interaction** with the `lift` recipe
  (`-translate-y-0.5` + e1→e2 + ring `/10`→`/15`).
- **Do** reserve the security-green `--verify` seal for the zero-knowledge / Secret-Manager
  mark, kept distinct from the everyday `--success`.
- **Do** keep all motion in **CSS + tw-animate-css**, 150–250ms, conveying state, and
  reduced-motion-safe.
- **Do** treat the pure-neutral **paper/carbon canvas** as a **deliberate, committed brand
  decision** (ADR-0077) — chroma 0, never the warm bone or the AI-cream tell.
- **Do** give metric cards **real substance** — deep-linked breakdowns, tabular numerics in
  Commit Mono — not a hollow number.
- **Do** keep readable text on `--foreground` / `--card-foreground`, or use a semantic
  `StatusBadge` solid-fill with its AA-verified `*-foreground`.
- **Do** ship the full state set on every interactive component (default, hover, focus,
  active, disabled, loading) and the same vocabulary screen to screen.

### Don't:
- **Don't** ship **generic AI-slop dashboards**.
- **Don't** evoke **heavy/dated ServiceNow**.
- **Don't** lean on **SaaS landing clichés**.
- **Don't** use **glassmorphism**.
- **Don't** use **gradient text**.
- **Don't** put **tiny uppercase eyebrows on every section**.
- **Don't** ship the **hollow hero-metric template**.
- **Don't** fall into **"austere SaaS" coldness**.
- **Don't** use `border-left` / `border-right` **greater than 1px** as a colored pillar
  accent on cards, rows, callouts, or alerts (an absolute ban). The narrow exception: a
  `≤2px` active-nav selection rule is allowed as a *state* indicator — but prefer bg-tint +
  weight + icon color.
- **Don't** add a **JS motion library** (framer-motion, gsap, anime, lenis). No
  orchestrated page-load choreography: the route settle is a subtle opacity fade, and the
  metric stagger is minimal and initial-mount only.
- **Don't** reintroduce a **warm or cream tint** to the neutral canvas — the chroma-0 paper
  is a committed decision (ADR-0077); warmth now reads as the AI-cream tell it replaced.
- **Don't** use nested cards.
- **Don't** use a pillar/chart hue as **readable text on the paper or on a `/10` tint**. Keep
  text on `--foreground` / `--card-foreground` or a semantic `StatusBadge` solid-fill.
- **Don't** put **Redaction in product-register UI** — labels, buttons, data cells, dense
  tables; the display face is login + empty-states only.
