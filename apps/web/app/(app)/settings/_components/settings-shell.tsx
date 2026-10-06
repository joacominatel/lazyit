"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useMyPermissions } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";
import {
  activeSettingsHref,
  SETTINGS_NAV,
  type SettingsNavGroup,
  visibleSettingsNav,
} from "../_lib/settings-nav";

/** The hub, which IS the overview of every destination — it does not repeat them in a side nav. */
const HUB_HREF = "/settings";

/**
 * The Settings frame (#1533): a persistent side nav grouped by task on `lg`+, a compact page picker
 * above the content below that. Wraps every page under `/settings` except the hub.
 *
 * Gated on `settings:manage`, the same gate as each page's `AdminGate` — and fail-closed: while the
 * permission set loads, or for a caller without it, no nav renders and the page's own gate explains
 * itself. Item-level grants (Bulk import → `import:run`) filter exactly as the hub cards do.
 *
 * No On/Off badges in the nav, deliberately: the states live in five different reads, and fetching
 * them here would add those requests to every settings page. Each page shows its own state.
 */
export function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { can, isLoading } = useMyPermissions();

  // One stable tree whether or not the nav shows, so the page below never remounts when the
  // permission set arrives (each conditional sibling keeps its slot even while it renders nothing).
  const showNav = pathname !== HUB_HREF && !isLoading && can("settings:manage");
  const groups = showNav ? visibleSettingsNav(SETTINGS_NAV, can) : [];
  const active = showNav ? activeSettingsHref(pathname, groups) : null;

  return (
    <div
      className={cn(
        showNav &&
          "space-y-6 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start lg:gap-8 lg:space-y-0",
      )}
    >
      {showNav && <SettingsSideNav groups={groups} active={active} />}
      {showNav && <SettingsPagePicker groups={groups} active={active} />}
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function SettingsSideNav({
  groups,
  active,
}: {
  groups: SettingsNavGroup[];
  active: string | null;
}) {
  const t = useTranslations("settings.nav");
  return (
    <nav
      aria-label={t("label")}
      className="sticky top-4 hidden space-y-5 lg:block"
    >
      <Link
        href={HUB_HREF}
        className="block rounded-md px-2 text-sm font-semibold outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("overview")}
      </Link>
      {groups.map((group) => (
        <div key={group.key} className="space-y-0.5">
          <p className="px-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
            {t(`groups.${group.key}`)}
          </p>
          <ul className="space-y-px">
            {group.items.map((item) => {
              const current = item.href === active;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={current ? "page" : undefined}
                    className={cn(
                      "block rounded-md px-2 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                      current
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                    )}
                  >
                    {t(`items.${item.key}`)}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Below `lg`: one grouped picker instead of a column the width of the screen. */
function SettingsPagePicker({
  groups,
  active,
}: {
  groups: SettingsNavGroup[];
  active: string | null;
}) {
  const t = useTranslations("settings.nav");
  const router = useRouter();
  return (
    <div className="lg:hidden">
      <Select
        value={active ?? undefined}
        onValueChange={(href) => router.push(href)}
      >
        <SelectTrigger aria-label={t("label")} className="w-full sm:w-72">
          <SelectValue placeholder={t("overview")} />
        </SelectTrigger>
        <SelectContent>
          {groups.map((group) => (
            <SelectGroup key={group.key}>
              <SelectLabel>{t(`groups.${group.key}`)}</SelectLabel>
              {group.items.map((item) => (
                <SelectItem key={item.href} value={item.href}>
                  {t(`items.${item.key}`)}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
