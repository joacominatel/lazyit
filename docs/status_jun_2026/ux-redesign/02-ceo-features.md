# 02 · Deep-dives de las features pedidas

## Multi-language (Spanish) — cookie-locale i18n with next-intl, no route restructure

Add English + Spanish to lazyit using next-intl in cookie-based, no-prefix mode (no /es/ URLs, no app/[locale] restructure, no extra middleware). The convention "English everywhere" still governs CODE — identifiers, message KEYS, comments and docs stay English; only VALUES get translated, which is genuinely new and needs an ADR. The locale lives in a NEXT_LOCALE cookie read in a setRequestLocale-free getRequestConfig; a thin server action sets it. Catalogs are two flat JSON dictionaries (messages/en.json, messages/es.json) keyed by namespace.key (e.g. nav.assets, dashboard.needsAttention.title). Server Components and Client Components both read via useTranslations/getTranslations, with one NextIntlClientProvider added in app/providers.tsx. The switcher is a Globe-icon control placed in the topbar user-menu (above the Sign out separator), persisted to the cookie and applied with router.refresh(). Intl date/number/relative-time formatting routes through next-intl's formatter so the existing formatRelativeTime helper gets a locale. This is an evolution, not a repaint: zero token/AA impact, it just makes the chrome bilingual. The honest cost is the string-extraction migration across ~57 string-bearing tsx files — that is the real effort, and it is incremental (the app keeps building with partial extraction because untranslated text simply stays hardcoded English until pulled into the catalog).

**Esfuerzo:** Phase 0 plumbing + bilingual chrome + working switcher: ~0.5–1 day (~6 files: i18n/request.ts, next.config.ts wrap, providers.tsx, layout.tsx lang, set-locale action, user-menu switcher + nav/common catalogs). Dashboard (Phase 1): ~0.5 day (showcases ICU plurals, replaces ~8 hand-rolled ternaries). Per-pillar list+detail extraction (Phase 2): ~0.5–1 day each across 6 pillars = ~3–5 days. Shared primitives + toasts (Phase 3): ~0.5 day. Spanish translation value pass (Phase 4): ~1–2 days content work, parallelizable. TOTAL for full coverage: ~6–9 dev-days, fully incremental and non-breaking — but a usable, demo-able bilingual product exists after Phase 0–1 (~1.5 days). One coordination touch: next.config.ts is DevOps-lane-owned (ADR-0025), so the plugin wrap needs a heads-up to that agent.

### Diseño

# Deep-dive: Multi-language (add Spanish)

## 0. Decision in one line
Use **next-intl** in **cookie-based, no-prefix** mode. No `/es/` URLs, no `app/[locale]/` restructure, no new `middleware.ts`. Catalogs are two flat JSON dictionaries (`en`, `es`) keyed by `namespace.key`. The switcher lives in the topbar user-menu.

This is the lowest-blast-radius path that is still idiomatic for **Next.js 16 App Router + React 19 RSC** — which is exactly the stack here (`next 16.2.6`, `react 19.2.4`, verified in `apps/web/package.json`).

---

## 1. Why next-intl (and not the alternatives)

