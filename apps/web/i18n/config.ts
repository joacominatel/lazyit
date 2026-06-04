/**
 * i18n single source of truth (ADR-0051).
 *
 * Cookie-mode locale selection — no `/es/` URL prefix, no i18n routing. The active
 * locale is carried in the `NEXT_LOCALE` cookie and read per-request in
 * `i18n/request.ts`. Keep this file framework-agnostic (no `next/*` imports) so it
 * can be shared by the request config, the server action and the switcher UI.
 */

/** The locales lazyit ships. English is the default/fallback (`en` first). */
export const locales = ["en", "es"] as const;

export type Locale = (typeof locales)[number];

/** Fallback when the cookie is missing or holds an unknown value. */
export const defaultLocale: Locale = "en";

/**
 * Cookie that carries the active locale. `NEXT_LOCALE` is next-intl's documented
 * convention and what its examples read by default — keeping the name aligned avoids
 * surprises if we ever adopt i18n routing later.
 */
export const LOCALE_COOKIE = "NEXT_LOCALE";

/** Human-readable label for each locale (used by the switcher). */
export const localeLabels: Record<Locale, string> = {
  en: "English",
  es: "Español",
};

/** Narrow an untrusted string (cookie value, form input) to a supported `Locale`. */
export function isLocale(value: string | undefined | null): value is Locale {
  return value != null && (locales as readonly string[]).includes(value);
}
