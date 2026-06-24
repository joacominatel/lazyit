---
title: "ADR-0072: Quick View — entity-preview popover in pickers & search"
tags: [adr, frontend, ux, a11y, motion, pickers, search]
status: accepted
created: 2026-06-24
updated: 2026-06-24
deciders: [Joaquín Minatel]
---

# ADR-0072: Quick View — entity-preview popover in pickers & search

## Status

**accepted** — 2026-06-24 (CEO ratification). Epic #788. **Wave 1 built** — issue #789: the
foundation primitive (`apps/web/components/quick-view-popover.tsx` + the pure presenter
`apps/web/components/quick-view-fields.ts`) plus the single-select rollout (the shared
`components/combobox.tsx` eye/pin seam and 5 of the 6 entity wrappers). Waves 2 (multi-select,
#790) and 3 (global command palette, #791) build on the same primitive.

## Context

The app's entity pickers (the shared `Combobox` and its per-entity wrappers — asset, user, asset
model, application, location, category) and the global command palette show a **terse one-line
label** per row: an asset by name, a user as "Juan D.", a model as "Dell Latitude", an article by
title. Operators routinely can't tell two rows apart from the label alone — two "MacBook Pro"s,
two "Ana"s, a slug they don't recognise — and today the only way to disambiguate is to **leave the
flow**, open the entity in another tab, look, and come back. That is friction on the most common
verbs in the product (assign an asset, grant access, link a KB article).

We want a **generous, rich preview** of the row under the cursor/selection — serial + model +
location + owner + status for an asset; email + role + manager + counts for a user — surfaced
**inline, without navigating away**, and reachable by keyboard.

Constraints that shaped the decision:

- **No new fetch, no new endpoint, no widened payload.** The list endpoints are already the
  inventory's heaviest (ADR-0030); we will not add round-trips or fatten rows for a preview.
- **a11y is not optional.** The affordance must be a real focusable control, the field grid must
  be real `<dl>`/`<dt>/<dd>`, the pinned panel must read as a dialog, and focus must return on
  Escape.
- **Motion budget (ADR-0049).** ≤220ms, `prefers-reduced-motion` honoured.
- **INV-10 / SEC-008.** A preview must never surface a secret value, and an Application `url` must
  never become an executable-scheme sink.

## Decision

### 1. Primitive — the existing radix Popover (NOT HoverCard/Tooltip)

Quick View is built on the **already-vendored shadcn/radix `Popover`** (`components/ui/popover.tsx`),
controlled (`open` + an app-level `pinned`). We deliberately do **not** reach for HoverCard or
Tooltip: neither is vendored in this repo, and HoverCard is hover-only — it cannot do the **click /
Enter / Space to pin** interaction or the keyboard story this needs. The Popover gives us a portal,
collision-aware positioning, focus management and Escape-to-close-and-return-focus for free.

The new app-level composition is `components/quick-view-popover.tsx` — an **entity-aware presenter**
that reuses existing primitives rather than reinventing them:

- `DetailField` (`components/detail-panel.tsx`) — already emits `<dt>`/`<dd>`, so the field grid is
  real `<dl>` semantics with zero new markup.
- the entity status badges — `AssetStatusBadge`, `UserStatusBadge` + `UserRoleBadge`,
  `LocationTypeBadge`, `ArticleStatusBadge` (in their feature `_components/` folders; already imported
  cross-feature elsewhere).
- `UserAvatar` (`components/user-avatar.tsx`) for the person identity row.
- a small **own glyph map** for the non-person entities. We did **not** lift the
  `ENTITY_ICON` map out of `global-search.tsx`: that map is keyed to the search-scoped
  `SearchEntity` union (6 keys), while Quick View's entity set is a **superset** (it adds
  `assetModel` / `consumable` / `category`, which the palette doesn't index). Sharing one map across
  two different key sets is more coupling than copying eight icon references — not cleaner, so each
  surface keeps its own.

The panel is three zones: **identity row** (glyph or avatar + title + status/role badge) → `Separator`
→ a `<dl>` **field grid**. A **pinned-only footer** deep-links to the entity detail route in a new
tab (`target="_blank" rel="noreferrer"`); entities with **no standalone detail route** (asset model,
consumable, category) render no footer link.

### 2. Data — reuse the in-memory row the picker already loaded (zero extra fetch)

The load-bearing decision. Each entity wrapper already calls its `q`-driven paged list hook
(`useAssets`, `useUserList`, `useApplicationList`, …) and **discards everything but `{ value, label }`**
when mapping rows into `ComboboxItem`s. Quick View stops discarding: the wrapper keeps a
`Map<id, row>` over the **same** `data.items` it already holds and hands the matching row to the
preview. **No new fetch, no new endpoint, no widened list payload, no N+1.**

This is sound because the list rows are already a **rich superset** of what the preview needs (verified
against the shared list schemas): `AssetListItem` carries serial/assetTag/status + trimmed
model/category/location; `UserListItem` is the full `UserSchema` + the optional asset/app counts;
the application/model/location rows are the full entity. Minor gaps (e.g. an owner's display name on
an asset row, a category name where a row only carries an id) are **resolved from the loaded data or
omitted** — never backfilled with a per-row fetch.

The **global command palette** (wave 3) is the one exception: its search hits are lean (id + a couple
of fields), so it will lazily fetch-on-open the entity's existing detail hook (deduped, cached, only
the opened item) — still no new endpoint. That is scoped to #791.

