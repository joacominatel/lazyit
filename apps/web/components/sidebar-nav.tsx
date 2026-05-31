"use client";

import {
  BookOpenIcon,
  CubeIcon,
  KeyIcon,
  MapPinIcon,
  ServerStackIcon,
  Squares2X2Icon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// App navigation across the three pillars (Inventory / Access / Knowledge) plus
// the supporting Users + Locations registries. Every target is an implemented
// route; dead links (Tickets, Settings) were removed — see ADR-0016, no ticketing.
const NAV = [
  { label: "Dashboard", href: "/dashboard", icon: Squares2X2Icon },
  { label: "Assets", href: "/assets", icon: ServerStackIcon },
  { label: "Knowledge Base", href: "/kb", icon: BookOpenIcon },
  { label: "Access", href: "/applications", icon: KeyIcon },
  { label: "Consumables", href: "/consumables", icon: CubeIcon },
  { label: "Users", href: "/users", icon: UsersIcon },
  { label: "Locations", href: "/locations", icon: MapPinIcon },
] as const;

export function SidebarNav() {
  const pathname = usePathname();

  return (
    <nav className="flex-1 space-y-0.5 p-2">
      {NAV.map(({ label, href, icon: Icon }) => {
        // Active for the exact route and any nested route (e.g. /locations/:id).
        const active = pathname === href || pathname.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              // min-h-11 gives a ~44px tap target on touch; md:min-h-9 restores
              // desktop density on the always-visible rail.
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
    </nav>
  );
}
