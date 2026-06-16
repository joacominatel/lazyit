---
title: "ADR-0051: i18n with next-intl (cookie-mode, en + es)"
tags: [adr, web, frontend, i18n, next-intl]
status: accepted
created: 2026-06-04
updated: 2026-06-04
deciders: [Joaquín Minatel]
---

# ADR-0051: i18n with next-intl (cookie-mode, en + es)

## Status

accepted — 2026-06-04. CEO-approved (i18n was deferred in [[0049-activated-restraint-ux-direction]]
as "its own future ADR" — this is it). Web-only; no API or contract change. Phase 0 (this ADR's
foundation) shipped under epic #157 / issue #192 — the **plumbing + conventions** only. The
per-section string extraction is a follow-up fan-out, not part of this ADR.

## Context

`apps/web` ships with ~300–500 hardcoded English strings across the pages, forms, tables, nav,
dialogs and empty-states. lazyit is sold as a self-hosted product for small IT teams, and the
first non-English audience is Spanish-speaking. We need an internationalization layer that:

- works with the **Next.js 16 App Router + React 19** stack ([[0010-nextjs-frontend]]) and both
  Server Components and Client Components;
- lets a user switch language **in-app** and persist the choice;
- does **not** restructure routing (no `/es/...` prefix) — the app is a single-org internal
  tool, not a public multi-region site, and a URL-prefix scheme would touch every `<Link>`,
  the middleware, the breadcrumb and the auth redirects for no real benefit;
- is **type-safe**, ICU-capable (plurals/interpolation), and small enough for a small team to
  own;
- can be rolled out **incrementally** — Phase 0 lays the foundation and wires one real slice of
  the chrome (the sidebar nav) as a worked example, then a fan-out of per-section agents
  extracts the rest mechanically.

## Considered options

1. **next-intl, cookie-mode (no i18n routing)** *(chosen.)* The de-facto i18n library for the
   App Router. First-class Server Component support (`getTranslations`), a `useTranslations`
   hook for Client Components, ICU message syntax, type-safety, and a documented **no-routing**
   setup where the active locale is read from a cookie in `getRequestConfig`. Cookie-mode means
   zero route changes: every existing `<Link>`, the middleware and the auth flow are untouched.
2. **next-intl with i18n routing (`/en`, `/es` prefixes).** The library's headline feature, but
   it forces a `[locale]` segment, locale-aware navigation wrappers, middleware locale
   negotiation and a redirect dance with the existing Auth.js middleware. All cost, no payoff
   for a single-org internal app. Rejected.
3. **react-i18next / i18next.** Mature and framework-agnostic, but App-Router/RSC integration is
   bolt-on (no native Server Component story), and it carries more configuration surface.
   Rejected: next-intl is the App-Router-native choice.
4. **Hand-rolled context + JSON dictionaries.** Minimal deps, but we'd reimplement ICU plurals,
   interpolation, type-safety and the RSC/Client split by hand. Rejected: re-inventing a solved
   problem.

## Decision

