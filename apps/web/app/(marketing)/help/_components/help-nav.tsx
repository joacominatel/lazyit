"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";

import type { ManualSection } from "@/lib/manual/types";
import { cn } from "@/lib/utils";

/**
 * The Help sidebar's section→page link list (ADR-0062). Driven entirely by frontmatter: the
 * `sections` prop is the same `getManualSections()` index the `/help` page renders, grouped by
 * `section` and sorted by `order`. The ACTIVE page (the current `/help/<slug>` route) is highlighted.
 *
 * Client Component because it needs `usePathname` for the active highlight (the layout that loads
 * `sections` server-side is a Server Component). Used in BOTH the desktop rail and the mobile sheet;
 * `onNavigate` lets the sheet close itself when a link is followed.
 */
export function HelpNav({
  sections,
  onNavigate,
}: {
  sections: ManualSection[];
  onNavigate?: () => void;
}) {
  const t = useTranslations("help");
  const pathname = usePathname();

  if (sections.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-muted-foreground">{t("index.empty")}</p>
    );
  }

  return (
    <nav aria-label={t("nav.sidebarLabel")} className="flex flex-col gap-5">
      {sections.map((section) => (
        <div key={section.section} className="flex flex-col gap-1">
          <p className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">
            {section.section}
          </p>
          <ul className="flex flex-col gap-0.5">
            {section.pages.map((page) => {
              const href = `/help/${page.slug}`;
              const active = pathname === href;
              return (
                <li key={page.slug}>
                  <Link
                    href={href}
                    aria-current={active ? "page" : undefined}
                    onClick={onNavigate}
                    className={cn(
                      "flex min-h-9 items-center rounded-md px-3 py-1.5 text-sm transition-colors",
                      active
                        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                        : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <span className="truncate">{page.frontmatter.title}</span>
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