Grounded constraints from the repo:
- **No i18n lib installed today** (confirmed — `package.json` has no `next-intl` / `i18next` / `react-intl`). This is a genuine new dependency → **ADR required** (the brief says so; it's also a new product capability, not a refactor).
- **`app/(app)/` is a route GROUP, not a dynamic segment.** Adding a `[locale]` prefix would force moving the entire tree under `app/[locale]/(app)/…` AND introducing a `middleware.ts` (there is **none** today — Auth.js is wired purely through `auth.ts`, confirmed). That is a large, risky structural change for an **internal** tool where SEO-friendly localized URLs have zero value.

| Option | RSC-native | Route restructure | New middleware | Verdict |
| --- | --- | --- | --- | --- |
| **next-intl (cookie, no prefix)** | ✅ first-class | ❌ none | ❌ none | **Chosen** |
| next-intl (`/es/` prefix) | ✅ | ✅ whole tree → `app/[locale]/…` | ✅ required | Rejected — cost ≫ value for internal app |
| react-i18next / i18next | ⚠️ client-leaning, RSC story is bolted-on | ❌ | ❌ | Rejected — weaker RSC support, more wiring |
| Hand-rolled dict + Context | ❌ no RSC formatter, no plural/ICU | ❌ | ❌ | Rejected — we'd reinvent Intl plurals badly |

next-intl gives us: RSC + Client parity, ICU message syntax (plurals/select — we have **lots** of `count === 1 ? "" : "s"` in `dashboard/page.tsx` lines 343–375 that ICU plurals replace cleanly), and a built-in `Intl` formatter for dates/numbers/relative time.

---

## 2. Locale strategy — cookie, no URL prefix

- **Source of truth:** a `NEXT_LOCALE` cookie (next-intl's default cookie name). Values: `en` (default) | `es`.
- **No URL changes.** `/dashboard`, `/assets/:id` stay exactly as they are. Bookmarks, deep-links from the dashboard's pre-filtered rows, and the breadcrumb all keep working untouched.
- **No middleware.** `getRequestConfig` reads the cookie directly. This is the single biggest reason to go cookie-mode: it keeps Auth.js (`auth.ts`) as the only request-time interception and avoids a middleware-ordering problem.
- **Persistence:** a tiny server action writes the cookie (httpOnly:false so a future client read is possible, `sameSite=lax`, 1-year maxAge), then `router.refresh()` re-renders Server Components with the new locale. Per-user, per-browser — appropriate for a 5–20 person internal app. (A future enhancement could persist locale on the User row, but that's backend debt we are NOT taking now.)

### Wiring (4 small files, ~40 LOC total)

**`apps/web/i18n/request.ts`** (next-intl server config):
```ts
import { getRequestConfig } from "next-intl/server";
import { cookies } from "next/headers";

export const locales = ["en", "es"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export default getRequestConfig(async () => {
  const store = await cookies();
  const cookieLocale = store.get("NEXT_LOCALE")?.value;
  const locale = (locales as readonly string[]).includes(cookieLocale ?? "")
    ? (cookieLocale as Locale)
    : defaultLocale;
  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
```

**`apps/web/next.config.ts`** — wrap with the plugin (the ONE infra edit; coordinate with DevOps lane since they own this file per ADR-0025):
```ts
import createNextIntlPlugin from "next-intl/plugin";
const withNextIntl = createNextIntlPlugin("./i18n/request.ts");
const nextConfig: NextConfig = { output: "standalone" };
export default withNextIntl(nextConfig);
```

**`apps/web/app/layout.tsx`** — set the real `<html lang>` from the active locale (today it's hardcoded `lang="en"`, line 36):
```tsx
import { getLocale } from "next-intl/server";
// ...
const locale = await getLocale();
return <html lang={locale} suppressHydrationWarning ...>
```

**`apps/web/app/providers.tsx`** — add the client provider so Client Components (the bulk of this app — `"use client"` is everywhere) can call `useTranslations`:
```tsx
import { NextIntlClientProvider } from "next-intl";
// messages are passed from a server boundary; in App Router the provider can
// inherit them automatically when rendered under the RSC tree. Providers is a
// client component, so it receives `messages`+`locale` as props from layout.
<NextIntlClientProvider>{/* existing tree */}</NextIntlClientProvider>
```
> Note: because `providers.tsx` is `"use client"`, pass `locale` + `messages` into it from a server parent (root `layout.tsx`) so the provider hydrates correctly. Server Components call `getTranslations()` directly with no provider needed.

**`apps/web/app/actions/set-locale.ts`** — the persistence action:
```ts
"use server";
import { cookies } from "next/headers";
export async function setLocale(locale: "en" | "es") {
  (await cookies()).set("NEXT_LOCALE", locale, {
    path: "/", maxAge: 60 * 60 * 24 * 365, sameSite: "lax",
  });
}
```

---

## 3. Catalog structure & key naming

- Two files: **`apps/web/messages/en.json`** and **`apps/web/messages/es.json`**, identical key shape.
- **Keys are English, namespaced by surface** — `nav.*`, `common.*`, `dashboard.*`, `users.*`, `assets.*`, `actions.*`, `status.*`. This honors "English everywhere governs CODE" (keys ARE code).
- **`common.*`** holds the repeated verbs/nouns that appear across every screen (Save, Cancel, Delete, Refresh, "No data yet", etc.) — extract these FIRST; they cover a big fraction of strings cheaply.
- **ICU plurals** replace the hand-written `count === 1 ? "" : "s"` ternaries (e.g. dashboard attention rows). One key, both languages handle their own plural rules.
- **Enum labels** (AssetStatus, roles) get a `status.*` / `role.*` namespace. Note the enum VALUES on the wire stay English/uppercase (`OPERATIONAL`) — only the DISPLAY label is translated, mirroring the existing `formatAssetStatus` mapping in `assets/_components/asset-status-badge`.

See the mockup section for a real catalog snippet.

---

## 4. Server + Client read pattern

| Component kind | API | Example |
| --- | --- | --- |
| Server Component | `const t = await getTranslations("dashboard")` | dashboard page metrics labels |
| Client Component | `const t = useTranslations("nav")` | `sidebar-nav.tsx`, `user-menu.tsx` |
| Dates/numbers/relative | `const f = useFormatter()` / `getFormatter()` | replaces the locale-less `formatRelativeTime` |

`sidebar-nav.tsx` (a Client Component, line 1 `"use client"`) becomes: keep the `NAV` array structure but swap `label: "Assets"` → `labelKey: "assets"` and render `t(item.labelKey)`. Section headings (`Inventory`/`Access`/`Manage`) → `t(\`sections.${...}\`)`.

---

## 5. Intl — dates, numbers, plurals

- **Relative time** ("Updated 3m ago", activity feed timestamps): today `lib/utils/format.ts#formatRelativeTime` takes `(date, now)` with no locale. Route it through next-intl's `format.relativeTime(date, now)` which uses `Intl.RelativeTimeFormat` under the active locale. ("hace 3 min" in es).
- **Numbers** (the `tabular-nums` metric counts on pillar cards): `Intl.NumberFormat` via the formatter so thousands separators localize (1,250 → 1.250 in es-ES). Low effort, nice polish.
- **Plurals**: ICU `{count, plural, one {# grant} other {# grants}}` → Spanish `{count, plural, one {# concesión} other {# concesiones}}`. Removes ~8 hand-rolled English-only ternaries on the dashboard alone.

---

## 6. Switcher UX & placement

**Placement: topbar user-menu** (`components/user-menu.tsx`), inserted as a labeled row ABOVE the `DropdownMenuSeparator` that precedes "Sign out" (line 75). Rationale:
- The user-menu already groups per-identity preferences (name/email/role badge); language is a per-user preference → it belongs here, next to where Sign out lives.
- Keeps the topbar's right cluster (`ModeBanner · ThemeToggle · UserMenu`, in `(app)/layout.tsx` line 51–55) from gaining a 4th standalone control. Theme-toggle stays icon-only beside it; language sits INSIDE the menu, not as a sibling button — less chrome clutter.
- A **Globe icon** (`GlobeAltIcon` from `@heroicons/react/24/outline` — within the allowed icon set, no new dep) labels it.

Interaction: a small inline segmented control (EN | ES) or two `DropdownMenuItem`s with a check on the active one. On select → call the `setLocale` server action → `router.refresh()`. No full reload, no flash (cookie + RSC re-render). Respects the existing dropdown motion (Radix slide/zoom via tw-animate-css).

**Alternative considered:** a dedicated row in `/settings`. Rejected as the PRIMARY location because Settings is ADMIN-only (gated in `sidebar-nav.tsx` line 78) — language must be reachable by every user (MEMBER/VIEWER), so it can't live behind `settings:manage`. (Settings COULD later host an org-default-locale toggle; that's a separate admin feature.)

---

## 7. Incremental string-extraction migration path

The library wiring is ~half a day. The honest bulk of the work is extraction across **~57 string-bearing `.tsx` files** (measured: files in `app/` + `components/` with capitalized JSX text). This is **incremental and non-breaking** — the app builds and ships at every step because any not-yet-extracted string just stays hardcoded English.

**Phased rollout (PR-per-phase, matches the file-by-file commit convention):**
1. **Phase 0 — Plumbing (1 PR):** add dep, `i18n/request.ts`, `next.config.ts` wrap, provider, `set-locale` action, `<html lang>` dynamic, the switcher control, and `common.*` + `nav.*` catalogs. Ship: chrome (sidebar, user-menu, breadcrumb) is bilingual; switcher works. **Visible win immediately.**
2. **Phase 1 — Dashboard (1 PR):** `dashboard/*` + `recent-activity-panel` (high-visibility, lots of plurals → showcases ICU).
3. **Phase 2 — Pillar lists & detail (per-pillar PRs):** assets, consumables, applications, kb, users, locations — one pillar at a time, each self-contained.
4. **Phase 3 — Shared primitives copy:** `DeleteConfirmDialog`, `ResourceTable` empty/error states, `EmptyState`, toasts — these cascade everywhere once done.
5. **Phase 4 — `es.json` translation pass + lint guard:** fill Spanish values; optionally add an ESLint rule (`eslint-plugin-formatjs` no-literal-string or a custom check) to flag NEW hardcoded JSX strings in extracted files, preventing regression. (Flag the lint rule as optional — it can be noisy on an internal app.)

**Scope honesty:** ~57 files touched eventually, but only ~6 files in Phase 0 to get a working bilingual chrome + switcher. Translating en→es VALUES (~300–500 strings estimated across the app) is the long pole and is a content task, parallelizable, and reviewable per-pillar.

---

## 8. What this does NOT touch (evolution discipline)
- **Zero token / AA impact.** No color, no globals.css, no shadcn primitive edits. Pure text layer.
- **No backend contract change** for the MVP (locale is client/cookie-only). See backend-debt for the optional future server-persisted locale.
- **The categorical-color / motion mandate is orthogonal** — i18n is the "practicality" leg of the CEO's ask, not the "vibe" leg. It can land in parallel with the visual-evolution work without conflict.

### Mockup

## A) Language switcher in the topbar user-menu

Closed state (topbar right cluster, unchanged footprint):

```
┌───────────────────────────────────────────────── header (h-14) ──┐
│ [≡]  [🔍 Search…]                         [mode]  [☀/☾]  ( JM )    │
└───────────────────────────────────────────────────────────────────┘
                                                            ▲ click avatar
```

Open state (DropdownMenu, Globe row added above the Sign-out separator):

```
                                          ┌──────────────────────────┐
                                          │  Joaquín Minatel         │
                                          │  joaco@acme.com          │
                                          │  [ ADMIN ]               │  ← role badge
                                          ├──────────────────────────┤
                                          │ 🌐  Language             │  ← GlobeAltIcon (24/outline)
                                          │      ┌────────┬────────┐  │
                                          │      │  EN ✓  │   ES   │  │  ← inline segmented
                                          │      └────────┴────────┘  │     (active = primary tint)
                                          ├──────────────────────────┤
                                          │  Sign out                │
                                          └──────────────────────────┘
```
Select ES → server action sets NEXT_LOCALE cookie → router.refresh() → chrome re-renders in Spanish, same URL, no reload flash.

After switch (sidebar reflects the new locale — keys unchanged, values translated):

```
  EN                          ES
  ─────────                   ─────────
  Dashboard                   Panel
  INVENTORY                   INVENTARIO
   • Assets                    • Activos
   • Consumables               • Consumibles
  ACCESS                      ACCESO
   • Applications              • Aplicaciones
  KNOWLEDGE                   CONOCIMIENTO
   • Knowledge Base            • Base de conocimiento
  MANAGE                      GESTIÓN
   • Users                     • Usuarios
   • Locations                 • Ubicaciones
   • Settings                  • Configuración
```

## B) Sample catalog snippet — flat, namespaced, English keys

`apps/web/messages/en.json`
```json
{
  "common": {
    "save": "Save",
    "cancel": "Cancel",
    "refresh": "Refresh",
    "noDataYet": "No data yet.",
    "updatedRelative": "Updated {time}"
  },
  "language": { "label": "Language", "en": "English", "es": "Spanish" },
  "nav": {
    "sections": { "inventory": "Inventory", "access": "Access",
                  "knowledge": "Knowledge", "manage": "Manage" },
    "dashboard": "Dashboard", "assets": "Assets",
    "consumables": "Consumables", "applications": "Applications",
    "kb": "Knowledge Base", "users": "Users",
    "locations": "Locations", "settings": "Settings"
  },
  "dashboard": {
    "title": "Dashboard",
    "subtitle": "Your IT estate at a glance — Inventory, Access and Knowledge.",
    "needsAttention": { "title": "Needs attention",
      "allClear": "Nothing needs attention right now." },
    "attention": {
      "expiringGrants": "{count, plural, one {# grant expiring within {days} days} other {# grants expiring within {days} days}}",
      "lost": "{count, plural, one {# asset marked lost} other {# assets marked lost}}"
    }
  },
  "status": { "OPERATIONAL": "Operational", "IN_MAINTENANCE": "In maintenance",
              "IN_STORAGE": "In storage", "RETIRED": "Retired", "LOST": "Lost" }
}
```

`apps/web/messages/es.json` (same keys, translated VALUES; ICU plural rules differ per language)
```json
{
  "common": {
    "save": "Guardar",
    "cancel": "Cancelar",
    "refresh": "Actualizar",
    "noDataYet": "Sin datos todavía.",
    "updatedRelative": "Actualizado {time}"
  },
  "language": { "label": "Idioma", "en": "Inglés", "es": "Español" },
  "nav": {
    "sections": { "inventory": "Inventario", "access": "Acceso",
                  "knowledge": "Conocimiento", "manage": "Gestión" },
    "dashboard": "Panel", "assets": "Activos",
    "consumables": "Consumibles", "applications": "Aplicaciones",
    "kb": "Base de conocimiento", "users": "Usuarios",
    "locations": "Ubicaciones", "settings": "Configuración"
  },
  "dashboard": {
    "title": "Panel",
    "subtitle": "Tu parque de TI de un vistazo — Inventario, Acceso y Conocimiento.",
    "needsAttention": { "title": "Requiere atención",
      "allClear": "No hay nada que requiera atención ahora mismo." },
    "attention": {
      "expiringGrants": "{count, plural, one {# concesión que vence en {days} días} other {# concesiones que vencen en {days} días}}",
      "lost": "{count, plural, one {# activo marcado como perdido} other {# activos marcados como perdidos}}"
    }
  },
  "status": { "OPERATIONAL": "Operativo", "IN_MAINTENANCE": "En mantenimiento",
              "IN_STORAGE": "En almacén", "RETIRED": "Retirado", "LOST": "Perdido" }
}
```

Usage:
```tsx
// Server Component
const t = await getTranslations("dashboard");
<h2>{t("needsAttention.title")}</h2>
<p>{t("attention.lost", { count: lost })}</p>

// Client Component (sidebar-nav.tsx)
const t = useTranslations("nav");
<span>{t(item.labelKey)}</span>   // labelKey: "assets" → "Assets" / "Activos"
```

### Deuda de backend

MVP needs NO backend change — locale is client/cookie-only and the existing API contract is untouched. Two OPTIONAL future items (do NOT take them now; they each need their own ADR/issue):

1. Server-persisted per-user locale: add `locale` (nullable enum 'en'|'es') to the User model so a user's language follows them across browsers/devices. Requires a Prisma migration, a PATCH on /users/me, and a shared zod schema change (locked contract → ADR discussion per project rules). Cookie-mode is deliberately chosen to AVOID this for v1.

2. Org default locale: a Settings/instance config value so a fresh user inherits the org's preferred language before they pick one. Backend config surface + ADMIN-gated write. Pure enhancement.

Note: API error messages, audit-log summaries, and the x-request-id error UX remain English (server-side). Translating server-originated strings (e.g. validation messages surfaced from the API) is explicitly OUT OF SCOPE — the UI translates only its own client strings; API responses stay English. If localized API errors are later wanted, that's a separate, larger backend i18n effort.

### Decisiones para el CEO
- APPROVE the new dependency + new capability: next-intl is a new runtime dep and translating UI VALUES (not code) is a new product capability — both need a new ADR (e.g. ADR-00xx 'UI internationalization'). Confirm we're adding Spanish as a first-class language, English default.
- CONFIRM locale strategy = cookie, no /es/ URL prefix. This keeps URLs and the whole app/(app)/ route tree unchanged and adds NO middleware. The trade-off: language is a per-browser preference, not in the URL (can't share an 'es' link). For an internal 5–20 person tool this is the right call — confirm you agree vs. wanting shareable localized URLs (which costs a full route restructure + middleware).
- CONFIRM switcher placement = inside the topbar user-menu (Globe row above Sign out), reachable by EVERY role. Alternative is a row in /settings, but Settings is ADMIN-only so non-admins couldn't change their language — reject Settings as the primary home. OK?
- SCOPE the rollout: Phase 0 (bilingual chrome + working switcher) is ~half a day and lands a visible win. Full coverage is ~57 files / ~300–500 strings, done incrementally per-pillar, non-breaking at every step. Decide whether to commit to full coverage now or ship Phase 0–1 (chrome + dashboard) and extract the rest opportunistically.
- DECIDE on the anti-regression lint rule (flag NEW hardcoded JSX strings). Helps keep es/en in sync long-term but can be noisy. Optional — opt in or skip.
- ACKNOWLEDGE out-of-scope: server-originated text (API validation messages, audit summaries, error UX) stays English in v1. Per-user server-persisted locale and org-default locale are deferred backend items. Confirm that's acceptable for launch.

---

## Offboarding & Return Act — a printable, signable "acta de baja/devolución" replacing the plain delete alert

Replace the cramped DeleteConfirmDialog on /users/[id] with a full-height right Sheet ("Offboarding") that reframes deletion as a dignified, printable HR/IT act the departing employee signs to declare they returned everything. The Sheet shows the person, the assets to RETURN (active assignments), the application access being REVOKED (active grants), an editable free-text message, and two signature placeholders (Employee + IT). A Print button opens a dedicated print route (/users/[id]/offboarding/act) styled for a single sheet: org letterhead + date, a checkbox return-checklist, the message, and two signature blocks. Crucially the act is decoupled from the destructive action: you can Print the act first (recommended — employee signs the physical sheet, THEN you confirm), or confirm-then-print the receipt. Confirm fires the existing transactional offboard (soft-delete + revoke grants + release assignments). Everything composes existing primitives (Sheet, Card, StatusBadge, UserAvatar, Button) and activates the dormant token system: per-pillar categorical hues on the two lists (teal=inventory/assets, indigo=access), tw-animate-css slide/stagger entrance, prefers-reduced-motion respected, AA solid status pills. Two real backend gaps: (1) the active-assignments read returns bare assetId only — the act wants tag/serial/model/category, so it needs an expanded read or a purpose-built offboarding-manifest endpoint; (2) there is no writable instance-settings store for the configurable message/letterhead (instance config is env-only, read-only today) — v1 ships an inline editable message persisted to localStorage, with a backend instance-settings field as the proper follow-up.

**Esfuerzo:** Medium. v1 is frontend-only and composes existing primitives — no backend, no new runtime deps. Net-new: offboardUser endpoint + useOffboardUser hook (trivial, mirrors delete), OffboardSheet component (~the bulk: header, impact strip, two token-tinted lists, editable message, sticky footer, motion), the shared OffboardReturnAct document, a thin print route that reuses it, a localStorage message hook, and a globals.css addition (2 keyframes + an @media print block). One swap on users/[id]/page.tsx (open the Sheet instead of DeleteConfirmDialog). Possibly vendor shadcn `checkbox` via CLI. Roughly a 2-3 day frontend task. Optional small backend follow-ups (offboarding manifest read; instance-settings message) are independently sized and not on the v1 critical path.

### Diseño

# Offboarding & Return Act — design spec

## 1. Intent & reframing

Today `/users/[id]` ends in a minimal `AlertDialog` (`DeleteConfirmDialog`) with one destructive button and a sentence. That is the wrong altitude for what is, in a real IT shop, a **ceremony**: a person is leaving, hardware must physically come back, and access must be cut. The CEO wants life and "moments" — offboarding is the single highest-stakes, most human moment in the app, so it earns a real surface, not an alert.

We reframe "Delete user" → **"Offboard … & Return Act"** ("acta de baja/devolución"): a panel that (a) shows exactly what the person holds, (b) carries a configurable message, (c) prints to a clean sheet the employee SIGNS declaring they returned everything, and (d) executes the (already transactional) offboard.

This is **mostly frontend**. The backend already does the hard part.

## 2. What the backend already gives us (verified)

- `DELETE /users/:id` **and** `POST /users/:id/offboard` are identical: in ONE transaction they soft-delete the user, revoke every active access grant, release every active asset assignment (+ RELEASED history), and stamp `deletedAt`. Last-admin guard (409). (`apps/api/src/users/users.service.ts:401`, controller `:295`/`:322`.)
- Both return an **OffboardResult**: `{ userId, releasedAssignments: [{ id, assetId }], revokedGrants: number }` — the post-action receipt.
- Pre-action data for the act is already fetchable on the page:
  - `useUserAssignments(id, true)` → active assignments = **assets to RETURN**.
  - `useUserGrants(id, true)` → active grants = **access being REVOKED** (carries `accessLevel`, `expiresAt`).
- The page already resolves bare FK ids to labels client-side via `useAssets({limit:MAX})` (`asset.name`) and `useApplications()` (`app.name`).

## 3. The two backend gaps (be honest)

**Gap A — asset detail for the return checklist.** `getUserAssignments` rows are bare (`assetId` only), and the assets catalog read only gives us `name`. The printed return act wants **tag / serial / model / category** per asset (that's the whole point of a return checklist — the receiver ticks off serial numbers). The asset catalog *does* carry those fields, so v1 can resolve them from `useAssets({limit:MAX})` client-side (we already load it). That's acceptable for ≤200 assets but is a full-catalog fetch. The clean fix is a purpose-built read:
> **`GET /users/:id/offboarding` → offboarding manifest**: `{ user, assignments: [{ id, asset: { tag, serial, model, category } }], grants: [{ id, application: { name, criticality }, accessLevel, expiresAt }], articlesAuthored: n }`. One read, expanded, no client-side join, no full-catalog fetch. This is already listed as an opportunity in the data-surface mapping ("offboarding manifest endpoint").

**Gap B — the configurable message + letterhead.** The brief asks for a message "persisted in instance settings vs edited inline." **Instance settings are read-only today** — `Settings → Instance` renders `GET /config/status`; posture is set via env (ADR-0043). There is **no writable instance-settings store** and adding one is a data-model decision (new table/migration + ADR), which per CLAUDE.md must go to the user, not be assumed. So:
- **v1 (frontend-only):** the message is an **inline-editable textarea** on the Sheet, seeded with a sensible default template, persisted to `localStorage` (per-instance, per-browser). Letterhead = the org name from the existing config + date. Ships with zero backend work.
- **Follow-up (backend):** an `InstanceSettings` row with `offboardingMessage` (text) + optional `letterhead`/`orgName`, writable by `settings:manage`, surfaced in `Settings → Instance`. Then the Sheet reads the org default and still allows a per-act inline override. **Flag for CEO.**

No motion library is needed — all motion is `tw-animate-css` / CSS keyframes, `prefers-reduced-motion` respected. No new deps for v1.

## 4. Architecture / files

```
apps/web/
  lib/api/
    endpoints/users.ts        + offboardUser(id) → POST /users/:id/offboard  (returns OffboardResult)
    hooks/use-user-mutations.ts + useOffboardUser() (invalidate userKeys.all; same as delete)
  app/(app)/users/[id]/
    page.tsx                   change: open <OffboardSheet> instead of <DeleteConfirmDialog>
    _components/
      offboard-sheet.tsx       NEW — the on-screen panel (the deliverable)
      offboard-return-act.tsx  NEW — the printable document (shared by Sheet preview + print route)
      use-offboard-message.ts  NEW — localStorage-backed editable message (v1)
    offboarding/act/page.tsx   NEW — dedicated print route (renders OffboardReturnAct, calls window.print)
  app/globals.css              + @media print rules (see §8) + 2 keyframes (slide-up-in, stagger)
packages/shared/src/schemas/user.ts  (follow-up) OffboardResultSchema if we want it typed on the wire
```

`DeleteConfirmDialog` stays as-is for every OTHER entity (locations, assets, KB, etc.) — we only swap the **user** path. No primitive is hand-edited; the Sheet composes `Sheet`, `Card`, `Button`, `StatusBadge`, `UserAvatar`, `Checkbox` (add via shadcn CLI if not vendored).

## 5. The on-screen Sheet — behavior

Right-side `Sheet` (`side="right"`, `sm:max-w-xl`), full height, scrollable body, sticky footer. Sections:

1. **Header** — `UserAvatar lg` + name + email + a `StatusBadge tone="warning"` "Offboarding". Tinted with a soft `--warning` ring so the panel itself signals weight (not a generic alert).
2. **Impact summary strip** — two big counts: *"N assets to return"* (teal, `--chart-2`) and *"M access grants to revoke"* (indigo, `--chart-1`), each with its pillar icon chip. These are the boldfaced impact counts the brief asks for.
3. **Assets to return** — list (active assignments). Each row: asset name, tag · serial · model · category (when the manifest/catalog provides them), a teal accent. Empty case: *"Holds no assets — nothing to return."*
4. **Access being revoked** — list (active grants). Each row: application name, `accessLevel` badge, expiry, indigo accent. `criticality=CRITICAL` grants get a `danger` dot. Empty case: *"No active access to revoke."*
5. **Message** — editable `<textarea>` seeded from the default template (employee/IT names + date interpolated), persisted to localStorage. A subtle "Edit message" affordance; "Reset to default" link.
6. **Signatures (on-screen preview)** — two labelled blank lines: *Employee signature* / *IT signature* — visual only on screen (real signing happens on paper).
7. **Footer (sticky)** — three actions, deliberately ordered to make **print-first** the natural path:
   - `Print return act` (outline, default focus) → opens print route in a new tab / triggers print.
   - `Confirm offboarding` (destructive) → fires `offboardUser`, shows pending spinner, on success toast + the user card does a gentle fade-out + redirect to `/users`. Stays open on error (same contract as `DeleteConfirmDialog`).
   - `Cancel` (ghost).

**Motion (tw-animate-css / CSS):** Sheet slides in (Radix already). The two lists stagger-fade their rows (`animate-in fade-in slide-in-from-bottom-1`, nth-child delay via a `[--i]` index). On successful confirm, the impact strip plays a brief success pulse, then redirect. All gated behind `motion-safe:` so `prefers-reduced-motion` users get instant render.

## 6. The four edge cases (explicitly handled)

- **Empty (nothing assigned, no grants):** both lists collapse to one calm line each; the act still prints (it's a clean "no property held / no access" record, which is itself worth signing). The impact strip reads "0 to return · 0 to revoke" and the confirm copy softens to "This person holds nothing — offboarding just disables the account."
- **Print-then-delete (RECOMMENDED, default path):** print the act → employee physically signs → you click **Confirm offboarding**. The printed sheet is a *pre-offboard return act* (footer caption: "Pending — to be confirmed in lazyit after signing").
- **Delete-then-print (receipt path):** if confirmed first, the success toast offers **"Print receipt"**; the print route then renders from the `OffboardResult` (released assignment ids + revoked count) and the caption flips to "Completed — offboarded on {date}". Because the user is now soft-deleted, the print route reads the snapshot it was handed rather than re-fetching live (the live reads would now be empty).
- **Print WITHOUT deleting:** fully supported — `Print return act` never mutates. You can hand someone the checklist days before their last day. The act is a document, not a side effect.

## 7. The print route / document

`/users/[id]/offboarding/act` is a thin client route that renders `OffboardReturnAct` and (optionally, via a `?print=1` query) calls `window.print()` on mount. It uses the **same** `OffboardReturnAct` component the Sheet previews, so on-screen and on-paper never drift. The document is print-CSS-only — no app chrome (sidebar/topbar hidden via `print:hidden` on the shell + a dedicated `@media print` block). Single-sheet target.

Document structure: letterhead (org name + lazyit mark + generated date) → title "Asset Return & Access Offboarding — Acta de baja/devolución" → person block → **return checklist with real checkboxes** (☐ per asset: tag · serial · model — the IT receiver ticks each as it comes back) → access-revoked list → the configurable message → two signature blocks (Employee: name, signature line, date; IT: name, signature line, date) → status caption (Pending vs Completed).

## 8. Token & CSS work (the "evolution" payload)

Adds to `apps/web/app/globals.css`, no token redefinition:
- **Two keyframes** under `@layer utilities`: `slide-up-in` (opacity+translateY) and a staggered list reveal driven by `--i`. Both wrapped so `@media (prefers-reduced-motion: reduce)` disables them.
- **A `@media print` block:** `.print\:hidden { display:none }` on chrome; force `--background`/`--foreground` to plain print-safe values; expand the act to full width; checkboxes render as outlined squares; signature lines as bottom borders; page margins for a single A4/Letter sheet.
- **Activate categorical hues:** the assets list uses `text-chart-2`/`bg-chart-2/10` chips, the access list `text-chart-1`/`bg-chart-1/10`. These consume the already-defined `--chart-*` tokens (today 95% unused) — exactly the dormant system the CEO wants switched on, scoped to one high-value screen first.

All AA-safe: status pills stay solid (`StatusBadge`), categorical hues are used as low-opacity chip backgrounds + token-strength text, never as text-on-tint that would fail contrast.

## 9. Effort & sequencing

1. FE-only v1 (no backend): offboard endpoint+hook wrapper, OffboardSheet, OffboardReturnAct, print route, localStorage message, globals.css print+motion. Resolves asset tag/serial/model/category from the existing `useAssets` catalog read.
2. Backend follow-up #1 (small): `GET /users/:id/offboarding` manifest → drop the full-catalog fetch, get clean expanded fields.
3. Backend follow-up #2 (needs ADR + CEO): writable `InstanceSettings.offboardingMessage` + letterhead → org-level default message.

### Mockup

```text
=== ON-SCREEN: Offboarding Sheet (right panel over /users/[id]) ===

                                          ┌───────────────────────────────────────────────┐
                                          │  ◀ warm --warning ring on the whole sheet      │
                                          │ ┌───┐                                          │
                                          │ │ AL│  Ada Lovelace            [⚠ Offboarding] │
                                          │ └───┘  ada@acme.io                             │
                                          │                                                │
                                          │  ┌─────────────────┐ ┌─────────────────┐       │
                                          │  │ ▣ 3             │ │ 🔑 2            │  ← impact strip
                                          │  │ assets to return│ │ grants to revoke│   (teal / indigo)
                                          │  │   (teal chart-2)│ │  (indigo chart-1)       │
                                          │  └─────────────────┘ └─────────────────┘       │
                                          │                                                │
                                          │  ASSETS TO RETURN                  ▣ teal       │
                                          │  ┌────────────────────────────────────────┐    │
                                          │  │ MacBook Pro 14"                         │    │
                                          │  │ LZ-0421 · C02X  · MBP14 · Laptop        │    │ ← rows stagger-fade in
                                          │  ├────────────────────────────────────────┤    │
                                          │  │ Dell U2723QE                            │    │
                                          │  │ LZ-0512 · CN-08 · U27   · Monitor       │    │
                                          │  ├────────────────────────────────────────┤    │
                                          │  │ YubiKey 5C                              │    │
                                          │  │ LZ-0588 · —     · YK5C  · Security key  │    │
                                          │  └────────────────────────────────────────┘    │
                                          │                                                │
                                          │  ACCESS BEING REVOKED              🔑 indigo    │
                                          │  ┌────────────────────────────────────────┐    │
                                          │  │ AWS Console          [admin]  ● critical│    │
                                          │  │ Okta                 [member]           │    │
                                          │  └────────────────────────────────────────┘    │
                                          │                                                │
                                          │  MESSAGE                       [Edit] [Reset]   │
                                          │  ┌────────────────────────────────────────┐    │
                                          │  │ I, Ada Lovelace, confirm I have         │    │
                                          │  │ returned all listed equipment in good   │    │
                                          │  │ condition and understand my access has  │    │
                                          │  │ been revoked as of 2026-06-03.          │    │
                                          │  └────────────────────────────────────────┘    │
                                          │                                                │
                                          │  Employee ________________   IT _____________  │  ← preview only
                                          │                                                │
                                          │ ┌────────────────────────────────────────────┐ │
                                          │ │ [🖨 Print return act]  [Confirm offboarding]│ │ ← sticky footer
                                          │ │                              [Cancel]       │ │   (print-first)
                                          │ └────────────────────────────────────────────┘ │
                                          └───────────────────────────────────────────────┘

EMPTY CASE (nothing held):
   ASSETS TO RETURN   → "Holds no assets — nothing to return."
   ACCESS BEING REVOKED → "No active access to revoke."
   Confirm copy → "Ada holds nothing — offboarding just disables the account."


=== PRINTED SHEET: /users/[id]/offboarding/act  (single page, no app chrome) ===

  ┌──────────────────────────────────────────────────────────────────────────┐
  │  ████ ACME CORP  ·  IT Department          Generated: 2026-06-03          │  ← letterhead + date
  │  ──────────────────────────────────────────────────────────────────────  │
  │                                                                          │
  │        ASSET RETURN & ACCESS OFFBOARDING                                 │
  │        Acta de baja / devolución                                        │
  │                                                                          │
  │  Employee:  Ada Lovelace        Email: ada@acme.io                       │
  │  Role:      Member              Offboarding date: 2026-06-03             │
  │  ──────────────────────────────────────────────────────────────────────  │
  │                                                                          │
  │  1. EQUIPMENT TO BE RETURNED   (IT ticks each item as received)          │
  │                                                                          │
  │   ☐  MacBook Pro 14"     Tag LZ-0421   S/N C02XL...   Model MBP14        │
  │   ☐  Dell U2723QE        Tag LZ-0512   S/N CN-08...   Model U2723QE      │
  │   ☐  YubiKey 5C          Tag LZ-0588   S/N —          Model YK5C         │
  │                                                                          │
  │  2. APPLICATION ACCESS REVOKED                                          │
  │                                                                          │
  │   •  AWS Console   (admin)   — CRITICAL                                  │
  │   •  Okta          (member)                                             │
  │                                                                          │
  │  3. DECLARATION                                                         │
  │   I, Ada Lovelace, confirm I have returned all listed equipment in      │
  │   good condition and understand my access has been revoked as of        │
  │   2026-06-03.                                                           │
  │                                                                          │
  │  ──────────────────────────────────────────────────────────────────────  │
  │   Employee signature                    IT representative signature      │
  │                                                                          │
  │   ______________________                ______________________          │
  │   Ada Lovelace                          ____________________ (name)      │
  │   Date: ____ / ____ / ______            Date: ____ / ____ / ______       │
  │                                                                          │
  │   Status: ☐ PENDING — confirm in lazyit after signing                   │  ← flips to
  │           (receipt mode: "✔ COMPLETED — offboarded 2026-06-03")          │     COMPLETED post-confirm
  └──────────────────────────────────────────────────────────────────────────┘
```

### Deuda de backend

Two real gaps; v1 ships without either.

GAP A (small, recommended) — expanded offboarding read. getUserAssignments returns bare rows (assetId only) and the assets catalog gives only `name`; the return checklist wants tag/serial/model/category per asset. v1 resolves these client-side from the already-loaded useAssets({limit:MAX}) catalog (works for <=200 assets, but is a full-catalog fetch). Proper fix = a purpose-built read GET /users/:id/offboarding returning the manifest: { user, assignments:[{id, asset:{tag,serial,model,category}}], grants:[{id, application:{name,criticality}, accessLevel, expiresAt}], articlesAuthored }. Already listed as a data-surface opportunity. No write/contract change to existing endpoints; pure additive read. Front consumer must not merge ahead of it (Page-envelope/unwrap lesson) — but since v1 doesn't depend on it, no sequencing risk.

GAP B (needs ADR + CEO decision) — writable instance settings for the configurable message + letterhead. Instance config is ENV-ONLY and read-only today (Settings→Instance renders GET /config/status; ADR-0043). There is NO instance-settings table/field to persist a custom offboarding message or org letterhead. Adding one is a data-model change (new InstanceSettings row + migration + ADR + a settings:manage-gated write endpoint) and per CLAUDE.md must be a CEO decision, not assumed. v1 sidesteps it: message is inline-editable, persisted to localStorage (per-browser). Follow-up wires InstanceSettings.offboardingMessage (+ orgName/letterhead) as the org-level default.

The offboard ACTION itself needs ZERO backend work: POST /users/:id/offboard (and DELETE /users/:id) already soft-delete + revoke grants + release assignments transactionally and return the OffboardResult receipt. Frontend only needs a thin offboardUser() endpoint wrapper + useOffboardUser() hook (mirrors useDeleteUser, same cache invalidation). Optionally type OffboardResult in @lazyit/shared.

No new npm dependencies for v1: motion via tw-animate-css + CSS keyframes (no framer-motion), print via @media print + window.print(). May need to vendor shadcn `checkbox` via the CLI if not already present (do NOT hand-write it).

### Decisiones para el CEO
- MESSAGE PERSISTENCE: ship v1 with an inline-editable message saved to the browser (localStorage), OR wait for a proper org-level InstanceSettings.offboardingMessage field (new table + migration + ADR + settings UI)? Recommendation: localStorage now, instance-settings as a fast follow.
- DOCUMENT NAME / BILINGUAL: title the printed sheet 'Asset Return & Access Offboarding' with the Spanish 'Acta de baja/devolución' as subtitle? Confirm whether the product is English-only (CLAUDE.md says English everywhere) — if so we keep the Spanish only as a familiar subtitle, or drop it.
- LETTERHEAD SOURCE: there is no stored org name/logo today. v1 uses a plain text org name (typed once, localStorage) + date. Do you want a real org-name/logo field in InstanceSettings (backend follow-up), or is a typed name fine for now?
- DEFAULT FLOW: make PRINT-THEN-CONFIRM the default (employee signs paper, then you confirm in-app) vs confirm-then-print-receipt? Recommendation: print-first default, with a 'Print receipt' offered after confirm too.
- ASSET FIELDS ON THE ACT: confirm tag + serial + model + category is the right return-checklist column set (vs just tag + name). This drives whether we add the GET /users/:id/offboarding manifest endpoint.
- SCOPE OF THE NEW SHEET: replace the delete experience ONLY for users (keep the lean DeleteConfirmDialog for locations/assets/KB/etc.), correct? The offboarding ceremony is user-specific.
- SIGNATURE/RECORD KEEPING: is a printed-and-physically-signed paper sufficient (no digital signature, no stored PDF), or do you eventually want the signed act archived against the user record? v1 is paper-only; storing a PDF/audit artifact is a larger backend feature.

---

## Dashboard 2-col: slim activity feed + a "Pulse" right rail (status donut + expiring-access + KPI deltas)

Evolve the dashboard from a vertical stack (Needs attention -> 4 pillar cards -> full-width activity) into a two-column "command surface": a NARROWER, denser Recent Activity feed (~60%, lg:col-span-3) beside a sticky right rail "Pulse" (~40%, lg:col-span-2) that stacks on mobile. The 4 pillar cards and Needs Attention stay above, but gain pillar-color identity (activating the dead --chart-1..5 tokens) and a hover lift. The right rail is composed of three token-driven, AA-safe widgets - ALL buildable from the EXISTING GET /dashboard/summary with ZERO backend work: (1) an Assets-by-status donut (pure CSS conic-gradient, no charts lib) that doubles as a deep-linked legend; (2) an "Expiring & critical access" mini-panel (counts + deep-links, the honest version given the contract); (3) KPI tiles. I recommend the donut + access panel + a relocated "all clear / quick actions" tile. Sparklines/deltas and a true expiring-grants timeline are flagged as backend debt (no time-series or per-grant data in the contract) and listed as explicit CEO decisions. Feed rows become more compact (single-line summary, inline actor chip, tighter rhythm) with a date-group header treatment and a CSS fade-in-up on load. No new dependencies: CSS conic-gradient + tw-animate-css only.

**Esfuerzo:** Medium. Frontend-only for the recommended scope. ~1 new rail container + 3 rail widget components (donut, access-health, all-clear/actions), a refactor of recent-activity-panel.tsx (date grouping + density + token tints) and dashboard/page.tsx (2-col grid + pillar color prop on PillarCard + token-ize Needs Attention tones), plus ~2 additive token/keyframe blocks in globals.css. No backend, no new dependencies, no shared-schema change. Roughly 1.5–2.5 days incl. AA verification across both themes. The deferred extras (deltas/sparklines/expiring timeline) are a separate, larger backend+frontend epic.

### Diseño

# Dashboard redesign — slim activity + "Pulse" right rail

## 1. Intent & framing

The CEO wants *onda* without abandoning the calm, disciplined warm-neutral system (ADR-0011). This redesign delivers vibe through **layout tension** (a focused feed beside a glanceable rail), **activating the dormant categorical palette** (per-pillar `--chart-*` color that today is 95% unused), **light data-viz** (one CSS donut — no charts lib), **elevation** (hover lift + a real shadow scale), and **one motion signature** (staggered fade-in-up on load). Everything stays token-driven and AA-safe. This is evolution: the pillar cards, Needs Attention, the activity feed, and every primitive survive — they get color, depth, and rhythm.

## 2. New page structure (top → bottom)

```
PageHeader (unchanged: title + Updated stamp + Refresh)
QuickActions row (ADMIN, unchanged)
┌──────────────────────────────────────────────────────────┐
│ Needs Attention  (full width, evolved: throb dot, tones)  │
├──────────────────────────────────────────────────────────┤
│ 4 Pillar cards   (full width grid, evolved: pillar color, │
│                   hover lift, depth)                      │
├───────────────────────────────┬──────────────────────────┤
│ Recent Activity  (lg:col-3/5) │  PULSE rail (lg:col-2/5)  │
│  slim, dense, date-grouped    │   sticky on lg+           │
│                               │   • Assets donut          │
│                               │   • Expiring & critical   │
│                               │   • All-clear / actions   │
└───────────────────────────────┴──────────────────────────┘
```

Grid: `grid grid-cols-1 lg:grid-cols-5 gap-6`. Feed = `lg:col-span-3`, rail = `lg:col-span-2`. Rail wrapper gets `lg:sticky lg:top-6 self-start` so it parks while the feed scrolls. Below `lg`, the rail drops **below** the feed (activity is the priority on mobile).

> Decision point: keep Needs Attention + pillar cards **full-width above** the split (recommended — they're the at-a-glance layer), OR move Needs Attention **into** the rail to shorten the page. Recommending full-width above; see CEO decisions.

## 3. The right rail — "Pulse" (RECOMMENDED composition)

Three stacked Cards. Every number below is **already in `GET /dashboard/summary`** — zero backend work.

### 3a. Widget A — Assets by status (CSS donut) — RECOMMENDED, the signature moment
A pure-CSS `conic-gradient` ring (no charts lib, no SVG library) over `assets.byStatus`, with the **total** centered in the hole, and a deep-linked legend beside/below it. Each status maps to a **status token** (not raw palette), reusing the exact tone map already in `asset-status-badge.tsx`:

- OPERATIONAL → `--success` · IN_MAINTENANCE → `--warning` · IN_STORAGE → `--info` · RETIRED/UNKNOWN → `--muted-foreground` · LOST → `--destructive`.

Build: compute cumulative percentages, emit one `conic-gradient(var(--success) 0 62%, var(--warning) 62% 74%, …)` into an inline `style`. Ring = a `size-32 rounded-full` div with the gradient, masked to a ring via an inner `bg-card size-20 rounded-full` (donut hole) holding `assets.total` + "assets". Legend rows are `<Link>` to `/assets?status=X` (same deep-links the pillar card already uses), each with a token-colored `StatusDot` + label + tabular count. On `prefers-reduced-motion` no animation; otherwise a subtle `animate-in fade-in` on mount.

Why it wins: it's the most *alive* element (color + shape), it's genuinely useful (status mix at a glance), it reuses the existing tone contract and deep-links, and it costs nothing on the backend.

### 3b. Widget B — Expiring & critical access (the HONEST version)
A small Card titled "Access health" with two emphasis rows from `summary.access`:
- `expiringSoon` grants "expiring ≤ {expiringWithinDays}d" — `--warning` accent, `KeyIcon` chip, deep-links to `/applications`.
- `onCriticalApps` grants "on critical apps" — `--info` (or `--chart-1` indigo) accent, deep-links to `/applications?criticality=CRITICAL`.

Each row: token-tinted icon chip + bold tabular count + label + `ArrowRightIcon`. When a count is 0, render it muted ("0 — all current"), not hidden, so the panel has a stable shape.

> This is a **count panel, not a timeline**, because the contract exposes only aggregate counts — there are no per-grant `expiresAt` rows in `DashboardSummary`. A true "expiring access calendar/timeline" is **backend debt** (see §6). I deliberately did NOT mock a fake timeline.

### 3c. Widget C — All-clear / Quick actions tile
Bottom of the rail, a compact Card that adapts:
- If `NeedsAttention` is empty → a delightful **all-clear** state: a `CheckCircleIcon` scaled-up on a `--success`-tinted circle, "All clear" headline, subtext. This is the "delightful moment" the CEO wants for the happy path.
- Else (or always, for ADMINs) → the relocated **Quick actions** as full-width rail buttons (New asset / Add stock / Grant access), giving the rail a practical "do something" footer.

### Right-rail options I considered (and why B/A/C won)
| Option | Backend cost | Verdict |
|---|---|---|
| **Assets-by-status donut** | none | ✅ recommended — signature, useful, free |
| **Expiring-access count panel** | none | ✅ recommended — honest within contract |
| **KPI tiles with deltas (+3 this week)** | NEW (no time-series in contract) | ⚠️ deferred — needs `/dashboard/summary/stats` |
| **Stock-trend sparkline** | NEW (no time-series) | ⚠️ deferred — same |
| **Expiring-access timeline/calendar** | NEW (no per-grant expiry in summary) | ⚠️ deferred — needs grant rows |
| **Relocated Needs Attention** | none | possible alt to Widget C |

## 4. Slimmer activity feed

Recompose `recent-activity-panel.tsx` (the Card shell, hook, states all stay) for density in the narrower column:
- **Compact rows**: single-line clamped `summary` (`line-clamp-1`), relative time pinned right (already there), actor as a `size-sm` avatar chip + name on the same baseline — drop the second line where it fits, keep the timeline spine but tighten `pb-5 → pb-4`.
- **Date-group headers**: insert sticky-ish subtle `text-xs uppercase tracking-wide text-muted-foreground` separators — "Today", "Yesterday", "Earlier" — bucketed client-side from `occurredAt` against the snapshotted `now`. Pure presentation, no new data.
- **Pillar color via tokens**: replace the hardcoded `bg-sky-500/10 text-sky-600 dark:…` / violet / amber `ENTITY_TONE` map with token-backed tints: asset → `--chart-1` (indigo, the Inventory identity), application → `--chart-2` (teal, Access), consumable → `--chart-4` (amber). This kills three hardcoded dark: variants and finally consumes the categorical tokens. (Tints via `[background:color-mix(in_oklch,var(--chart-1)_12%,transparent)]` + `text-[var(--chart-1)]`, AA-checked.)
- **Motion**: on first paint, rows `animate-in fade-in slide-in-from-bottom-1` with an `nth-child` stagger delay (CSS only, `@layer utilities`); guarded by `motion-reduce:animate-none`.
- **Load more** unchanged.

## 5. Pillar cards + Needs Attention (evolution, kept full-width)
- **Pillar identity color**: each pillar card's icon chip + a thin top accent take their `--chart-*` hue instead of the uniform `bg-primary/10 text-primary`. Map: Assets=`--chart-1` indigo, Access=`--chart-2` teal, Knowledge=`--chart-3` green, Consumables=`--chart-4` amber. (Pass a `pillar` prop → token class.)
- **Depth**: cards gain `transition-shadow hover:shadow-md` + `hover:-translate-y-0.5` (a new `--shadow` step) and `ring-foreground/10 → hover:ring-foreground/15`. `motion-reduce:transition-none`.
- **Needs Attention dot**: the danger/warning dot gets a gentle `animate-pulse`-style throb (custom slow keyframe, opacity 1→0.6, `motion-reduce` off) — draws the eye without alarm. Tones move to `--warning`/`--destructive` tokens (drop raw `amber-500`/`rose-500`).

## 6. Backend debt (be honest)
- **Available now (no work):** the donut, the access count panel, all pillar counts, all deep-links, date-grouping, all-clear state. The redesign is **fully buildable today**.
- **Needed for the "wow" extras the CEO's brief hints at:**
  - *Deltas / "+3 this week"*: requires a new `GET /dashboard/summary/stats?range=` returning created/assigned/granted/… counts per window. Not in contract → ADR + shared schema change.
  - *Sparklines / stock trend*: same — needs a time-bucketed series endpoint.
  - *True expiring-access timeline/calendar*: needs per-grant `{ grantee, app, expiresAt }` rows (e.g. extend summary with a small `access.expiringList[]` or a `GET /dashboard/access/expiring`). Not in contract.
- The shared `DashboardSummary` schema is **locked** (no mutation without ADR discussion, per the data-contract rule) — so all three extras are explicit, ADR-gated decisions, not silent additions.

## 7. Token & a11y discipline
- New `--shadow-card` / `--shadow-pop` pairs in `globals.css` (light + dark) for the elevation scale — additive, no token removed.
- Donut + tints use `color-mix(in oklch, var(--token) X%, …)` so they stay token-derived and theme-correct; foreground/label contrast verified AA on bone + dark.
- All motion behind `motion-reduce:*`; donut and feed degrade to static.
- Icons: `@heroicons` only (`CheckCircleIcon`, `KeyIcon`, existing pillar icons) — no new weight.
- No charts lib, no motion lib, no i18n lib added.

### Mockup

## Desktop (≥ lg) — the new dashboard

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ Dashboard                                          Updated 2m ago  [⟳ Refresh]   │
│ Your IT estate at a glance — Inventory, Access and Knowledge.                     │
│ [+ New asset] [+ Add stock] [+ Grant access]                                     │
├────────────────────────────────────────────────────────────────────────────────┤
│ NEEDS ATTENTION                                                                  │
│ ┌───────────────────────────────┐  ┌───────────────────────────────┐            │
│ │ ⬤(amber throb) 3 grants exp…→ │  │ ⬤(rose throb) 1 asset lost  → │            │
│ └───────────────────────────────┘  └───────────────────────────────┘            │
├────────────────────────────────────────────────────────────────────────────────┤
│ ┌─[indigo]──────┐ ┌─[teal]────────┐ ┌─[green]───────┐ ┌─[amber]───────┐          │
│ │ ▦ Assets      │ │ ⚷ Access      │ │ ▤ Knowledge   │ │ ◳ Consumables │   ↑hover │
│ │ 142 assets    │ │ 37 grants     │ │ 88 articles   │ │ 24 items      │   lift   │
│ │ Operational118│ │ Critical    4 │ │ Published  71 │ │ Low stock   2 │          │
│ │ Maint.      6 │ │ Expiring≤30 3 │ │ Drafts     17 │ │               │          │
│ │ Browse →      │ │ Manage →      │ │ Open KB →     │ │ Browse →      │          │
│ └───────────────┘ └───────────────┘ └───────────────┘ └───────────────┘          │
├──────────────────────────────────────────┬─────────────────────────────────────┤
│ RECENT ACTIVITY (col-span-3)             │ PULSE  (col-span-2, sticky)         │
│ ┌──────────────────────────────────────┐ │ ┌─────────────────────────────────┐ │
│ │ Across the estate · newest first     │ │ │ Assets by status                │ │
│ │                                      │ │ │                                 │ │
│ │ ── TODAY ──────────────────────────  │ │ │        ╭──────────╮             │ │
│ │ ●(indigo) Asset “MBP-14” assigned    │ │ │      ╭─┤   142    ├─╮  ← conic   │ │
│ │   to J. Minatel              2m ago  │ │ │      │ │  assets  │ │   gradient │ │
│ │   ⬤JM  Joaquin Minatel               │ │ │      ╰─┤          ├─╯   donut    │ │
│ │ ●(teal)  Grant on “GitHub” revoked   │ │ │        ╰──────────╯             │ │
│ │   from A. Pérez              18m ago │ │ │  ⬤ Operational ……………… 118  →    │ │
│ │   ⬤AP  Ada Pérez                     │ │ │  ⬤ In maintenance ……………  6  →   │ │
│ │ ── YESTERDAY ──────────────────────  │ │ │  ⬤ In storage …………………… 12  →    │ │
│ │ ●(amber) Stock “USB-C” −5 (consumed) │ │ │  ⬤ Retired ………………………………  4  →   │ │
│ │   ⬤SY  System              1d ago    │ │ │  ⬤ Lost ……………………………………  1  →   │ │
│ │ ●(indigo) Asset “Dell-22” retired    │ │ └─────────────────────────────────┘ │
│ │   ⬤MK  Mara K.             1d ago    │ │ ┌─────────────────────────────────┐ │
│ │ ── EARLIER ────────────────────────  │ │ │ Access health                   │ │
│ │ ●(teal)  Grant on “AWS” granted …    │ │ │ ⚷(amber) 3  Expiring ≤ 30d   →  │ │
│ │                                      │ │ │ ⚷(indigo)4  On critical apps →  │ │
│ │            [ Load more ]             │ │ └─────────────────────────────────┘ │
│ └──────────────────────────────────────┘ │ ┌─────────────────────────────────┐ │
│                                          │ │   ✓  (success circle, scaled)   │ │
│                                          │ │   All clear                     │ │
│                                          │ │   Nothing else needs you today. │ │
│                                          │ └─────────────────────────────────┘ │
└──────────────────────────────────────────┴─────────────────────────────────────┘
```

## Mobile (< lg) — rail drops below the feed

```
┌───────────────────────────┐
│ Dashboard   Updated 2m  ⟳ │
│ [+ New asset] [+ Add stock]│
├───────────────────────────┤
│ NEEDS ATTENTION           │
│ ┌───────────────────────┐ │
│ │ ⬤ 3 grants expiring → │ │
│ └───────────────────────┘ │
├───────────────────────────┤
│ ┌─[indigo]─┐ ┌─[teal]───┐ │  (pillar cards: 1-col / 2-col)
│ │ Assets142│ │ Access 37│ │
│ └──────────┘ └──────────┘ │
│ ┌─[green]──┐ ┌─[amber]──┐ │
│ │ KB     88│ │ Cons.  24│ │
│ └──────────┘ └──────────┘ │
├───────────────────────────┤
│ RECENT ACTIVITY           │
│ ── TODAY ───────────────  │
│ ●(indigo) MBP-14 assigned │
│   ⬤JM Joaquin · 2m        │
│ ●(teal) GitHub revoked    │
│   ⬤AP Ada · 18m           │
│        [ Load more ]      │
├───────────────────────────┤
│ PULSE                     │
│ Assets by status  ◔ donut │
│  ⬤ Operational  118  →    │
│  …                        │
│ Access health             │
│  ⚷ 3 Expiring ≤30d  →     │
│ ✓ All clear               │
└───────────────────────────┘
```

## Donut build sketch (CSS only, no lib)

```tsx
// cumulative % over assets.byStatus → one conic-gradient
const ring = `conic-gradient(
  var(--success)      0      62%,   /* operational */
  var(--warning)      62%    65%,   /* maintenance */
  var(--info)         65%    73%,   /* storage */
  var(--muted-foreground) 73% 76%,  /* retired+unknown */
  var(--destructive)  76%   100%    /* lost */
)`;
// <div className="relative size-32 rounded-full" style={{ background: ring }}>
//   <div className="absolute inset-4 grid place-items-center rounded-full bg-card">
//     <span className="text-2xl font-semibold tabular-nums">{assets.total}</span>
//   </div>
// </div>
```

### Deuda de backend

The recommended design (slim feed + donut + access count panel + all-clear/quick-actions tile + pillar color) is FULLY buildable today with ZERO backend changes — every number comes from the existing `GET /dashboard/summary` (`assets.byStatus`/`total`/`assigned`, `access.activeGrants`/`expiringSoon`/`expiringWithinDays`/`onCriticalApps`, `consumables.total`/`lowStock`, `articles.*`) and the existing paginated `GET /dashboard/activity`. Deep-links reuse URL filters the lists already read.

Backend debt is ONLY for the "extra spark" features hinted in the brief, each ADR-gated because `DashboardSummary` is a locked shared contract:
1. KPI deltas / "+N this week": no time-series in the contract. Needs a new `GET /dashboard/summary/stats?range=` returning per-window event counts (created/assigned/released/granted/revoked/stock_in/stock_out). New shared schema + ADR.
2. Sparklines / stock trend: same root cause — needs a time-bucketed series endpoint.
3. True "expiring access" timeline/calendar (per-grant rows, not just a count): needs per-grant `{ grantee, application, expiresAt }` data on the dashboard — e.g. extend summary with `access.expiringList[]` or add `GET /dashboard/access/expiring`. Not in the contract today; I deliberately designed a count panel instead of faking a timeline.
Until those land, the rail ships honestly on counts.

### Decisiones para el CEO
- Right-rail composition: confirm the recommended trio — Assets-by-status donut + Access-health count panel + All-clear/Quick-actions tile. Alternative is swapping the third tile for relocated Needs Attention (shorter page, but loses the happy-path 'all clear' moment).
- Should I build the EXTRAS now or defer? Deltas ('+3 this week'), sparklines, and a real expiring-access timeline ALL require new backend endpoints + ADRs (the DashboardSummary contract is locked). Recommend: ship the zero-backend version first, open a follow-up issue for a `/dashboard/summary/stats` time-series endpoint.
- Layout: keep Needs Attention + the 4 pillar cards FULL-WIDTH above the feed/rail split (recommended), or fold Needs Attention into the right rail to shorten the page?
- Data-viz primitive: approve a pure-CSS conic-gradient donut (no new dependency) for the assets-by-status ring. If you'd prefer richer charts later (multi-series, sparklines, tooltips), that's a separate 'add a charts lib' decision (recharts/visx) with its own ADR.
- Pillar color identity: confirm the per-pillar hue mapping that activates the dormant --chart tokens — Assets=indigo(chart-1), Access=teal(chart-2), Knowledge=green(chart-3), Consumables=amber(chart-4). This also recolors the activity feed pillar icons (replacing hardcoded sky/violet/amber). Avatar palette stays canonical/unchanged.
- Motion intensity: approve the one signature (staggered fade-in-up on feed rows + hover lift on pillar cards + slow throb on attention dots), all behind prefers-reduced-motion. Say if you want it more energetic or more restrained.

---

## Informes — a unified, filterable "history of everything" section (evolution-grade, honest about backend debt)

A new top-level "Informes / Reports" section that turns the dashboard's read-only activity stream into a first-class, filterable audit surface: a hybrid table+timeline of EVERYTHING across the estate, with filters for entity type, specific entity, actor, action, date range and free-text, plus "My history", CSV export and print. The frontend ships on the contract that already exists today (GET /dashboard/activity, an offset-paginated Page<RecentActivityItem> over the recent_activity view) and is built entirely by composing locked chrome (PageHeader, SearchInput, ResourceTable, Select, StatusBadge, Avatar) — no new deps, AA-safe, prefers-reduced-motion-respecting. The categorical hues finally get activated here: each pillar/action gets a token-driven chip (--chart-1..5 / --success/--warning/--info), so Informes doubles as the proof-of-concept for the "activate the color system" mandate. HONESTLY: the rich version (filter by actor, by single entity across all 4 sources, by action, by date range; plus Users & Categories history and "My history") requires backend work the CEO has accepted as DEBT — the recent_activity view today exposes no filter params and audits neither users nor categories. The spec ships a real, useful v1 on day one (client-side filtering of the loaded feed + entity-type tabs the view CAN already do, plus per-asset history reuse) and stages the backend contract as a clean hand-off so the full vision lands without re-architecting the screen.

**Esfuerzo:** Frontend v1 (ships on the existing contract, no backend): ~M — 3–5 focused PRs (route+nav, color/token helpers + dashboard retrofit, tabs+filter bar, timeline+table views, CSV/print+states+motion). Each is a small sub-issue reusing locked primitives; no new dependency. Backend debt to reach the full vision: DEBT-1 (filter params on the activity endpoint + view WHERE clauses) ~S–M and high-value; DEBT-2 (UserHistory model + view UNION + emit on write paths + new ADR + contract widening) ~M and the largest single piece; DEBT-3 (category auditing) ~S, recommend defer; DEBT-4 (My history) ~XS, falls out of DEBT-1; DEBT-5 (server-side filtered CSV export) ~S, after DEBT-1. Net: a genuinely useful Informes lands at M effort; the complete \"history of everything incl. users/categories/my-history\" is M+M backend, ADR-gated, sequenced so the frontend never needs re-architecting.

### Diseño

# Informes — design spec

## 0. Intent & framing

The CEO wants "history of EVERYTHING with filters — assets, categories, users, and *my history*." The dashboard already surfaces a cross-pillar feed (`RecentActivityPanel` → `GET /dashboard/activity`); Informes is the **full-page, filterable, exportable** evolution of that feed. This is the natural home to **activate the dormant categorical color system** (`--chart-1..5`, `--success/--warning/--info`, `--avatar-*`) per the CEO's "más onda" mandate — color here is *semantic* (pillar + action identity), so it adds vibe without breaking AA or token discipline.

**Hard reality up front (no hand-waving):** the backend `recent_activity` view (ADR-0043) today:
- unifies only **3 entity types** — asset / application / consumable (NOT users, NOT categories);
- exposes **only `{ limit, offset }`** — no `entityType`, `actorId`, `entityId`, `action`, `from`, `to`, or `q` filter params;
- carries `actorId/actorName` per row but no server-side filter on them;
- has **no UserHistory / CategoryHistory** auditing at all.

So "filter by user", "filter by category", "all changes to ONE asset across all sources", "my history", and date-range filtering are **backend debt**. This spec is explicit about what ships v1 vs. what's gated on that debt, and hands off a precise contract (§7).

## 1. IA & nav placement

**Decision: top-level entry, not buried in Manage.** A "history of everything" is cross-pillar by definition — nesting it under Manage (which is Users/Locations/Settings) mislabels it as an admin registry. Add a dedicated section between **Knowledge** and **Manage**:

```
Dashboard
Inventory   → Assets, Consumables
Access      → Applications
Knowledge   → Knowledge Base
Reports     → Informes          ← NEW (heading "Reports", item "Informes")
Manage      → Users, Locations, Settings
```

- Route: **`/informes`** (English-everywhere convention says identifiers/routes are English; "Informes" is the *display label* the CEO used — but routes are English, so `/informes` as the slug is a CEO call. **Recommend `/reports` as the slug, "Informes" as the visible label** — see decisions.)
- Icon: `ClockIcon` (24/outline) — "history" reads more honestly than a chart icon for a log-centric view; reserve `ChartBarIcon` for a future KPI/analytics page. heroicons-only, satisfied.
- Add the section to the `NAV` array in `components/sidebar-nav.tsx` (and it mirrors automatically into `mobile-nav.tsx`, which renders the same `<SidebarNav />`).
- **Permission gate:** Informes shows estate-wide history → gate the nav item + route on a read permission. v1: gate on **`asset:read` OR any pillar read** (anyone who can see the lists can see their history). The actor-revealing columns are fine for an internal 5–20-person team; if the CEO wants Informes ADMIN-only, gate on `settings:manage` (a one-line `adminOnly`-style flag). **CEO decision (§ decisions).**

## 2. Sub-tabs (scope selector)

A single horizontal tab row scopes the feed. Tabs map to what the backend can/can't do:

| Tab | v1 (ships now) | Needs backend debt |
| --- | --- | --- |
| **All** | ✅ the whole `recent_activity` feed | — |
| **Assets** | ✅ client-filter `entityType=asset` on the loaded page; server param later | server `entityType` filter |
| **Access** | ✅ client-filter `entityType=application` | server `entityType` filter |
| **Stock** | ✅ client-filter `entityType=consumable` | server `entityType` filter |
| **Users** | 🚫 disabled w/ "Coming soon" tooltip | **UserHistory auditing (new)** |
| **My history** | 🚫 disabled w/ "Coming soon" tooltip | server `actorId` filter |

- Tabs render via the shadcn **Tabs** primitive (vendored; add via `shadcn` CLI if not present — `mcp__shadcn` confirms availability). Disabled tabs show a `16/solid` lock-ish affordance + tooltip "Available once history coverage lands" — **honest, not fake**.
- Each enabled tab gets a **pillar-tinted underline** using the categorical token: All → `--primary` (indigo), Assets → `--chart-1`, Access → `--chart-2` (teal), Stock → `--chart-4` (amber). This is the color-activation moment.

> **v1 caveat (be honest):** client-side `entityType` filtering only filters *rows already fetched* (page size 20). With server params (§7) the tab becomes a true server filter. v1 mitigates by bumping the Informes page size to the API max-friendly 50 and showing a "Filtering the loaded N events — load more to widen" hint when a client filter is active. This is a deliberate, disclosed v1 limitation, not a silent bug.

## 3. Filter UX

A filter bar under the tabs, same grammar as the list pages (`SearchInput` + `Select`s + `ActiveFilters` chips + `ClearFiltersLink`), so it feels native:

- **Free-text** (`SearchInput`): filters on the server-built `summary` + `actorName`. v1 = client-side `includes()` over loaded rows; server `q` later.
- **Action** (`Select`): created / assigned / released / granted / revoked / stock_in / stock_out / stock_adjustment / status_changed / location_changed. v1 = client filter on `item.action`; server `action` later. Each option carries its **semantic color dot** (created→info, assigned/granted→success, released/revoked→destructive, stock→amber/warning, status→primary).
- **Actor** (`Select` or combobox): 🚫 gated on backend `actorId` filter — render disabled with "Coming soon" until debt lands.
- **Entity** (free-text id, or a future combobox): "all changes to one asset" — v1 can deep-link from an asset detail's existing per-asset history; the *unified* single-entity filter is backend debt.
- **Date range**: 🚫 no date picker primitive vendored and no server `from`/`to` param. v1 ships a **relative quick-range Select** (Today / 7d / 30d / All) that filters *client-side* on `occurredAt`; a real range picker + server params is debt. (Adding a `Calendar`/`date-picker` via shadcn CLI is a small, in-bounds follow-up.)

Active filters render as removable chips (reuse `ActiveFilters`/`ClearFiltersLink`). All filter state lives in URL search params (matches the list-page `useListParams` pattern), so an Informes view is shareable/bookmarkable.

## 4. Result presentation — hybrid table + timeline

Offer **both**, toggled by a density switch (a 2-option segmented control, default = Timeline on mobile, Table on desktop):

- **Timeline** (default, the "vibe" view): evolves `RecentActivityPanel`'s row — pillar-tinted icon chip (now token-driven `--chart-*`, not hardcoded `sky/violet/amber`), server `summary`, actor avatar (`avatarColorFor(actorId)`), relative time, and an **action StatusBadge** (the dormant `--success/--warning/--info` tokens, finally used). Grouped by **date headers** ("Today / Yesterday / Earlier this week / Older") — the row's `occurredAt` drives grouping client-side.
- **Table** (the "audit" view): `ResourceTable` with columns **When · Action · Entity · Actor · Summary**. `When` is `tabular-nums` + sortable-looking (server sort is debt; v1 is newest-first only). `Action` = colored badge; `Entity` = pillar icon + linked id; `Actor` = mini avatar + name; `Summary` = the server sentence. Mobile → `ResourceCard` projection (same rows).

Pagination: reuse the activity feed's **"Load more"** (infinite query) for Timeline; the `Pagination` footer (offset, ADR-0030) for Table — both already exist.

**States** (reuse the shared components, evolved): loading → `ResourceTable` skeletons / `ActivitySkeleton`; error → `ErrorState` with `RequestIdNote` (ADR-0031); empty → an **upgraded `EmptyState`** — a `ClockIcon` in a `bg-muted` circle with a soft `tw-animate-css` fade-in-scale and copy "No events match these filters." This is one of the "delightful empty states" the mandate asks for.

## 5. Export & print

- **CSV export** (the realistic v1): a "Export CSV" button (`ArrowDownTrayIcon`) serializes the **currently-loaded, currently-filtered** rows client-side to a CSV (`occurredAt, action, entityType, entityId, actorName, summary`) via a Blob download — zero backend, zero deps. Honest label: "Export visible events". A true full-result server export (all pages, with filters) is **backend debt** (§7) and gets a separate "Export all (filtered)" once the filter endpoint exists.
- **Print**: a "Print" button calling `window.print()` plus a `@media print` block in `globals.css` (`@layer` utilities) that hides chrome (sidebar, filter bar, buttons) and prints the table clean. No dep.

## 6. Motion & color (the "onda", token-disciplined)

- **Activate categorical tokens**: replace the hardcoded `bg-sky-500/10 text-sky-600 dark:...` in the activity row with a `pillarTone()` helper mapping `entityType` → `bg-chart-N/12 text-chart-N` and `action` → `--success/--warning/--info/--destructive`. One helper, used in Timeline + Table + tabs. This is the single highest-leverage color-activation change and it's AA-safe (tokens are pre-verified).
- **Motion (CSS only, `tw-animate-css`, no JS lib)**: rows fade-in-up on first paint (staggered via `nth-child` delays); date-group headers get a subtle slide; the action badge on a `revoked`/`released` row gets a one-shot soft pulse to draw the eye. All wrapped in `motion-safe:` / a `prefers-reduced-motion` guard. **No framer-motion** — if anything needs JS-driven motion later, that's a flagged new-dep decision.
- **Depth**: the filter bar gets `shadow-xs` + sticky-on-scroll with `bg-background/95 backdrop-blur` (mirrors `BatchActionBar`), so the controls float over the scrolling log — the elevation language the audit said is missing.

## 7. Backend debt — precise hand-off (see backendDebt field for the contract)

Summarized: extend `GET /dashboard/activity` (or a new `GET /reports/activity`) with filter params aligned to ADR-0030's `Page<T>`; add `UserHistory` (+ optional `CategoryHistory`) sources to the `recent_activity` view; add an `actorId=me` / actor filter to power "My history"; add a server-side filtered CSV export. None of this blocks v1 — the screen is built so each param "lights up" a control that's disabled today.

## 8. Build order (frontend, ships without backend)

1. Add `/informes` route + nav section + `ClockIcon` (compose `PageHeader`, `Breadcrumb`).
2. `pillarTone()` + `actionTone()` token helpers (activates `--chart-*` / status tokens) — also retrofit `recent-activity-panel.tsx` to use them (kills the hardcoded sky/violet/amber).
3. Tabs (All/Assets/Access/Stock enabled; Users/My-history disabled-with-tooltip).
4. Filter bar (free-text + action + relative date, client-side v1) wired to URL params.
5. Timeline view (date grouping + action badges + avatars) and Table view (`ResourceTable`) behind a density toggle.
6. CSV export (visible rows) + print stylesheet.
7. Empty/loading/error states (upgraded `EmptyState`, reuse `ErrorState`).
8. Motion polish (`tw-animate-css`, `motion-safe`).

Each step is independently shippable and reuses locked primitives; nothing here hand-edits a `components/ui/*` primitive.

### Mockup

## Informes — desktop (Timeline view, "All" tab)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Dashboard › Informes                                                           │
│ Informes                                              [⤓ Export CSV] [🖶 Print]│
│ Every change across your estate — assets, access and stock, newest first.      │
├──────────────────────────────────────────────────────────────────────────────┤
│ ┌ All ──┐  Assets   Access   Stock   ⌁Users(soon)  ⌁My history(soon)          │
│ └━━━━━━━┘  (indigo underline = active; teal/amber per pillar on hover)         │
├──────────────────────────────────────────────────────────────────────────────┤
│ ⌕ Search events…        Action ▾[All]   When ▾[Last 30 days]   ⊞ Table ⊟ Time │
│ active: [Action: granted ✕]  [Last 30 days ✕]              Clear filters       │
├──────────────────────────────────────────────────────────────────────────────┤
│  TODAY                                                                          │
│  ●(teal) ⬢  Access granted to "Figma" for J. Pérez      [granted]   2h ago     │
│            (JP) Joaquín Minatel                                                 │
│  ●(amber)⬢  Stock out · 5× USB-C cables                 [stock_out] 3h ago     │
│            (AM) Ana Morales                                                     │
│  ●(indigo)⬢ Asset "LT-0421" → IN_MAINTENANCE            [status]    5h ago     │
│            System                                                               │
│                                                                                │
│  YESTERDAY                                                                      │
│  ●(rose) ⬢  Access revoked from "AWS Console" · R. Díaz  [revoked]  1d ago      │
│            (RD) Rocío Díaz                                                       │
│  ●(green)⬢  Asset "MON-118" assigned to T. Sosa          [assigned] 1d ago      │
│            (JP) Joaquín Minatel                                                 │
│                                                                                │
│  EARLIER THIS WEEK                                                              │
│  …                                                                             │
│                                   [ ↻ Load more ]                              │
└──────────────────────────────────────────────────────────────────────────────┘
   ● = pillar/action color dot (token --chart-N / --success/--warning/--destructive)
   ⬢ = pillar icon chip (Server/Key/Cube, heroicons 24/outline)
   [badge] = action StatusBadge (semantic status tokens — AA solid fills)
```

## Informes — Table view (audit density)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⌕ Search…   Action ▾[All]   When ▾[All]              ⊞ Table ⊟ Timeline        │
├───────────────┬───────────┬───────────────────┬─────────────┬─────────────────┤
│ When          │ Action    │ Entity            │ Actor       │ Summary         │
├───────────────┼───────────┼───────────────────┼─────────────┼─────────────────┤
│ 14:02 · today │ [granted] │ ⬢Key  Figma       │ (JP) J.M.   │ Granted to J.P. │
│ 11:40 · today │ [stock_o] │ ⬢Cube USB-C cable │ (AM) A.M.   │ -5 units        │
│ 09:15 · today │ [status]  │ ⬢Srv  LT-0421     │ System      │ → IN_MAINTENANCE│
│ yest. 17:30   │ [revoked] │ ⬢Key  AWS Console │ (RD) R.D.   │ Revoked · R.D.  │
├───────────────┴───────────┴───────────────────┴─────────────┴─────────────────┤
│ Showing 1–20 of 342                              [‹ Previous]   [Next ›]        │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Disabled tab / filter (honest "coming soon")

```
  ⌁ My history  (lock)   ⟵ tooltip: "Available once we record who-did-what
                                       across all sources (backend follow-up)."
  Actor ▾ [—]  (disabled)  ⟵ same tooltip
```

## Mobile (Timeline, stacked)

```
┌────────────────────────────┐
│ ‹ Informes          ⤓  🖶  │
│ [All][Assets][Access][Stock]│  ← scrollable tab strip
│ ⌕ Search events…           │
│ Action▾  When▾   ⊟ Timeline│
├────────────────────────────┤
│ TODAY                      │
│ ⬢ Access granted · Figma   │
│   [granted]  (JP) J.M. 2h  │
│ ⬢ Stock out · USB-C ×5     │
│   [stock_out](AM) A.M. 3h  │
├────────────────────────────┤
│        ↻ Load more         │
└────────────────────────────┘
```

## Empty state (delightful, token-tinted)

```
        ╭─────────────────╮
        │      ◷ (Clock)   │   ← ClockIcon, bg-muted circle,
        ╰─────────────────╯      fade-in-scale (tw-animate-css, motion-safe)
     No events match these filters.
   Try widening the date range or clearing the action filter.
              [ Clear filters ]
```

### Deuda de backend

NOT frontend-only — the rich vision needs backend work the CEO has accepted as DEBT. The v1 screen ships on the EXISTING contract (GET /dashboard/activity → Page<RecentActivityItem>, offset-paginated, ADR-0030) with client-side filtering of the loaded page; every control that needs a server param is built but disabled-with-tooltip until the debt lands. Precise hand-off spec:

== DEBT-1: Filterable activity endpoint (unblocks Assets/Access/Stock tabs as TRUE server filters, Action filter, date range, free-text) ==
Extend GET /dashboard/activity (preferred: keep one endpoint) OR add GET /reports/activity, accepting (all OPTIONAL, additive, backward-compatible):
  - entityType: "asset" | "application" | "consumable"  (reuses ActivityEntityTypeSchema)
  - entityId:   string  (all events for ONE entity across all 4 sources — the "all changes to one asset" ask)
  - actorId:    uuid | "me"  ("me" resolves to the Bearer JWT subject server-side; powers "My history")
  - action:     string  (validate against the known verb set: created/assigned/released/granted/revoked/stock_in/stock_out/stock_adjustment/status_changed/location_changed — reject unknown → 400, mirroring resolveSort's allowlist discipline)
  - from, to:   ISO-8601 date(time)  (closed-open range on occurredAt)
  - q:          string  (free-text over summary + actorName, trimmed, capped length)
Contract: stays a Page<RecentActivityItem> envelope ({items,total,limit,offset}); reuse PageQuerySchema for limit/offset; total reflects the FILTERED count. Implementation: the recent_activity Postgres VIEW (ADR-0043) is read with $queryRaw — add parameterized WHERE clauses (use $queryRaw parameter binding, NOT string interpolation — injection guard). actorId/entityType/action/date are all already columns on the view or trivially addable. NO schema change for these.
Sort: optionally honor sort=occurredAt&dir per ADR-0030 (default newest-first); allowlist = {occurredAt}.

== DEBT-2: User auditing (unblocks the "Users" tab — currently IMPOSSIBLE, users aren't audited) ==
There is NO UserHistory today. recent_activity merges AssetHistory/AssetAssignment/AccessGrant/ConsumableMovement only. Options for the CEO:
  (A) Add a UserHistory append-only model (mirrors AssetHistory: id autoincrement, userId, eventType enum {CREATED, UPDATED, ROLE_CHANGED, DELETED, RESTORED, PASSWORD_RESET_SENT}, payload Json?, performedById uuid? SetNull, createdAt; @@map user_history; ADR-0006 append-only) + emit on the user write paths + UNION it into the recent_activity view with entityType "user". Cleanest, scoped.
  (B) Generic AuditLog table (entityType, entityId, action, actorId, detail Json, createdAt) as a future-proof spine; bigger lift, touches every write path, needs its own ADR. NOT recommended for a 5–20-person tool unless the CEO wants org-wide audit.
Recommendation: (A) — scoped, mirrors the proven AssetHistory pattern, one new model + one view migration. Requires a NEW ADR (data-model + the recent_activity view contract change) — the recent-activity shared schema is contract-locked; widening ActivityEntityTypeSchema to include "user" is an ADR-gated change.

== DEBT-3: Category auditing (the "categories" ask) ==
AssetCategory / ArticleCategory have no history. Lowest priority (categories rarely change). Same choice as DEBT-2 (a CategoryHistory model or the generic AuditLog). Recommend DEFERRING until a concrete need — flag in the screen as not-yet-covered rather than building speculative auditing.

== DEBT-4: "My history" ==
Falls out of DEBT-1 (actorId="me"). No new model. Only needs the endpoint param + the JWT-subject resolution (actor is already set server-side from the Bearer token per ADR-0023/0038 — never trust a body-supplied actor).

== DEBT-5: Server-side filtered export ==
v1 exports only the loaded/filtered rows client-side (Blob CSV, no backend). A TRUE "export all matching the filter" needs GET /reports/activity/export?<same filters>&format=csv streaming the full filtered result (bypassing page limits). Lower priority; ships after DEBT-1.

SHARED-PACKAGE impact: DEBT-1 adds optional query fields to a recent-activity query schema in @lazyit/shared (additive). DEBT-2 widens ActivityEntityTypeSchema (BREAKING-ish for exhaustive switches in web — the ENTITY_META/ENTITY_TONE maps must gain a "user" case in the same change; this is the Page<T>-unwrap-style "don't merge the backend ahead of the consumer" trap noted in memory). All contract changes are ADR-gated (recent-activity schema is locked).

### Decisiones para el CEO
- ROUTE SLUG: /reports (English, matches the English-everywhere convention) with the visible label "Informes", OR /informes literally? Recommend /reports as slug + "Informes" as the display label.
- VISIBILITY: Is Informes for everyone who can read a pillar, or ADMIN-only? It reveals who-did-what across the estate. Recommend: visible to all internal users (5–20-person team, internal tool) — but it's a one-line gate change either way.
- USER AUDITING (DEBT-2): Approve a scoped UserHistory model (recommended) vs. a generic org-wide AuditLog spine vs. defer the "Users" tab entirely. This needs a NEW ADR and widens the contract-locked recent-activity schema — it's the biggest piece of the "history of everything" promise.
- CATEGORY AUDITING (DEBT-3): Build it now, or ship Informes without category history and revisit when there's real demand? Recommend defer — categories rarely change.
- SCOPE OF v1: Ship the honest v1 (All/Assets/Access/Stock tabs with client-side filtering on the loaded feed, relative date quick-ranges, CSV of visible rows, Users + My-history + Actor + date-range disabled-with-tooltip) FIRST, then land DEBT-1's filter endpoint to "light up" the disabled controls? Recommend yes — it's shippable in days and de-risks the backend work.
- DATE PICKER: v1 uses a relative-range Select (Today/7d/30d/All). A true calendar range picker needs a shadcn Calendar/date-picker primitive added via the CLI (in-bounds, small) + the server from/to params (DEBT-1). OK to defer the precise-range picker to the debt phase?
- COLOR ACTIVATION: Informes is the proposed proof-of-concept for activating --chart-1..5 / status tokens (replacing hardcoded sky/violet/amber, including retrofitting the dashboard's recent-activity-panel). Approve doing that retrofit as part of this work (one shared pillarTone()/actionTone() helper), or keep it scoped to Informes only?

---