Adopt **next-intl 4.x in cookie-mode** for `apps/web`. **English (`en`) is the default and
fallback; Spanish (`es`) is the second locale.** The active locale lives in the `NEXT_LOCALE`
cookie (next-intl's documented convention) — there is no URL prefix and no route restructure.

### Plumbing (Phase 0)

- **Plugin wrap** — `apps/web/next.config.ts` is wrapped with `createNextIntlPlugin()`, which
  points at the default request-config path `./i18n/request.ts`.
- **Locale config** — `apps/web/i18n/config.ts` is the single source of truth: `locales`
  (`['en','es']`), `defaultLocale` (`'en'`), the `LOCALE_COOKIE` name (`NEXT_LOCALE`), the
  `localeLabels`, and an `isLocale()` narrowing guard. Framework-agnostic (no `next/*` imports)
  so it is shared by the request config, the server action and the switcher.
- **Request config** — `apps/web/i18n/request.ts` (`getRequestConfig`) reads `NEXT_LOCALE` from
  `cookies()`, falls back to `'en'` for a missing/unknown value, and lazy-imports
  `messages/<locale>.json` as the catalog.
- **Provider** — `app/providers.tsx` wraps the tree in `NextIntlClientProvider locale={…}
  messages={…}`; the **root layout** (`app/layout.tsx`, now `async`) resolves them via
  `getLocale()` / `getMessages()` and also sets `<html lang={locale}>`.
- **Server action** — `apps/web/i18n/actions.ts` exports `setLocale(locale)`, which writes the
  `NEXT_LOCALE` cookie (1-year, `lax`, `path:/`, not `httpOnly` — a non-sensitive UI
  preference). The caller `router.refresh()`es so the Server Components re-render under the new
  locale. **Cookie-mode side effect:** reading `cookies()` opts routes out of static rendering;
  every app route is dynamic (`ƒ`), which is acceptable for an authenticated internal app whose
  pages were already dynamic (auth/session) anyway.
- **Switcher** — `components/locale-switcher.tsx`, a Globe (`GlobeAltIcon`, 24/outline —
  [[0045-icon-library-heroicons]]) sub-menu inside the topbar user menu, EN / ES as a radio
  group. **Activated Restraint** ([[0049-activated-restraint-ux-direction]]): it composes the
  existing dropdown primitives and tokens only — no coloured text, no custom chrome; the active
  locale reads as the radio's own checked dot, not colour.
- **Catalogs** — `apps/web/messages/en.json` + `messages/es.json`, **namespaced by area**. Phase
  0 seeds `common` (Save/Cancel/Delete/… ) and `nav` (the sidebar labels) **fully in en + es**,
  and ships empty `{}` placeholders for the section namespaces (`dashboard`, `assets`,
  `applications`, `consumables`, `kb`, `users`, `locations`, `settings`, `reports`, `auth`).
- **Worked example** — `components/sidebar-nav.tsx` is wired through `useTranslations('nav')`
  (labels and section headings), proving the plumbing end-to-end.

### Conventions (binding on the section fan-out)

The full, mechanical convention for the per-section agents lives in
[[i18n|docs/04-development/i18n.md]]. The load-bearing rules:

- **Namespace scheme:** `<area>.<subarea>.<key>` — top-level namespace per product area
  (matching the catalog placeholders), camelCase keys.
- **Client vs server:** `useTranslations('<area>')` in Client Components; `await
  getTranslations('<area>')` in Server Components / Server Actions.
- **Parity rule:** every key in `en.json` MUST exist in `es.json` (and vice-versa). `en` is the
  fallback; a missing `es` key surfaces the `en` string but is a defect.
- **ICU:** plurals and interpolation use next-intl's ICU syntax (`{count, plural, …}`,
  `{name}`), not string concatenation.
- **Do not translate** identifiers, enum values, route paths, API field names, user-entered
  data, emails, or any value that is data rather than UI copy.

## Consequences

- **Positive:** i18n works for the chrome (nav + common) in en + es immediately; the foundation
  is laid for a mechanical per-section extraction. No route restructure, no `<Link>` churn, no
  middleware change. `bunx tsc` and `bun run build` (web) are green. Type-safe + ICU out of the
  box.
- **New dependency:** `next-intl` (CEO-approved) is added to `apps/web/package.json` + the
  lockfile.
- **Cookie-mode trade-off:** routes are dynamic (no static prerender), and the language is **not**
  reflected in the URL (not shareable/bookmarkable per-locale) — an accepted trade for an
  authenticated internal tool. If we ever need per-locale URLs or static rendering, migrating to
  i18n routing is a follow-up ADR.
- **Deferred (out of Phase 0):** extracting the ~300–500 existing hardcoded strings — the
  per-section fan-out. The placeholder namespaces and the [[i18n]] convention doc exist precisely
  so that work is mechanical.
- **Known debt:** until the fan-out lands, most of the UI is still hardcoded English; only `nav`
  + `common` are translated. The section namespaces are empty placeholders.

## References

- [[0010-nextjs-frontend]] (Next.js App Router + React 19, the stack this targets).
- [[0049-activated-restraint-ux-direction]] (the UX direction the switcher obeys; it named i18n
  as a future ADR — this is it) · [[0045-icon-library-heroicons]] (heroicons-only, the Globe
  weight) · [[0011-tailwind-styling]].
- Convention for the section fan-out: [[i18n|docs/04-development/i18n.md]].
- next-intl docs: <https://next-intl.dev/docs/getting-started/app-router> (cookie-based locale,
  no i18n routing).
