---
title: "The Ledger — design language reference (frontend refactor)"
tags: [frontend, design-system, reference, web, refactor]
status: draft
created: 2026-06-29
updated: 2026-10-06
---

# The Ledger — design language reference

Concrete reference for migrating `apps/web` to the **The Ledger** design language. Decision +
rationale: [[0077-ledger-design-language-frontend-refactor]]. **Live source of truth:** the
`lazyit-landing` repo (`DESIGN.md`, `PRODUCT.md`, `src/styles/global.css`, the
`Stamp`/`Rule`/`LedgerRow` primitives). Mirror it; don't re-derive. **No app code changed yet.**

> Register note: the landing is **brand** register; the app is **product** register. Take the
> palette, fonts, mono-for-data, and the ledger patterns — **leave** the manifesto voice, the
> Redaction-everywhere display, and stamps-as-decoration. Stamps in the app are for **status only**.

## 1. Palette (OKLCH)

Pure-neutral surfaces (chroma **0** — explicitly NOT the warm `…95` bone the app has today). The
brand lives in the **stamp**, not the surface.

### Light
| Role | Value | Note |
| --- | --- | --- |
| bg | `oklch(0.985 0 0)` | paper white |
| surface | `oklch(0.965 0 0)` | cards / "tape" device |
| surface-2 | `oklch(0.945 0 0)` | inset rows |
| ink | `oklch(0.18 0 0)` | primary text |
| ink-soft | `oklch(0.42 0 0)` | secondary text (~8:1 on bg) |
| rule | `oklch(0.88 0 0)` | hairline dividers |
| **stamp** | `oklch(0.52 0.2 25)` | oxblood — brand mark / RECORDED |
| **stamp-fill** | `oklch(0.49 0.2 25)` | darker oxblood for **control fills** (white text hits AA in both themes) |
| **verify** | `oklch(0.50 0.13 162)` | security-green — VERIFIED / zero-knowledge / success |

### Dark ("carbon copy")
| Role | Value |
| --- | --- |
| bg | `oklch(0.155 0 0)` |
| surface / surface-2 | `oklch(0.195 0 0)` / `oklch(0.225 0 0)` |
| ink / ink-soft | `oklch(0.96 0 0)` / `oklch(0.70 0 0)` |
| rule | `oklch(0.32 0 0)` |
| stamp (mark) | `oklch(0.62 0.19 25)` (lifted) · **stamp-fill** stays `oklch(0.49 0.2 25)` |
| verify | `oklch(0.66 0.14 162)` |

**Rules:** oxblood = brand mark, key emphasis, the ONE primary action — not sprinkled. Green = only
verified/zero-knowledge/success. No gradients, no glow, no `background-clip:text`. Verify AA for
every text/bg pair in **both** themes (the landing's known trap: white text on the *lifted* dark
oxblood fails AA → use `stamp-fill` 0.49 for fills, not the lifted mark color).

## 2. Type

| Role | From (app today) | To (Ledger) | How |
| --- | --- | --- | --- |
| body / UI (`--font-sans`) | Geist | **Hanken Grotesk** | `next/font/google` (available) |
| data / mono (`--font-mono`, `--font-geist-mono`) | Geist Mono | **Commit Mono** | `next/font/local` or `@fontsource/commit-mono` (NOT on Google Fonts) |
| display (`--font-heading`) | Geist | **Redaction** (sparingly) or Hanken | `@fontsource/redaction` — **only** auth / empty-state / hero; NEVER tables/labels/buttons |

Mono is *earned* (asset IDs, timestamps, audit lines, commands) with `font-variant-numeric:
tabular-nums`. Display ceiling ≤ 6rem, letter-spacing ≥ -0.04em (impeccable rules).

## 2b. Icon / favicon

The mark: **ink "lz" on paper + the oxblood square tick** — the wordmark (`lazyit ▪`) reduced to its
initials. Reference asset (this branch): [`assets/ledger-favicon.svg`](assets/ledger-favicon.svg).
Source of truth: `lazyit-landing` `public/favicon.svg`.

- **Colors:** paper `#f7f6f4`, ink `#1a1a1a`, oxblood tick `#9e2b25` (≈ `--stamp`).
- **Construction (do this):** letters are **vector paths**, NOT `<text>`, and the `<svg>` carries
  explicit `width`/`height`. **Lesson from the landing:** a `<text>`-based favicon (font-dependent,
  no intrinsic size) failed to render in Firefox and VS Code; paths + dimensions render everywhere
  (browser tabs, favicon, standalone `<object>`). Keep it path-based.
- **Wordmark lockup:** mono `lazyit` + the oxblood square tick (the same tick the favicon abstracts).
- **App migration:** replace the `apps/web` favicon and the in-app logo/wordmark with this mark when
  the refactor lands (icon is brand identity → part of the same swap, not a separate decision).

## 3. From → To token map (`apps/web/app/globals.css`)

The app uses the **shadcn CSS-var system**. Swap the **values**; keep the **names** so the change
cascades through every component. (`--primary` is also a button fill → use the AA-safe `stamp-fill`
0.49, not the 0.52 mark.)

