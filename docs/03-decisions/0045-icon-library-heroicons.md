---
title: "ADR-0045: Standardize on Heroicons (drop lucide-react) + a two-weight convention"
tags: [adr, web, frontend, icons, ui]
status: accepted
created: 2026-06-01
updated: 2026-06-01
deciders: [Joaquín Minatel]
---

# ADR-0045: Standardize on Heroicons (drop lucide-react) + a two-weight convention

## Status

accepted — 2026-06-01. Decided by the CEO during the UX audit: standardize the web on **one**
icon family. Extends the styling stack ([[0011-tailwind-styling]]); web-only, no API or contract
change.

## Context

A UX audit found `apps/web` shipping **two icon families at once**:

- **`@heroicons/react`** — the de-facto standard across **~57 feature files** (all the pages,
  forms, tables, nav, dialogs). This is what the app actually looks like.
- **`lucide-react`** — confined to a handful of generated **shadcn/ui primitives** (`select`,
  `dropdown-menu`, `dialog`, `sheet`, `command`, and the `sonner` toast icons). shadcn's
  default `iconLibrary` is `lucide`, so every `shadcn add` pulls lucide in by reflex.

Two families means a second dependency, two visual languages, and inconsistent stroke/weight for
the same role. The original product brief mentioned "lucide", but lucide never became the
majority — heroicons did. On top of the family split, the heroicons usages themselves mixed
**three weights** arbitrarily: `24/outline` (65 imports), `16/solid` (4), and `24/solid` (2) —
e.g. a `CheckCircleIcon` was sometimes outline, sometimes solid, for the same status role.

Standardizing on heroicons is the **least-churn** path (it follows the existing majority) and
collapses the app to one coherent icon language.

## Considered options

1. **Standardize on heroicons, drop lucide, adopt a documented two-weight convention.**
   *(chosen.)* Re-map the ~11 lucide icons in the 6 primitives to their closest heroicons
   equivalents, preserving each component's public API and visual size/role; remove the
   `lucide-react` dependency.
2. **Standardize on lucide instead** (the shadcn default). Rejected: would re-skin ~57 feature
   files — by far the larger churn — to chase a family that never actually won here.
3. **Keep both families.** Rejected: that *is* the problem — two dependencies, two visual
   languages, no convention.

## Decision

- **Heroicons is the single icon family for `apps/web`.** `lucide-react` is removed from
  `apps/web/package.json` and the lockfile; no `lucide` import remains anywhere in
  `app/`, `components/`, or `lib/`.
- **Two-weight convention** (no third weight in the app):
  - **`@heroicons/react/24/outline` — the default.** Use it for nav, actions, standalone icons,
    and toolbar/page chrome. Most icons (~70 imports) live here.
  - **`@heroicons/react/16/solid` — the single small variant** for **dense inline / indicator /
    badge** contexts: menu-item check/chevron indicators, select chevrons, checkbox check/dash,
    table sort arrows, filter-clear chips, toast status badges. `16/solid` (not `20/solid`) is
    chosen because it was already the established small variant in the codebase (checkbox,
    active-filters, resource-table) — least churn, one less weight to reason about.
  - **`24/solid` is eliminated** — the two stragglers (the setup `CheckCircleIcon` status/selection
    badges) were folded into `24/outline` so the app never mixes outline+solid for the *same* role.
- **Sizing stays in Tailwind classes** (`size-4` / `size-5` / `size-3.5`, etc.), not in the SVG
  variant. Heroicons render to the box the size class defines, so a `16/solid` glyph at `size-4`
  has the same footprint as the lucide icon it replaced — visual parity is preserved.
- **lucide → heroicons mapping** applied in the primitives:

  | lucide | role | heroicons | weight |
  | --- | --- | --- | --- |
  | `ChevronDownIcon` / `ChevronUpIcon` (select) | dropdown chevrons | `ChevronDownIcon` / `ChevronUpIcon` | 16/solid |
  | `CheckIcon` (select, dropdown) | selection indicator | `CheckIcon` | 16/solid |
  | `ChevronRightIcon` (dropdown sub) | submenu indicator | `ChevronRightIcon` | 16/solid |
  | `XIcon` (dialog, sheet close) | close action | `XMarkIcon` | 24/outline |
  | `SearchIcon` (command) | search affordance | `MagnifyingGlassIcon` | 24/outline |
  | `CircleCheckIcon` (toast success) | status badge | `CheckCircleIcon` | 16/solid |
  | `InfoIcon` (toast info) | status badge | `InformationCircleIcon` | 16/solid |
  | `TriangleAlertIcon` (toast warning) | status badge | `ExclamationTriangleIcon` | 16/solid |
  | `OctagonXIcon` (toast error) | status badge | `XCircleIcon` | 16/solid |
  | `Loader2Icon` (toast loading) | spinner | `ArrowPathIcon` + `animate-spin` | 24/outline |

- **`components.json` `iconLibrary` is set to `heroicons`** to record the standard.

## Consequences

- **Positive:** one icon dependency, one visual language, a documented weight convention; the
  primitives now match the ~57 feature files. `bunx tsc` and `bun run build` (web) are green.
- **Divergence from the shadcn default (known, deliberate).** shadcn's supported `iconLibrary`
  values are `lucide` / `radix`; `heroicons` is **not** a built-in option, so `shadcn add` will
  still emit **lucide** imports into any newly-generated primitive. **Future-add guidance:** after
  `shadcn add <component>`, manually re-map its lucide imports to heroicons using the table above
  (and the two-weight convention) before committing, and do **not** let `lucide-react` creep back
  into `package.json`. A lint rule banning the `lucide-react` import is a possible future guard.
- **`OctagonXIcon` had no exact heroicons twin** (heroicons has no octagon "stop" glyph). The toast
  *error* icon is mapped to **`XCircleIcon`** — the closest filled-circle "error" status badge,
  consistent with the other circular status icons (`CheckCircleIcon` / `InformationCircleIcon`).
- **`Loader2Icon` (spinner) → `ArrowPathIcon`** — heroicons has no dedicated spinner; `ArrowPathIcon`
  with `animate-spin` is the standard heroicons loading affordance.
- **No logic changed** — only the icon source/weight. Component public APIs (props, `data-slot`s,
  `sr-only` labels) are untouched.

## References

- [[0011-tailwind-styling]] (Tailwind + shadcn/ui styling) · [[0010-nextjs-frontend]] ·
  [[0020-frontend-data-layer]].
