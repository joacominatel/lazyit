"use client";

import {
  BookOpenIcon,
  Cog6ToothIcon,
  CubeIcon,
  KeyIcon,
  MapPinIcon,
  ServerStackIcon,
  Squares2X2Icon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePermissions } from "@/lib/hooks/use-permissions";
import { cn } from "@/lib/utils";

type NavItem = {
  label: string;
  href: string;
  icon: typeof Squares2X2Icon;
  /** Render only for ADMINs (the API still gates the routes server-side). */
  adminOnly?: boolean;
};

type NavSection = {
  /** Section heading, or null for the ungrouped top item (Dashboard). */
  heading: string | null;
  items: NavItem[];
};

/**
 * Navigation grouped into the product's three pillars plus a demoted "Manage"
 * section, instead of a flat 7-item list (which contradicted the three-pillars
 * mental model and split Assets from Consumables).
 *
 *   Inventory → Assets, Consumables   (reunited)
 *   Access    → Applications          (the route stays /applications; the
 *                                      section name "Access" is the pillar — this
 *                                      resolves the Access-vs-Applications split:
 *                                      the *thing* is an Application, the *pillar*
 *                                      is Access)
 *   Knowledge → Knowledge Base
 *   Manage    → Users, Locations, Settings (supporting registries + admin)
 *
 * Every target is an implemented route; dead links (Tickets) stay out per ADR-0016
 * (no ticketing). "Settings" is the ADMIN-only home for instance config, taxonomy
 * management and the role overview — hidden for non-admins (the API also gates it).
 */
const NAV: NavSection[] = [
  {
    heading: null,
    items: [{ label: "Dashboard", href: "/dashboard", icon: Squares2X2Icon }],
  },
  {
    heading: "Inventory",
    items: [
      { label: "Assets", href: "/assets", icon: ServerStackIcon },
      { label: "Consumables", href: "/consumables", icon: CubeIcon },
    ],
  },
  {
    heading: "Access",
    items: [{ label: "Applications", href: "/applications", icon: KeyIcon }],
  },
  {
    heading: "Knowledge",
    items: [{ label: "Knowledge Base", href: "/kb", icon: BookOpenIcon }],
  },
  {
    heading: "Manage",
    items: [
      { label: "Users", href: "/users", icon: UsersIcon },
      { label: "Locations", href: "/locations", icon: MapPinIcon },
      { label: "Settings", href: "/settings", icon: Cog6ToothIcon, adminOnly: true },
    ],
  },
];

export function SidebarNav() {
  const pathname = usePathname();
  const { isAdmin } = usePermissions();

  return (
    <nav className="flex-1 space-y-4 p-2">
      {NAV.map((section, index) => {
        // Hide admin-only items for non-admins; drop a section that ends up empty.
        const items = section.items.filter((item) => !item.adminOnly || isAdmin);
        if (items.length === 0) return null;
        return (
        <div key={section.heading ?? `section-${index}`} className="space-y-0.5">
          {section.heading ? (
            <p className="px-3 pt-1 pb-1 text-xs font-medium tracking-wide text-muted-foreground/70 uppercase">
              {section.heading}
            </p>
          ) : null}
          {items.map(({ label, href, icon: Icon }) => {
            // Active for the exact route and any nested route (e.g. /assets/:id).
            const active = pathname === href || pathname.startsWith(`${href}/`);
            return (
              <Link
                key={href}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  // min-h-11 gives a ~44px tap target on touch; md:min-h-9
                  // restores desktop density on the always-visible rail.
                  "flex min-h-11 items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors md:min-h-9",
                  active
                    ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                    : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                )}
              >
                <Icon className="size-5" />
                {label}
              </Link>
            );
          })}
        </div>
        );
      })}
    </nav>
  );
}