| shadcn token | light: today → Ledger | dark: today → Ledger |
| --- | --- | --- |
| `--background` | `0.985 0.004 95` → `0.985 0 0` | `0.205 0.006 75` → `0.155 0 0` |
| `--foreground` | `0.21 0.006 75` → `0.18 0 0` | `0.96 0.004 95` → `0.96 0 0` |
| `--card` | `0.995 0.003 95` → `0.965 0 0` | `0.255 0.007 75` → `0.195 0 0` |
| `--primary` (=`--brand`) | indigo → `0.50 0.2 25` (oxblood, AA fill) | indigo → `0.50 0.2 25` |
| `--primary-foreground` | `0.985 0 0` → keep (white) | keep |
| `--accent` | `0.955 0.005 95` → `0.965 0 0` | `0.30 0.007 75` → `0.225 0 0` |
| `--muted-foreground` | `0.52 0.008 75` → `0.45 0 0` | `0.715 0.006 90` → `0.70 0 0` |
| `--border` | `0.90 0.005 95` → `0.88 0 0` | `… /10%` → `0.32 0 0` |
| `--ring` | `--brand` → oxblood `0.52 0.2 25` | same |
| **NEW** `--verify` | — → `0.50 0.13 162` | — → `0.66 0.14 162` |
| `--destructive` | keep (distinct red; ensure it reads distinct from oxblood brand) | keep |
| pillar/chart (`--chart-*`, `--color-pillar-*`, [[0049-activated-restraint]]) | re-tune to sit on neutral surfaces; keep colour-blind-safe + AA — **own pass** | same |

Fonts: rebind `--font-sans` → Hanken, `--font-mono`/`--font-geist-mono` → Commit Mono in
`apps/web/app/layout.tsx` (replace the `next/font/google` Geist imports).

## 4. Ledger-native patterns (Phase 2 — where the data IS a record)

- **Status → Stamp.** Replace generic status badges with rubber-stamp marks for *state*:
  `VERIFIED` (verify-green), `PENDING`, `RECORDED`, `APPEND-ONLY`. Asset status, grant status,
  PENDING agent tray, secret kind, etc. Stamp = status, never decoration.
- **Audit log → ledger tape.** Activity/audit views as monospace, tabular, hairline-ruled ledger
  rows (`#id  date  ACTION → target  // note`); the activity export already exists.
