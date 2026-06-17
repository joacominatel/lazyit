"use client";

import { ChevronRightIcon } from "@heroicons/react/24/outline";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { usePathname } from "next/navigation";

import type { ManualCategory, ManualSubcategory } from "@/lib/manual/types";
import { cn } from "@/lib/utils";

/**
 * The Help sidebar's nested Category → Subcategory → page nav (ADR-0062 / issue #563). Driven by
 * frontmatter + the manifest: the `categories` prop is the same `getManualCategories()` tree the
 * `/help` index renders — categories in importance order, each with its ordered, NON-EMPTY
 * subcategories. The ACTIVE page (the current `/help/<slug>` route) is highlighted.
 *
 * Display LABELS live in i18n (`help.json`), not in the data — resolved here via `useTranslations`:
 * `categories.<key>` for a category, `subcategories.<category>.<subcategory>` for a subcategory.
 * Subcategories are collapsible via the native `<details>` element (zero deps, keyboard-accessible),
 * open by default so the importance-ordered tree is visible at a glance.
 *
 * Client Component because it needs `usePathname` for the active highlight (the layout that loads
 * `categories` server-side is a Server Component). Used in BOTH the desktop rail and the mobile sheet;
 * `onNavigate` lets the sheet close itself when a link is followed.
 */
export function HelpNav({
  categories,
  onNavigate,
}: {
  categories: ManualCategory[];
  onNavigate?: () => void;
}) {
  const t = useTranslations("help");
  const pathname = usePathname();

  if (categories.length === 0) {
    return (
      <p className="px-3 py-2 text-sm text-muted-foreground">{t("index.empty")}</p>
    );
  }

  return (
    <nav aria-label={t("nav.sidebarLabel")} className="flex flex-col gap-5">
      {categories.map((category) => (
        <div key={category.category} className="flex flex-col gap-1">
          <p className="px-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground/80">
            {t(`categories.${category.category}` as never)}
          </p>
          <div className="flex flex-col gap-0.5">
            {category.subcategories.map((subcategory) => (
              <SubcategoryGroup
                key={subcategory.subcategory}
                category={category.category}
                subcategory={subcategory}
                pathname={pathname}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

/**
 * One collapsible subcategory: a `<details>` whose `<summary>` is the localized subcategory label
 * and whose body is the page links. Open by default; forced open when it contains the active page so
 * a deep-linked route never lands inside a collapsed group.
 */
function SubcategoryGroup({
  category,
  subcategory,
  pathname,
  onNavigate,
}: {
  category: string;
  subcategory: ManualSubcategory;
  pathname: string;
  onNavigate?: () => void;
}) {
  const t = useTranslations("help");
  const hasActive = subcategory.pages.some(
    (page) => pathname === `/help/${page.slug}`,
  );

  return (
    <details open={hasActive || undefined} className="group/sub">
      <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1.5 rounded-md px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 transition-transform group-open/sub:rotate-90"
        />
        <span className="truncate">
          {t(`subcategories.${category}.${subcategory.subcategory}` as never)}
        </span>
      </summary>
      <ul className="mt-0.5 flex flex-col gap-0.5 pl-5">
        {subcategory.pages.map((page) => {
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
    </details>
  );
}
