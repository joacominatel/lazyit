"use client";

import { GlobeAltIcon } from "@heroicons/react/24/outline";
import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setLocale } from "@/i18n/actions";
import { type Locale, localeLabels, locales } from "@/i18n/config";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Topbar locale switcher (ADR-0051). A nested sub-menu inside the user menu: a Globe
 * row that opens an EN / ES radio list. Picking a locale writes the `NEXT_LOCALE`
 * cookie via the `setLocale` server action, then `router.refresh()` re-renders the
 * Server Components (and the catalog) under the new locale — cookie-mode means no URL
 * change.
 *
 * Activated Restraint: leans entirely on the shared dropdown primitives and tokens —
 * no coloured text, no custom chrome. The active locale reads as the checked radio
 * dot (the primitive's own affordance), not colour. The Globe is the one icon, in the
 * standard 24/outline weight (ADR-0045).
 */
export function LocaleSwitcher() {
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
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <GlobeAltIcon className="size-4 text-muted-foreground" />
        {localeLabels[activeLocale as Locale] ?? activeLocale}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup
          value={activeLocale}
          onValueChange={onSelect}
        >
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
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
