# Product

## Register

product

## Users

Small in-house **IT / Systems teams (5–20 people)** running their own shop:
asset inventory, application access, consumables, and a knowledge base (tickets land
later). lazyit is an **internal daily-driver tool**, not a sales surface — the person
on screen is never "browsing," they are always **mid-task**: looking up which laptop a
hire was issued, granting an engineer access to an app, offboarding someone who left
this morning, or writing the runbook for the next on-call. They are technically fluent
and impatient with friction; they live in tools like Linear, Stripe, and Notion and
expect the same fit and finish. The audience is the operator, not a buyer or a manager
reading a quarterly chart.

## Product Purpose

lazyit is a **self-hosted, opinionated, IT-native** operations tool for small teams —
"**ServiceNow-grade capability, but modern and IT-native.**" Two product convictions
shape everything:

- **Asset-centric.** The `Asset` is the first-class citizen, not the User — assets
  persist, people rotate. Ownership is a timestamped join, never a column, so history
  is automatic.
- **Auditable by default.** Domain data is never hard-deleted (soft delete); logs and
  ledgers are append-only and immutable. The system can always answer "who had this,
  when, and what changed."

Success is **the tool disappearing into the task.** It is not measured in time-on-site
or dashboard dwell; it is measured in trust. An IT person should trust lazyit the way
they trust Linear, Stripe, or Notion — open it, do the thing, and move on, confident
the record is correct and the history is intact. The product wins by being calm,
correct, and out of the way.

## Brand Personality

Three words: **calm, crafted, IT-native.**

- **Calm.** Quiet by default. The interface does not compete with the work; color is
  seasoning, motion is feedback, and nothing flashes for attention it hasn't earned.
- **Crafted.** Restraint is expressed through craft — considered motion, warm depth, a
  real color identity — not through decoration. The details reward a fluent eye.
- **IT-native.** Built by and for operators. Dense when the task is dense; standard
  affordances over invented ones; the vocabulary of the category, not of a marketing
  site.

**Voice:** direct, expert, no marketing buzzwords. Warm, not clinical — a
**"cared-for workshop, not an austere SaaS."** It speaks to a peer who knows the
domain, never down to a lead being sold to.

## Anti-references

This product should **not** look like:

- Generic AI-slop dashboards.
- Heavy, dated ServiceNow.
- SaaS landing-page clichés.
- Glassmorphism.
- Gradient text.
- Tiny uppercase eyebrows on every section.
- The hollow hero-metric template.
- "Austere SaaS" coldness.

## Design Principles

1. **Asset-centric, observability by default.** Surfaces orbit the asset and its
   history. The interface makes state and provenance legible — who has it, what
   changed, when — because auditability is the product, not a feature bolted on.
2. **Opinionated over configurable.** A curated set of capabilities with sensible
   defaults beats a wall of knobs. We make the right call once so the operator
   doesn't have to make it every time.
3. **Calm but alive.** Restraint expressed through craft — motion, depth, color
   identity — never through flash. The energy comes from how things move and settle
   and layer, not from louder buttons or more chrome.
4. **Earned familiarity.** Standard affordances, consistent vocabulary screen to
   screen. The tool disappears into the task; a user fluent in the category's best
   tools should trust it on sight, never pause at a subtly-off component.
5. **Activate, don't repaint.** Evolve the existing token system rather than relighting
   it. New expression is grafted onto the committed warm-bone + single-indigo
   foundation. **WCAG-AA always**, by construction.

## Accessibility & Inclusion

- **WCAG AA** is the floor in **both** light and dark themes — body text clears
  **≥ 4.5:1** contrast everywhere (the warm-bone system holds ~16:1 for foreground on
  background and ≥ 4.5:1 for muted text).
- **`prefers-reduced-motion` is honored on every animation.** All motion degrades to
  instant; elevation and tone changes still apply, only the movement is removed.
- **Color is never the sole carrier of meaning.** A status, a pillar, or a category is
  always accompanied by a label, an icon, or a dot — never communicated by hue alone.
