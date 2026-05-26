"use client";

import {
  BookOpenIcon,
  Cog6ToothIcon,
  KeyIcon,
  MapPinIcon,
  ServerStackIcon,
  Squares2X2Icon,
  TicketIcon,
  UsersIcon,
} from "@heroicons/react/24/outline";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// App navigation. Most targets are placeholders until each domain area is built
// out; /dashboard and /locations are implemented.
const NAV = [
  { label: "Dashboard", href: "/dashboard", icon: Squares2X2Icon },
  { label: "Assets", href: "/assets", icon: ServerStackIcon },
  { label: "Tickets", href: "/tickets", icon: TicketIcon },
  { label: "Knowledge Base", href: "/kb", icon: BookOpenIcon },
  { label: "Access", href: "/applications", icon: KeyIcon },
  { label: "Users", href: "/users", icon: UsersIcon },
  { label: "Locations", href: "/locations", icon: MapPinIcon },
  { label: "Settings", href: "/settings", icon: Cog6ToothIcon },
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
              "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
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
