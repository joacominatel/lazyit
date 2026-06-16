"use client";

import { GlobeAltIcon } from "@heroicons/react/24/outline";
import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { setLocale } from "@/i18n/actions";
import { type Locale, localeLabels, locales } from "@/i18n/config";

/**
 * Public locale switcher for the `(marketing)` chrome (ADR-0062 + ADR-0051). The existing
 * `LocaleSwitcher` is a NESTED sub-menu meant to live inside the authenticated user menu; the
 * public header has no such menu, so this is a thin SELF-CONTAINED variant: a Globe ghost button
 * (matching `ThemeToggle`) that opens an EN / ES radio list.
 *
 * It reuses the exact same mechanism as the app switcher — write the `NEXT_LOCALE` cookie via the
 * `setLocale` server action, then `router.refresh()` to re-render the Server Components (and the
 * catalog) under the new locale. Cookie-mode means no URL change (no `/es/` prefix — ADR-0051).
 * Labels come from `localeLabels`, never hardcoded.
 */
export function PublicLocaleSwitcher() {
  const t = useTranslations("shared");
  const activeLocale = useLocale();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onSelect(value: string) {
    const locale = value as Locale;
    if (locale === activeLocale) return;
    startTransition(async () => {
      await setLocale(locale);
      router.refresh();
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("chrome.changeLanguage")}
        >
          <GlobeAltIcon className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup value={activeLocale} onValueChange={onSelect}>
          {locales.map((locale) => (
            <DropdownMenuRadioItem
              key={locale}
              value={locale}
              disabled={isPending}
            >
              {localeLabels[locale]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
