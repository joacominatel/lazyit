"use server";

import { cookies } from "next/headers";
import { isLocale, type Locale, LOCALE_COOKIE } from "./config";

/**
 * Persist the chosen locale in the `NEXT_LOCALE` cookie (ADR-0051). Cookie-mode
 * means the next render reads this cookie in `i18n/request.ts` and serves the
 * matching catalog — there is no URL change.
 *
 * The caller (the topbar switcher) should `router.refresh()` after this resolves so
 * the Server Components re-render under the new locale. Unknown values are ignored
 * (fail-safe: we never write an unsupported locale).
 *
 * 1-year cookie; `lax` sameSite (a normal first-party preference cookie); `path: /`
 * so it applies app-wide. Not `httpOnly` — this is a non-sensitive UI preference and
 * keeping it readable lets us hydrate the initial `<html lang>` without a round-trip
 * if we ever need to.
 */
export async function setLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale)) return;

  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    path: "/",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
}
