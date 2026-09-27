import type {
  ThemePreference,
  UpdateUserPreferences,
  UserPreferences,
} from "@lazyit/shared";
import { isLocale, LOCALE_COOKIE, type Locale } from "@/i18n/config";

/**
 * Per-user language and theme (issue #1422) — the pure rules, so the "which value wins" decision is
 * unit-tested without a browser.
 *
 * CEO rule "El del navegador": the BROWSER's own value always wins. The locale lives in the
 * `NEXT_LOCALE` cookie (ADR-0051) and the theme in next-themes' `localStorage` key. The value stored on
 * the user (`GET /users/me` `locale` / `theme`) is applied ONLY in a browser that has no value of its
 * own — typically the first sign-in on a new device. Changing either one in the UI keeps writing the
 * browser value and also saves it to the user, so it follows them to their next new browser.
 */

/** next-themes' default `storageKey` (the provider in `app/providers.tsx` does not override it). */
export const THEME_STORAGE_KEY = "theme";

const THEMES: readonly ThemePreference[] = ["light", "dark", "system"];

/** Narrow an untrusted string (localStorage, a picker value) to a theme the API accepts. */
export function isThemePreference(
  value: string | null | undefined,
): value is ThemePreference {
  return value != null && (THEMES as readonly string[]).includes(value);
}

/**
 * The `NEXT_LOCALE` value in a `document.cookie` string, or null when the browser has none. An
 * unsupported value counts as none: the server already ignores it and serves the default.
 */
export function readLocaleCookie(cookieString: string): Locale | null {
  for (const part of cookieString.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== LOCALE_COOKIE) continue;
    let value = part.slice(eq + 1).trim();
    try {
      value = decodeURIComponent(value);
    } catch {
      // A malformed escape is just an unusable value.
    }
    return isLocale(value) ? value : null;
  }
  return null;
}

/** What this browser holds on its own. `null` = no preference of its own. */
export interface BrowserPreferences {
  locale: Locale | null;
  theme: ThemePreference | null;
}

/** What to apply to this browser from the user's stored preferences. Absent key = leave it alone. */
export interface PreferenceAdoption {
  locale?: Locale;
  theme?: ThemePreference;
}

/**
 * Which stored values this browser should adopt. A key is adopted only when the browser has no value
 * of its own AND the user has a valid stored one. The locale is also skipped when it is already the
 * one being rendered (the default), since adopting it would change nothing on screen.
 */
export function resolveAdoption(input: {
  browser: BrowserPreferences;
  stored: Partial<UserPreferences> | null | undefined;
  activeLocale: string;
}): PreferenceAdoption {
  const { browser, stored, activeLocale } = input;
  const adoption: PreferenceAdoption = {};
  const storedLocale = stored?.locale;
  if (
    browser.locale === null &&
    isLocale(storedLocale) &&
    storedLocale !== activeLocale
  ) {
    adoption.locale = storedLocale;
  }
  const storedTheme = stored?.theme;
  if (browser.theme === null && isThemePreference(storedTheme)) {
    adoption.theme = storedTheme;
  }
  return adoption;
}

/** The `PUT /account/preferences` body for a language change, or null for an unsupported value. */
export function localePreferencePatch(
  value: string,
): UpdateUserPreferences | null {
  return isLocale(value) ? { locale: value } : null;
}

/** The `PUT /account/preferences` body for a theme change, or null for an unsupported value. */
export function themePreferencePatch(
  value: string | null | undefined,
): UpdateUserPreferences | null {
  return isThemePreference(value) ? { theme: value } : null;
}