The **seam** in the shared `Combobox` is an optional callback prop — `quickView?: (value: string) =>
QuickViewData | null`. When supplied, each row gains the eye; when omitted (the default) **no eye
renders**, so non-entity pickers (the category list, the workflow data-mapping editor) are unchanged.
The callback returns *data*, not a rendered popover: the `Combobox` owns the open/pinned/single-open +
focus interaction centrally, and the wrapper only supplies the already-loaded row. The pure
field-selection logic lives in `components/quick-view-fields.ts` (`selectFields` / `titleFor` /
`detailHref`) so it is unit-testable without React (`quick-view-fields.test.ts`).

**`category-combobox` is intentionally NOT wired in wave 1.** Its rows carry only `{ id, name }` — the
name IS the visible label, so a preview would show the label back with no extra fields and no detail
route: zero disambiguation value. The seam is ready if richer category data ever lands; until then the
honest choice is no eye there.

### 3. Affordance + interaction (a11y)

- **The eye is a real focusable `<button>`**, not a hover-only glyph. It is `opacity-0` and revealed by
  `group-hover/row` **and** `group-data-[selected=true]/row` — so cmdk's arrow-key roving selection
  reveals it for **keyboard** users, not just mouse hover. It carries `aria-label="Quick view: {name}"`
  and a visible `focus-visible` ring.
- The eye `stopPropagation`/`preventDefault`s on click **and** on its own Enter/Space `keydown`, so
  activating it **never selects the row** (the row's primary action stays "pick this").
- **Hover** (after a ~120ms intent delay, so skimming doesn't flicker previews) opens a **transient
  preview**; **click / Enter / Space pins** it (shows the footer + takes dialog semantics). Clicking a
  pinned eye toggles it closed.
- **Single open at a time** — `openQuickViewId` is lifted into the `Combobox`, so opening one row's
  preview closes any other.
- **Escape closes and returns focus to the eye** — radix Popover's default focus-return to the anchor
  (the eye is the `PopoverAnchor`) gives this for free; closing the picker also dismisses any open
  preview (its anchor is about to unmount).
- **Dialog semantics only when pinned** — a pinned panel gets `role="dialog"` + `aria-labelledby` on
  the identity title; a transient hover preview stays role-less (a passive surface) and does not steal
  focus (`onOpenAutoFocus` prevented), so it never fights cmdk's roving focus.

### 4. Motion (ADR-0049 honoured)

The panel reuses the Popover's **existing enter/exit animation** (~100ms fade/zoom — well under the
220ms budget). The eye reveal is `transition-opacity duration-150` with **no transform**. Both are
covered by the global `prefers-reduced-motion` guard in `globals.css`, which collapses every
`transition-duration`/`animation-duration` to ~instant — so reduced-motion users get the eye and the
panel with no movement.

### 5. Security (INV-10 / SEC-008 honoured)

Quick View carries **no secret fields at all** — the presenter never reads or emits a secret value
(INV-10), and the infra-node preview's secret references (wave 2/3) are **handles only**, never values.
An Application `url` is shown as **plain text** gated by `isSafeApplicationUrl` (SEC-008): an
unsafe-scheme url is dropped, and it is never used as a link `href` in the preview.

## Consequences

**Positive**

- Operators disambiguate terse rows in-flow, no tab-hopping, fully keyboard-reachable.
- Zero backend work, zero new endpoints, zero added fetches in the picker path (wave 1).
- One primitive + a tiny optional prop; the 6 wrappers each gain ~6 lines; non-entity pickers are
  untouched. The pure presenter is unit-tested.
- a11y and motion are correct by construction (real `<button>`, real `<dl>`, dialog-when-pinned,
  focus-return, reduced-motion via the global guard).

**Negative / trade-offs**

- The preview reflects the **list row**, which is intentionally trimmed (ADR-0030) — a couple of
  detail-only fields (e.g. asset notes, full specs) are not shown. By design: the footer deep-link is
  the path to the full record.
- The eye is `tabIndex={-1}` (cmdk owns roving focus over the list); it is reached by mouse or by its
  row being cmdk-selected, not by a separate Tab stop. This matches cmdk's focus model rather than
  fighting it.
- The status badges live in feature `_components/` folders; importing them into a shared `components/`
  primitive widens those imports' reach. Acceptable — they are already imported cross-feature, and
  promoting them is out of scope for this wave.

## Honoured invariants / related ADRs

- **ADR-0049** (motion budget) — reused Popover anims, opacity-only eye reveal, reduced-motion guard.
- **ADR-0021** (KB design) / **ADR-0030** (list pagination contract) — the article preview and the
  reuse-the-already-loaded-trimmed-row decision sit on these.
- **INV-10** (secrets are handles, never values) / **SEC-008** (safe-scheme app urls only).
- **ADR-0011** (Tailwind styling) / **ADR-0051** (i18n: `common.quickView.*`, en+es).

## Alternatives considered

- **HoverCard / Tooltip** — rejected: not vendored, hover-only, no click-to-pin or keyboard story.
- **A new lean "preview" endpoint per entity** — rejected: the list rows already carry a superset;
  a new endpoint is pure cost for no data we don't already have.
- **Widen the list payloads** — rejected: the list endpoints are the heaviest in the app (ADR-0030);
  a preview must not fatten the common path.
- **Render the popover inside each wrapper** — rejected: it would scatter the open/pinned/single-open +
  focus logic across 6 wrappers; centralising it in the `Combobox` behind a data-only callback keeps
  the a11y wiring in one place.