- **Asset history → the timeline.** The ownership-history timeline IS the brand signature — give
  it the record treatment (the landing's `AuditTape` is the visual model).
- **Tabular data in Commit Mono** with `tabular-nums`: IDs, serials, timestamps, counts, money.
- **Rule dividers** (hairline / perforation) instead of heavy cards/banding. Cards only when truly
  the right affordance (impeccable: "cards are the lazy answer").

## 4b. Record pages (detail layout)

The asset and user detail pages (#1525) share one frame, built from `components/record-page.tsx`.
Use it for any detail page whose record has a handful of headline facts and several secondary
sections.

- **Summary card** (`RecordHero`): the `PageHeader` row (title, status, an identity line with the
  copyable identifier, actions), then the attention row, then the key-facts strip.
- **Attention row** (`RecordAttention` / `AttentionItem`): only the things that need follow-up, most
  severe first, each derived from data already on the page (danger · warning · neutral tints, text on
  the `-text` tokens for AA). Empty → not rendered; a record with nothing to do keeps a calm header.
- **Key facts** (`RecordFacts` / `RecordFact`): four hairline-divided cells answering the questions the
  page is opened for. Counters may be buttons that open their tab; values that are data use mono.
- **Body** (`RecordLayout`): tabbed main content beside a 20rem side column for properties and the
  primary relationships; one column below `xl`. On wide screens the side column drops by the tab bar's
  height so its first panel lines up with the open tab's first panel (#1531). Tabs that list something the viewer cannot read are
  not rendered. The tab lives in `?tab=` through `useRecordTab`, written with `history.replaceState`
  so switching never re-runs the server prefetch.
- **Actions**: the everyday ones stay visible (one primary fill), the rest go in a `⋯` menu with
  destructive items last, behind a separator.

### KB browse (#1539)

The Knowledge Base browse page (`app/(app)/kb/`) applies the same frame to a collection rather than a
record. Its layout follows the URL (`lib/utils/kb-browse.ts`), so the rail, the page and a shared link
always agree, and nothing about *where you are* lives in component state.

- **Rail** (`lg:w-72`, in the persistent `KbShell`): a **Views** list (All articles · My drafts ·
  Recent · Linked) over a **Folders** tree, each section under a small uppercase label; the folders
  label carries the only "+" (new root folder). Views carry mono counts from `limit: 1` reads. A folder
  row is chevron · colour tile · name · padlock (only when restricted, one icon, muted when inherited)
  · mono count, then a `⋯` trigger that shows on hover, focus-within, selection and always under
  `[@media(hover:none)]`. Low-frequency actions (Edit, Move, Access, Delete) live in that menu, never
  as always-visible icon buttons.
- **Colour tile**: a folder's hue is one of the five `--chart-*` tints, hashed from its id
  (`lib/utils/kb-folder-color.ts`) — a `/15` tint plus the glyph in the full hue, decorative only
  (the name is always beside it), so it stays inside the chart-hue AA rule.
- **Home**: `PageHeader` with one stats sentence (mono figures) instead of a subtitle, the search box,
  root-folder cards (tile, name, two-line description, counts, "Restricted"), then the table.
- **Folder header**: §4b's summary card — breadcrumb above, tile + name + description + actions
  (one primary: "New article here"; "Subfolder" outline; the rest in `⋯`), then `RecordFacts`: Who can
  see · Articles · Subfolders · Last change. Sub-folders follow as chips.
- **Table**: a CSS-grid list inside a `@container` card, one link per row, an `aria-hidden` column
  header row. Columns are chosen by **container** width (`@xl`, `@2xl`/`@3xl`), not viewport, because
  the room depends on the app sidebar and the rail; below `@xl` rows stack to two lines. Data cells
  (reading time, relative dates) are mono; the full date rides in `title`.
- **Controls above a list**: a status segmented control (`aria-pressed` toggles with counts), a Sort
  dropdown and a Filters popover for the rarer narrowing; active narrowing shows as chips. Anything that
  changes *how* the list is shown (sort, include sub-folders) survives "Clear filters".

## 4c. Settings pages

Every page under `/settings` (#1533) is a configuration surface, not documentation. They share one frame,
built from `components/settings-section.tsx`, and one set of text rules.

**Text rules** — apply to every section:

1. A section shows its **title**, **one short line** (≤ ~12 words) saying what it does, and its **state
   badge** (On / Off / Configured) in the header. Nothing else as visible prose.
2. Longer explanations live in the **"?" `HelpTip`** on the section title or the field label — kept, but
   trimmed to what an operator needs, with a Manual link where one exists. A field keeps a visible line
   only for a format or constraint needed while typing, a conditional state ("this list is inert while
   its collector is off"), or a risk.
3. **Numbers read as a sentence** when natural: *Each host reports every [15] min and is marked offline
   after [45] min without reporting.* Each inline input keeps an accessible name.
4. **Similar booleans are an icon checkbox grid** (the agent collectors), not a list of switch rows.
5. **One save model per section.** A form keeps its explicit Save in the section footer (with an
   unsaved-changes note); a standalone toggle that already autosaves keeps doing so. A switch that is
   part of a form (SMTP, directory, asset-tag *enabled*) may sit in the section header but still saves
   with the form. A presentation change never changes *when* something saves.
6. **Callouts only for risk** — a revision conflict, a security update, plaintext LDAP. Routine state
   (a preview, a review tray, a suggestion) is a plain row.

**Primitives** (`components/settings-section.tsx`):

- `SettingsSection` — title (+ optional `help` tip), `summary`, `status`, header `actions`, body, `footer`.
  Same surface as `DetailPanel` (`bg-card`, `ring-1 ring-foreground/10`, `rounded-xl`), hairline between
  header, body and footer. Header-only when there is no body (a single action such as *Send a test*).
- `SettingsStatus` — the On / Off / Configured badge (`StatusBadge` success / neutral / info).
- `SettingRow` — label + optional tip on the left, control on the right; rows stack with hairlines.
- `SettingLabel` — a field label followed by its tip, the tip outside the `<label>` (#1407; the AI
  settings' `AiFieldLabel` is an alias of it).
- `SettingsSaveBar` — the footer holding a form's Save, with a muted note on the left.

**Frame.** `settings/layout.tsx` wraps every page except the hub in `SettingsShell`: a sticky grouped side
nav on `lg`+ (Inventory · Access · Integrations · System), a grouped page picker below that. The groups
and items live in `settings/_lib/settings-nav.ts` (`SETTINGS_NAV`), which also builds the hub cards, and
they carry the same gating — `settings:manage` for the area, an optional per-item permission
(Bulk import → `import:run`). The nav shows no state badges: each state is its own read, and fetching
them for the nav would add requests to every settings page. Form pages cap their width at `max-w-3xl`.

## 5. Do / Don't (register translation)

**Do:** the palette · Hanken + Commit Mono · stamps for status · ledger tape for audit · the
timeline · mono+tabular for data · hairline rules · one oxblood accent + green for verify.

**Don't:** manifesto copy voice (app copy stays functional/clear) · Redaction on dense UI · stamps
as decoration · gradients/glow · the warm bone bg · indigo as brand.

## 6. Migration phases

0. **Spike** — re-theme the **asset detail + history** screen only (a literal ledger). Validate in
   product register. Go / no-go for the full sweep.
1. **Tokens + fonts** — the §3 swap + the layout.tsx font rebind. Cascades app-wide. Verify AA both
   themes; check charts/data-viz, emails/print.
2. **Ledger patterns** — §4, selectively where data is a record (status→stamp, audit→tape,
   history→timeline).
3. **Per-screen polish** — long tail.

## 7. Open questions

See [[0077-ledger-design-language-frontend-refactor]] §Open questions: confirm oxblood org-wide,
Redaction in-app scope, chart re-tune, email/PDF scope.
