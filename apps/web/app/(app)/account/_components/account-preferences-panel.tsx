"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useSyncExternalStore, useTransition } from "react";
import { DetailPanel } from "@/components/detail-panel";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { setLocale } from "@/i18n/actions";
import { isLocale, localeLabels, locales } from "@/i18n/config";
import { THEME_CHOICES, toThemeChoice } from "../_lib/account-sections";

function subscribe(): () => void {
  return () => {};
}

/** True after hydration — next-themes only knows the stored theme on the client. */
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

/**
 * The hub's "Preferences" panel (issue #1404): the two per-user display preferences lazyit already
 * has, surfaced in one place. Both are client-side and change no server state:
 *
 * - **Language** — the `NEXT_LOCALE` cookie via the existing `setLocale` action + `router.refresh()`,
 *   the same path as the user-menu switcher (ADR-0051).
 * - **Theme** — next-themes' stored choice (light / dark / follow the system), the same store the topbar
 *   toggle writes. Rendered only after hydration, as next-themes documents, to avoid a mismatch.
 */
export function AccountPreferencesPanel() {
  const t = useTranslations("account.hub.preferences");
  const locale = useLocale();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const { theme, setTheme } = useTheme();
  const hydrated = useHydrated();

  function onLocaleChange(value: string) {
    if (!isLocale(value) || value === locale) return;
    startTransition(async () => {
      await setLocale(value);
      router.refresh();
    });
  }

  return (
    <DetailPanel title={t("title")}>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="account-language">{t("language.label")}</Label>
          <Select
            value={locale}
            onValueChange={onLocaleChange}
            disabled={isPending}
          >
            <SelectTrigger id="account-language" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {locales.map((l) => (
                <SelectItem key={l} value={l}>
                  {localeLabels[l]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {t("language.description")}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="account-theme">{t("theme.label")}</Label>
          {hydrated ? (
            <Select value={toThemeChoice(theme)} onValueChange={setTheme}>
              <SelectTrigger id="account-theme" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {THEME_CHOICES.map((choice) => (
                  <SelectItem key={choice} value={choice}>
                    {t(`theme.${choice}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Skeleton className="h-9 w-full" />
          )}
          <p className="text-xs text-muted-foreground">
            {t("theme.description")}
          </p>
        </div>
      </div>
    </DetailPanel>
  );
}
