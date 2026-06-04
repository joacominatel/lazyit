"use client";

import { MoonIcon, SunIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";

/**
 * Minimal light/dark switch.
 *
 * First visit follows the OS (defaultTheme="system" + enableSystem in Providers);
 * clicking sets an explicit choice that next-themes persists in localStorage.
 * Icon visibility is driven purely by the `.dark` class on <html>, so there is no
 * hydration flash and no need for a mounted guard.
 */
export function ThemeToggle() {
  const t = useTranslations("shared");
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={t("chrome.toggleTheme")}
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <SunIcon className="size-5 dark:hidden" />
      <MoonIcon className="hidden size-5 dark:block" />
    </Button>
  );
}
