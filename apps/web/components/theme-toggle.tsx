"use client";

import { MoonIcon, SunIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { useSavePreference } from "@/lib/api/hooks/use-account-preferences";
import { themePreferencePatch } from "@/lib/preferences/preference-sync";

/**
 * Minimal light/dark switch.
 *
 * First visit follows the OS (defaultTheme="system" + enableSystem in Providers);
 * clicking sets an explicit choice that next-themes persists in localStorage.
 * Icon visibility is driven purely by the `.dark` class on <html>, so there is no
 * hydration flash and no need for a mounted guard. A click is also saved to the signed-in user's
 * account (issue #1422, fire-and-forget) so it follows them to a browser with no choice of its own.
 */
export function ThemeToggle() {
  const t = useTranslations("shared");
  const { resolvedTheme, setTheme } = useTheme();
  const savePreference = useSavePreference();

  function toggle() {
    const next = resolvedTheme === "dark" ? "light" : "dark";
    setTheme(next);
    savePreference(themePreferencePatch(next));
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t("chrome.toggleTheme")}
      onClick={toggle}
    >
      <SunIcon className="size-5 dark:hidden" />
      <MoonIcon className="hidden size-5 dark:block" />
    </Button>
  );
}
