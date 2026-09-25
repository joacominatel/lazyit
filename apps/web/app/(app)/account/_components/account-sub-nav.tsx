"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAiStatus } from "@/lib/api/hooks/use-ai-status";
import { useCan } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";
import { accountSections, activeAccountSection } from "../_lib/account-sections";

/**
 * The account area's sub-navigation (issue #1404): one link per existing per-user page — Overview
 * (`/account`), My profile (`/profile`), Notification emails, and AI & connected apps (only for holders
 * of `ai:connect` on an API that has the assistant, the same rule as the user menu). Rendered by
 * `account/layout.tsx` for every `/account/*` page and by the profile view, so all of them share it.
 *
 * Real links (middle/modifier-click behave); the current page carries `aria-current="page"`. On a
 * narrow screen the strip scrolls horizontally inside itself instead of the page.
 */
export function AccountSubNav({ className }: { className?: string }) {
  const t = useTranslations("account.nav");
  const pathname = usePathname();
  const canConnectAi = useCan("ai:connect");
  const aiStatus = useAiStatus();
  const sections = accountSections({
    canConnectAi,
    aiStatusAvailable: aiStatus.isSuccess,
  });
  const active = activeAccountSection(pathname, sections);

  return (
    <nav aria-label={t("label")} className={cn("border-b", className)}>
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {sections.map((section) => {
          const isActive = section.key === active;
          return (
            <li key={section.key} className="shrink-0">
              <Link
                href={section.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t(section.key)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
