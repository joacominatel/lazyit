"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { cn } from "@/lib/utils";

/**
 * The tabs of the Purchases area (ADR-0099 §1): real links, the current one marked `aria-current`.
 * The *Pending units* tab (#1475) slots in between the two.
 */
const TABS = [
  { key: "purchases", href: "/purchases" },
  { key: "suppliers", href: "/purchases/suppliers" },
] as const;

export function PurchasesTabs({ active }: { active: (typeof TABS)[number]["key"] }) {
  const t = useTranslations("purchases.area");
  return (
    <nav aria-label={t("tabsLabel")} className="border-b">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {TABS.map((tab) => {
          const isActive = tab.key === active;
          return (
            <li key={tab.key} className="shrink-0">
              <Link
                href={tab.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "inline-flex h-10 items-center border-b-2 px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t(tab.key)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
