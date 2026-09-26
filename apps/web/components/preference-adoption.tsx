"use client";

import { useLocale } from "next-intl";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { setLocale } from "@/i18n/actions";
import { useCurrentUser } from "@/lib/api/hooks/use-users";
import {
  isThemePreference,
  readLocaleCookie,
  resolveAdoption,
  THEME_STORAGE_KEY,
} from "@/lib/preferences/preference-sync";

/** next-themes' stored choice in this browser, or null when it has none (or storage is blocked). */
function readStoredTheme() {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemePreference(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Applies the signed-in user's saved language and theme (issue #1422) to a browser that has NO value
 * of its own — typically the first sign-in on a new device. Renders nothing.
 *
 * CEO rule "El del navegador": the browser's own value always wins, so a key is adopted only while the
 * `NEXT_LOCALE` cookie / next-themes' `localStorage` entry is absent (`resolveAdoption`). Adopting writes
 * that browser value (the cookie via the existing `setLocale` action, the theme via `setTheme`), so from
 * then on this browser has its own value and this becomes a no-op. The saved values come from the
 * already-warm `GET /users/me`; an API without the fields leaves both undefined and nothing happens.
 *
 * Mounted once, inside the topbar `UserMenu`, because the app shell layout is a shared-critical file.
 * Runs at most once per mount.
 */
export function PreferenceAdoption() {
  const { data: me } = useCurrentUser();
  const activeLocale = useLocale();
  const { setTheme } = useTheme();
  const router = useRouter();
  const done = useRef(false);

  useEffect(() => {
    if (done.current || !me) return;
    done.current = true;

    const adoption = resolveAdoption({
      browser: {
        locale: readLocaleCookie(document.cookie),
        theme: readStoredTheme(),
      },
      stored: { locale: me.locale ?? null, theme: me.theme ?? null },
      activeLocale,
    });

    if (adoption.theme) setTheme(adoption.theme);
    if (adoption.locale) {
      const locale = adoption.locale;
      void setLocale(locale)
        .then(() => router.refresh())
        .catch(() => {
          // Best effort: the page stays in the current language.
        });
    }
  }, [me, activeLocale, setTheme, router]);

  return null;
}
